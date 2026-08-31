// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri_plugin_sql::{Migration, MigrationKind};

/// Local SQLite schema for the offline-first client data-collection feature.
///
/// Rationale for SQLite (via `tauri-plugin-sql`) over the key-value
/// `@tauri-apps/plugin-store` already used for the auth token: field agents
/// need to list/search/filter many client drafts offline and each client has
/// several nested one-to-many relations (referees, spouses) plus a 1:1
/// equity application — a relational store with real queries is a much
/// better fit than a JSON blob store for that shape of data.
///
/// Every "domain" table (clients, equity_applications) carries its own
/// sync bookkeeping columns (`server_id`, `sync_status`, `sync_error`,
/// `is_dirty`, `local_rev`) rather than relying solely on the outbox table,
/// so the UI can render per-record sync state with a single row read. The
/// `sync_outbox` table is the actual work queue the background sync engine
/// drains; see `src/lib/sync-engine.ts` on the TS side for how the two
/// interact (outbox rows are coalesced per entity rather than one row per
/// edit — the freshest DB row is re-read at send time).
///
/// All migrations are additive/idempotent (`CREATE TABLE IF NOT EXISTS`) and
/// versioned so `tauri-plugin-sql` only runs new ones on upgrade.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_offline_client_intake_schema",
        kind: MigrationKind::Up,
        sql: r#"
            -- A field officer's in-progress or synced client intake record.
            -- `local_id` (a client-generated UUID) is the stable identifier
            -- the rest of the local schema and the UI key off of; `server_id`
            -- is filled in once a create-sync succeeds and is what subsequent
            -- updates target.
            CREATE TABLE IF NOT EXISTS clients (
                local_id TEXT PRIMARY KEY,
                server_id INTEGER,
                sync_status TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | synced | failed
                sync_error TEXT,
                is_dirty INTEGER NOT NULL DEFAULT 1,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                local_rev INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,

                account_number TEXT,
                first_name TEXT NOT NULL DEFAULT '',
                middle_name TEXT,
                surname TEXT NOT NULL DEFAULT '',
                dob TEXT,
                sex TEXT,
                marital_status TEXT,
                nationality TEXT,
                state_id INTEGER,
                city_id INTEGER,
                residential_address TEXT,
                employer_name_address TEXT,
                phone_no TEXT NOT NULL DEFAULT '',
                email TEXT,
                means_of_identification TEXT,
                id_number TEXT,
                nin TEXT,
                bvn TEXT,
                account_category TEXT,
                purpose_of_account TEXT,
                applicant_signed_date TEXT
            );

            -- At most one row per client (enforced in application code, not a
            -- UNIQUE constraint, so a half-filled draft can still be saved).
            CREATE TABLE IF NOT EXISTS next_of_kin (
                local_id TEXT PRIMARY KEY,
                client_local_id TEXT NOT NULL REFERENCES clients(local_id) ON DELETE CASCADE,
                name TEXT,
                relationship TEXT,
                phone TEXT,
                dob TEXT,
                address TEXT,
                email TEXT,
                occupation TEXT,
                work_address TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_next_of_kin_client ON next_of_kin(client_local_id);

            CREATE TABLE IF NOT EXISTS spouses (
                local_id TEXT PRIMARY KEY,
                client_local_id TEXT NOT NULL REFERENCES clients(local_id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL DEFAULT 1,
                name TEXT,
                dob TEXT,
                relationship TEXT,
                address TEXT,
                phone TEXT,
                email TEXT,
                occupation TEXT,
                work_address TEXT,
                pin TEXT,
                pension_fund_administrator_id INTEGER,
                equity_contribution REAL
            );
            CREATE INDEX IF NOT EXISTS idx_spouses_client ON spouses(client_local_id);

            -- Exactly 2 required before a client can be marked ready-to-sync
            -- as a create; enforced in the TS validation layer, not here.
            CREATE TABLE IF NOT EXISTS referees (
                local_id TEXT PRIMARY KEY,
                client_local_id TEXT NOT NULL REFERENCES clients(local_id) ON DELETE CASCADE,
                referee_number INTEGER,
                referee_name TEXT,
                known_period TEXT,
                current_account_with TEXT,
                suitability_comment TEXT,
                bank_name_address TEXT,
                referee_account_number TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_referees_client ON referees(client_local_id);

            -- 1:1 with clients. Synced via PUT /client/{id}/equity-application
            -- which is keyed on the *client's* server id, so this can only be
            -- pushed once the parent client has a server_id.
            CREATE TABLE IF NOT EXISTS equity_applications (
                client_local_id TEXT PRIMARY KEY REFERENCES clients(local_id) ON DELETE CASCADE,
                server_id INTEGER,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                sync_error TEXT,
                is_dirty INTEGER NOT NULL DEFAULT 0,
                local_rev INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL,

                pension_fund_administrator_id INTEGER,
                pin TEXT,
                mortgage_lender_name TEXT,
                mortgage_lender_address TEXT,
                property_type TEXT,
                property_type_address TEXT,
                mortgage_offer_type TEXT,
                evidence_of_marriage INTEGER,
                equity_per_applicant REAL,
                mortgage_account_number TEXT,
                value_of_property REAL,
                amount_of_equity_payable REAL,
                is_owner_occupier INTEGER,
                occupation TEXT,
                date_employed TEXT,
                office_address TEXT,
                present_position TEXT,
                telephone_no TEXT,
                supplementary_mortgage_lender TEXT,
                purpose_of_loan TEXT,
                loan_amount REAL,
                repayment_period TEXT,
                monthly_salary_income REAL,
                source_of_loan_repayment TEXT,
                declaration_date TEXT
            );

            -- Rarely-changing reference data, cached for offline dropdowns and
            -- refreshed opportunistically when online (see lookups-repo.ts).
            CREATE TABLE IF NOT EXISTS lookup_states (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS lookup_cities (
                id INTEGER PRIMARY KEY,
                state_id INTEGER NOT NULL,
                name TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lookup_cities_state ON lookup_cities(state_id);
            CREATE TABLE IF NOT EXISTS lookup_pfas (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                code TEXT
            );

            -- Small key/value table for sync bookkeeping that isn't tied to a
            -- single record (e.g. "lookups last refreshed at").
            CREATE TABLE IF NOT EXISTS sync_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            -- The background sync engine's work queue. One row per
            -- (entity_type, entity_local_id) is kept "active" at a time —
            -- repeated local edits upsert/touch the existing row instead of
            -- piling up duplicates, and the payload is rebuilt from the
            -- current DB state at send time rather than trusted verbatim from
            -- enqueue time, so the latest local edits always win.
            CREATE TABLE IF NOT EXISTS sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL, -- 'client' | 'equity_application'
                entity_local_id TEXT NOT NULL,
                operation TEXT NOT NULL, -- 'create' | 'update' | 'delete'
                status TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | failed_permanent | done
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_payload TEXT,
                next_attempt_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(entity_type, entity_local_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox(status, next_attempt_at);
        "#,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:realtor.db", migrations())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
