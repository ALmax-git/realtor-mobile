/**
 * Local-first CRUD for clients and their nested relations (next-of-kin,
 * spouses, referees, equity application).
 *
 * Every write here happens against SQLite *synchronously with the user's
 * action* — nothing in this module ever waits on the network. Each write
 * also stamps the record `is_dirty = 1` / `sync_status = 'pending'` and
 * bumps `local_rev`, then calls `touchOutbox()` to (re)queue a sync job.
 * The actual network call happens later, opportunistically, in
 * `sync-engine.ts`. This split is what makes "save" instant regardless of
 * connectivity: the UI only ever waits on SQLite, never on `fetch`.
 */
import { getDb } from "./db";
import { generateLocalId } from "./uuid";
import { touchOutbox, removeOutboxFor } from "./sync-outbox";
import type {
  ClientFields,
  EquityApplicationFields,
  LocalClient,
  LocalClientWithRelations,
  LocalEquityApplication,
  LocalNextOfKin,
  LocalReferee,
  LocalSpouse,
  NextOfKinFields,
  RefereeFields,
  SpouseFields,
} from "./types";

/** Fields a brand-new draft client starts with — everything optional/blank. */
const EMPTY_CLIENT_FIELDS: ClientFields = {
  account_number: null,
  first_name: "",
  middle_name: null,
  surname: "",
  dob: null,
  sex: null,
  marital_status: null,
  nationality: null,
  state_id: null,
  city_id: null,
  residential_address: null,
  employer_name_address: null,
  phone_no: "",
  email: null,
  means_of_identification: null,
  id_number: null,
  nin: null,
  bvn: null,
  account_category: null,
  purpose_of_account: null,
  applicant_signed_date: null,
};

const EMPTY_EQUITY_FIELDS: EquityApplicationFields = {
  pension_fund_administrator_id: null,
  pin: null,
  mortgage_lender_name: null,
  mortgage_lender_address: null,
  property_type: null,
  property_type_address: null,
  mortgage_offer_type: null,
  evidence_of_marriage: null,
  equity_per_applicant: null,
  mortgage_account_number: null,
  value_of_property: null,
  amount_of_equity_payable: null,
  is_owner_occupier: null,
  occupation: null,
  date_employed: null,
  office_address: null,
  present_position: null,
  telephone_no: null,
  supplementary_mortgage_lender: null,
  purpose_of_loan: null,
  loan_amount: null,
  repayment_period: null,
  monthly_salary_income: null,
  source_of_loan_repayment: null,
  declaration_date: null,
};

function nowIso(): string {
  return new Date().toISOString();
}

function boolToInt(value: boolean | null): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function intToBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return Number(value) === 1;
}

// ---------------------------------------------------------------------------
// Row <-> domain object mapping. SQLite has no real boolean type, so
// booleans round-trip through 0/1 ints; everything else is stored as-is.
// ---------------------------------------------------------------------------

function rowToClient(row: any): LocalClient {
  return {
    local_id: row.local_id,
    server_id: row.server_id ?? null,
    sync_status: row.sync_status,
    sync_error: row.sync_error ?? null,
    is_dirty: Number(row.is_dirty) === 1,
    is_deleted: Number(row.is_deleted) === 1,
    local_rev: row.local_rev,
    created_at: row.created_at,
    updated_at: row.updated_at,
    account_number: row.account_number ?? null,
    first_name: row.first_name ?? "",
    middle_name: row.middle_name ?? null,
    surname: row.surname ?? "",
    dob: row.dob ?? null,
    sex: row.sex ?? null,
    marital_status: row.marital_status ?? null,
    nationality: row.nationality ?? null,
    state_id: row.state_id ?? null,
    city_id: row.city_id ?? null,
    residential_address: row.residential_address ?? null,
    employer_name_address: row.employer_name_address ?? null,
    phone_no: row.phone_no ?? "",
    email: row.email ?? null,
    means_of_identification: row.means_of_identification ?? null,
    id_number: row.id_number ?? null,
    nin: row.nin ?? null,
    bvn: row.bvn ?? null,
    account_category: row.account_category ?? null,
    purpose_of_account: row.purpose_of_account ?? null,
    applicant_signed_date: row.applicant_signed_date ?? null,
  };
}

function rowToNextOfKin(row: any): LocalNextOfKin {
  return {
    local_id: row.local_id,
    client_local_id: row.client_local_id,
    name: row.name ?? "",
    relationship: row.relationship ?? "",
    phone: row.phone ?? "",
    dob: row.dob ?? null,
    address: row.address ?? null,
    email: row.email ?? null,
    occupation: row.occupation ?? null,
    work_address: row.work_address ?? null,
  };
}

function rowToSpouse(row: any): LocalSpouse {
  return {
    local_id: row.local_id,
    client_local_id: row.client_local_id,
    sequence: row.sequence,
    name: row.name ?? "",
    dob: row.dob ?? null,
    relationship: row.relationship ?? null,
    address: row.address ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    occupation: row.occupation ?? null,
    work_address: row.work_address ?? null,
    pin: row.pin ?? null,
    pension_fund_administrator_id: row.pension_fund_administrator_id ?? null,
    equity_contribution:
      row.equity_contribution === null || row.equity_contribution === undefined
        ? null
        : Number(row.equity_contribution),
  };
}

function rowToReferee(row: any): LocalReferee {
  return {
    local_id: row.local_id,
    client_local_id: row.client_local_id,
    referee_number: row.referee_number,
    referee_name: row.referee_name ?? "",
    known_period: row.known_period ?? null,
    current_account_with: row.current_account_with ?? null,
    suitability_comment: row.suitability_comment ?? null,
    bank_name_address: row.bank_name_address ?? null,
    referee_account_number: row.referee_account_number ?? null,
  };
}

function rowToEquityApplication(row: any): LocalEquityApplication {
  return {
    client_local_id: row.client_local_id,
    server_id: row.server_id ?? null,
    sync_status: row.sync_status,
    sync_error: row.sync_error ?? null,
    is_dirty: Number(row.is_dirty) === 1,
    local_rev: row.local_rev,
    updated_at: row.updated_at,
    pension_fund_administrator_id: row.pension_fund_administrator_id ?? null,
    pin: row.pin ?? null,
    mortgage_lender_name: row.mortgage_lender_name ?? null,
    mortgage_lender_address: row.mortgage_lender_address ?? null,
    property_type: row.property_type ?? null,
    property_type_address: row.property_type_address ?? null,
    mortgage_offer_type: row.mortgage_offer_type ?? null,
    evidence_of_marriage: intToBool(row.evidence_of_marriage),
    equity_per_applicant:
      row.equity_per_applicant === null || row.equity_per_applicant === undefined
        ? null
        : Number(row.equity_per_applicant),
    mortgage_account_number: row.mortgage_account_number ?? null,
    value_of_property:
      row.value_of_property === null || row.value_of_property === undefined
        ? null
        : Number(row.value_of_property),
    amount_of_equity_payable:
      row.amount_of_equity_payable === null ||
      row.amount_of_equity_payable === undefined
        ? null
        : Number(row.amount_of_equity_payable),
    is_owner_occupier: intToBool(row.is_owner_occupier),
    occupation: row.occupation ?? null,
    date_employed: row.date_employed ?? null,
    office_address: row.office_address ?? null,
    present_position: row.present_position ?? null,
    telephone_no: row.telephone_no ?? null,
    supplementary_mortgage_lender: row.supplementary_mortgage_lender ?? null,
    purpose_of_loan: row.purpose_of_loan ?? null,
    loan_amount:
      row.loan_amount === null || row.loan_amount === undefined
        ? null
        : Number(row.loan_amount),
    repayment_period: row.repayment_period ?? null,
    monthly_salary_income:
      row.monthly_salary_income === null || row.monthly_salary_income === undefined
        ? null
        : Number(row.monthly_salary_income),
    source_of_loan_repayment: row.source_of_loan_repayment ?? null,
    declaration_date: row.declaration_date ?? null,
  };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Create a new local draft client (blank) and its blank equity application. */
export async function createDraftClient(): Promise<string> {
  const db = await getDb();
  const localId = generateLocalId();
  const now = nowIso();

  await db.execute(
    `INSERT INTO clients (
        local_id, server_id, sync_status, sync_error, is_dirty, is_deleted, local_rev,
        created_at, updated_at, account_number, first_name, middle_name, surname, dob,
        sex, marital_status, nationality, state_id, city_id, residential_address,
        employer_name_address, phone_no, email, means_of_identification, id_number,
        nin, bvn, account_category, purpose_of_account, applicant_signed_date
     ) VALUES (?, NULL, 'pending', NULL, 0, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      localId,
      now,
      now,
      EMPTY_CLIENT_FIELDS.account_number,
      EMPTY_CLIENT_FIELDS.first_name,
      EMPTY_CLIENT_FIELDS.middle_name,
      EMPTY_CLIENT_FIELDS.surname,
      EMPTY_CLIENT_FIELDS.dob,
      EMPTY_CLIENT_FIELDS.sex,
      EMPTY_CLIENT_FIELDS.marital_status,
      EMPTY_CLIENT_FIELDS.nationality,
      EMPTY_CLIENT_FIELDS.state_id,
      EMPTY_CLIENT_FIELDS.city_id,
      EMPTY_CLIENT_FIELDS.residential_address,
      EMPTY_CLIENT_FIELDS.employer_name_address,
      EMPTY_CLIENT_FIELDS.phone_no,
      EMPTY_CLIENT_FIELDS.email,
      EMPTY_CLIENT_FIELDS.means_of_identification,
      EMPTY_CLIENT_FIELDS.id_number,
      EMPTY_CLIENT_FIELDS.nin,
      EMPTY_CLIENT_FIELDS.bvn,
      EMPTY_CLIENT_FIELDS.account_category,
      EMPTY_CLIENT_FIELDS.purpose_of_account,
      EMPTY_CLIENT_FIELDS.applicant_signed_date,
    ],
  );

  await db.execute(
    `INSERT INTO equity_applications (
        client_local_id, server_id, sync_status, sync_error, is_dirty, local_rev, updated_at,
        pension_fund_administrator_id, pin, mortgage_lender_name, mortgage_lender_address,
        property_type, property_type_address, mortgage_offer_type, evidence_of_marriage,
        equity_per_applicant, mortgage_account_number, value_of_property,
        amount_of_equity_payable, is_owner_occupier, occupation, date_employed,
        office_address, present_position, telephone_no, supplementary_mortgage_lender,
        purpose_of_loan, loan_amount, repayment_period, monthly_salary_income,
        source_of_loan_repayment, declaration_date
     ) VALUES (?, NULL, 'pending', NULL, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      localId,
      now,
      ...Object.values(EMPTY_EQUITY_FIELDS).map((v) =>
        typeof v === "boolean" ? boolToInt(v) : v,
      ),
    ],
  );

  // Not enqueued for sync yet — a blank draft has nothing worth pushing.
  // The wizard calls `markClientReadyForSync()` once required fields + the
  // 2 referees are present.
  return localId;
}

/** List all non-deleted local clients, most recently updated first. */
export async function listClients(): Promise<LocalClient[]> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT * FROM clients WHERE is_deleted = 0 ORDER BY updated_at DESC`,
  );
  return rows.map(rowToClient);
}

/** Load a single client with all of its nested relations, or null if missing. */
export async function getClientWithRelations(
  localId: string,
): Promise<LocalClientWithRelations | null> {
  const db = await getDb();
  const clientRows = await db.select<any[]>(
    `SELECT * FROM clients WHERE local_id = ? AND is_deleted = 0`,
    [localId],
  );
  if (clientRows.length === 0) return null;

  const [nextOfKinRows, spouseRows, refereeRows, equityRows] = await Promise.all([
    db.select<any[]>(`SELECT * FROM next_of_kin WHERE client_local_id = ?`, [
      localId,
    ]),
    db.select<any[]>(
      `SELECT * FROM spouses WHERE client_local_id = ? ORDER BY sequence ASC`,
      [localId],
    ),
    db.select<any[]>(
      `SELECT * FROM referees WHERE client_local_id = ? ORDER BY referee_number ASC`,
      [localId],
    ),
    db.select<any[]>(`SELECT * FROM equity_applications WHERE client_local_id = ?`, [
      localId,
    ]),
  ]);

  return {
    ...rowToClient(clientRows[0]),
    next_of_kin: nextOfKinRows.length > 0 ? rowToNextOfKin(nextOfKinRows[0]) : null,
    spouses: spouseRows.map(rowToSpouse),
    referees: refereeRows.map(rowToReferee),
    equity_application:
      equityRows.length > 0 ? rowToEquityApplication(equityRows[0]) : null,
  };
}

/** Save (patch) a client's core fields as a local draft write. */
export async function saveClientCore(
  localId: string,
  fields: Partial<ClientFields>,
): Promise<void> {
  const db = await getDb();
  const keys = Object.keys(fields) as (keyof ClientFields)[];
  if (keys.length === 0) return;

  const now = nowIso();
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] ?? null);

  await db.execute(
    `UPDATE clients SET ${setClause}, is_dirty = 1, sync_status = 'pending', sync_error = NULL,
        local_rev = local_rev + 1, updated_at = ?
     WHERE local_id = ?`,
    [...values, now, localId],
  );

  await touchOutbox("client", localId);
}

/** Replace (upsert or clear) the single next-of-kin row for a client. */
export async function saveNextOfKin(
  clientLocalId: string,
  fields: NextOfKinFields | null,
): Promise<void> {
  const db = await getDb();

  if (fields === null) {
    await db.execute(`DELETE FROM next_of_kin WHERE client_local_id = ?`, [
      clientLocalId,
    ]);
  } else {
    const existing = await db.select<any[]>(
      `SELECT local_id FROM next_of_kin WHERE client_local_id = ?`,
      [clientLocalId],
    );
    if (existing.length > 0) {
      await db.execute(
        `UPDATE next_of_kin SET name = ?, relationship = ?, phone = ?, dob = ?,
            address = ?, email = ?, occupation = ?, work_address = ?
         WHERE client_local_id = ?`,
        [
          fields.name,
          fields.relationship,
          fields.phone,
          fields.dob,
          fields.address,
          fields.email,
          fields.occupation,
          fields.work_address,
          clientLocalId,
        ],
      );
    } else {
      await db.execute(
        `INSERT INTO next_of_kin (
            local_id, client_local_id, name, relationship, phone, dob, address, email,
            occupation, work_address
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateLocalId(),
          clientLocalId,
          fields.name,
          fields.relationship,
          fields.phone,
          fields.dob,
          fields.address,
          fields.email,
          fields.occupation,
          fields.work_address,
        ],
      );
    }
  }

  await touchClientDirty(clientLocalId);
  await touchOutbox("client", clientLocalId);
}

/** Replace the full spouse list for a client (mirrors the backend's delete+recreate sync). */
export async function replaceSpouses(
  clientLocalId: string,
  spouses: SpouseFields[],
): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM spouses WHERE client_local_id = ?`, [
    clientLocalId,
  ]);

  for (let i = 0; i < spouses.length; i++) {
    const s = spouses[i];
    await db.execute(
      `INSERT INTO spouses (
          local_id, client_local_id, sequence, name, dob, relationship, address, phone,
          email, occupation, work_address, pin, pension_fund_administrator_id, equity_contribution
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateLocalId(),
        clientLocalId,
        i + 1,
        s.name,
        s.dob,
        s.relationship,
        s.address,
        s.phone,
        s.email,
        s.occupation,
        s.work_address,
        s.pin,
        s.pension_fund_administrator_id,
        s.equity_contribution,
      ],
    );
  }

  await touchClientDirty(clientLocalId);
  await touchOutbox("client", clientLocalId);
}

/** Replace/upsert referees by referee_number (mirrors the backend's updateOrCreate). */
export async function replaceReferees(
  clientLocalId: string,
  referees: RefereeFields[],
): Promise<void> {
  const db = await getDb();

  for (const r of referees) {
    const existing = await db.select<any[]>(
      `SELECT local_id FROM referees WHERE client_local_id = ? AND referee_number = ?`,
      [clientLocalId, r.referee_number],
    );
    if (existing.length > 0) {
      await db.execute(
        `UPDATE referees SET referee_name = ?, known_period = ?, current_account_with = ?,
            suitability_comment = ?, bank_name_address = ?, referee_account_number = ?
         WHERE client_local_id = ? AND referee_number = ?`,
        [
          r.referee_name,
          r.known_period,
          r.current_account_with,
          r.suitability_comment,
          r.bank_name_address,
          r.referee_account_number,
          clientLocalId,
          r.referee_number,
        ],
      );
    } else {
      await db.execute(
        `INSERT INTO referees (
            local_id, client_local_id, referee_number, referee_name, known_period,
            current_account_with, suitability_comment, bank_name_address, referee_account_number
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateLocalId(),
          clientLocalId,
          r.referee_number,
          r.referee_name,
          r.known_period,
          r.current_account_with,
          r.suitability_comment,
          r.bank_name_address,
          r.referee_account_number,
        ],
      );
    }
  }

  await touchClientDirty(clientLocalId);
  await touchOutbox("client", clientLocalId);
}

/** Save (patch) a client's equity-application fields as a local draft write. */
export async function saveEquityApplication(
  clientLocalId: string,
  fields: Partial<EquityApplicationFields>,
): Promise<void> {
  const db = await getDb();
  const keys = Object.keys(fields) as (keyof EquityApplicationFields)[];
  if (keys.length === 0) return;

  const now = nowIso();
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => {
    const v = fields[k];
    return typeof v === "boolean" ? boolToInt(v) : (v ?? null);
  });

  await db.execute(
    `UPDATE equity_applications SET ${setClause}, is_dirty = 1, sync_status = 'pending',
        sync_error = NULL, local_rev = local_rev + 1, updated_at = ?
     WHERE client_local_id = ?`,
    [...values, now, clientLocalId],
  );

  // The equity application can only sync once its parent client has a
  // server_id (PUT /client/{id}/equity-application) — see sync-engine.ts,
  // which checks that gate at drain time. We still enqueue eagerly here so
  // it's picked up the moment the parent client finishes syncing.
  await touchOutbox("equity_application", clientLocalId);
}

/** Bump the parent client's dirty/rev bookkeeping after a nested-relation write. */
async function touchClientDirty(clientLocalId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE clients SET is_dirty = 1, sync_status = 'pending', sync_error = NULL,
        local_rev = local_rev + 1, updated_at = ?
     WHERE local_id = ?`,
    [nowIso(), clientLocalId],
  );
}

/**
 * Soft-delete a client locally. If it was never synced (no server_id) it's
 * simply removed outright since the server has never heard of it; otherwise
 * it's flagged deleted and a delete job is queued so the server copy is
 * removed on next sync.
 */
export async function deleteClient(localId: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT server_id FROM clients WHERE local_id = ?`,
    [localId],
  );
  if (rows.length === 0) return;

  if (rows[0].server_id === null) {
    await removeOutboxFor("client", localId);
    await removeOutboxFor("equity_application", localId);
    await db.execute(`DELETE FROM clients WHERE local_id = ?`, [localId]);
    return;
  }

  await db.execute(
    `UPDATE clients SET is_deleted = 1, is_dirty = 1, sync_status = 'pending',
        local_rev = local_rev + 1, updated_at = ? WHERE local_id = ?`,
    [nowIso(), localId],
  );
  await touchOutbox("client", localId);
}

// ---------------------------------------------------------------------------
// Sync reconciliation — called only from sync-engine.ts after a network round trip.
// ---------------------------------------------------------------------------

export async function markClientSyncing(localId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE clients SET sync_status = 'syncing' WHERE local_id = ?`, [
    localId,
  ]);
}

export async function markEquityApplicationSyncing(
  clientLocalId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE equity_applications SET sync_status = 'syncing' WHERE client_local_id = ?`,
    [clientLocalId],
  );
}

/**
 * Apply a successful create/update response from the server.
 * `sinceRev` is the `local_rev` read right before the request was sent —
 * if the row has moved on since (the agent kept editing while the request
 * was in flight), we deliberately leave it `pending`/dirty so the newer
 * state gets synced on the next pass instead of being clobbered as "synced".
 */
export async function reconcileClientSynced(
  localId: string,
  serverId: number,
  sinceRev: number,
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT local_rev FROM clients WHERE local_id = ?`,
    [localId],
  );
  const stillFresh = rows.length > 0 && rows[0].local_rev === sinceRev;

  await db.execute(
    `UPDATE clients SET server_id = ?, sync_error = NULL,
        sync_status = CASE WHEN ? THEN 'synced' ELSE 'pending' END,
        is_dirty = CASE WHEN ? THEN 0 ELSE 1 END
     WHERE local_id = ?`,
    [serverId, stillFresh ? 1 : 0, stillFresh ? 1 : 0, localId],
  );
}

export async function reconcileEquityApplicationSynced(
  clientLocalId: string,
  sinceRev: number,
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT local_rev FROM equity_applications WHERE client_local_id = ?`,
    [clientLocalId],
  );
  const stillFresh = rows.length > 0 && rows[0].local_rev === sinceRev;

  await db.execute(
    `UPDATE equity_applications SET sync_error = NULL,
        sync_status = CASE WHEN ? THEN 'synced' ELSE 'pending' END,
        is_dirty = CASE WHEN ? THEN 0 ELSE 1 END
     WHERE client_local_id = ?`,
    [stillFresh ? 1 : 0, stillFresh ? 1 : 0, clientLocalId],
  );
}

export async function markClientFailed(
  localId: string,
  message: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE clients SET sync_status = 'failed', sync_error = ? WHERE local_id = ?`,
    [message, localId],
  );
}

export async function markEquityApplicationFailed(
  clientLocalId: string,
  message: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE equity_applications SET sync_status = 'failed', sync_error = ? WHERE client_local_id = ?`,
    [message, clientLocalId],
  );
}

/** Finalize a completed local delete (server confirmed the record is gone). */
export async function finalizeClientDeleted(localId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM clients WHERE local_id = ?`, [localId]);
}

/**
 * Merge a page of server clients into the local store without clobbering any
 * client that has unsynced local edits (`is_dirty`). This is how the
 * dashboard's list stays useful across devices/re-installs while never
 * overwriting an agent's in-progress offline edits with a stale server copy.
 */
export async function mergeServerClients(
  serverClients: Array<{ id: number } & ClientFields>,
): Promise<void> {
  const db = await getDb();

  for (const sc of serverClients) {
    const existing = await db.select<any[]>(
      `SELECT local_id, is_dirty FROM clients WHERE server_id = ?`,
      [sc.id],
    );

    if (existing.length === 0) {
      const localId = generateLocalId();
      const now = nowIso();
      await db.execute(
        `INSERT INTO clients (
            local_id, server_id, sync_status, sync_error, is_dirty, is_deleted, local_rev,
            created_at, updated_at, account_number, first_name, middle_name, surname, dob,
            sex, marital_status, nationality, state_id, city_id, residential_address,
            employer_name_address, phone_no, email, means_of_identification, id_number,
            nin, bvn, account_category, purpose_of_account, applicant_signed_date
         ) VALUES (?, ?, 'synced', NULL, 0, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localId,
          sc.id,
          now,
          now,
          sc.account_number,
          sc.first_name,
          sc.middle_name,
          sc.surname,
          sc.dob,
          sc.sex,
          sc.marital_status,
          sc.nationality,
          sc.state_id,
          sc.city_id,
          sc.residential_address,
          sc.employer_name_address,
          sc.phone_no,
          sc.email,
          sc.means_of_identification,
          sc.id_number,
          sc.nin,
          sc.bvn,
          sc.account_category,
          sc.purpose_of_account,
          sc.applicant_signed_date,
        ],
      );
    } else if (Number(existing[0].is_dirty) === 0) {
      // Safe to overwrite: no unsynced local edits on this record.
      await db.execute(
        `UPDATE clients SET account_number = ?, first_name = ?, middle_name = ?,
            surname = ?, dob = ?, sex = ?, marital_status = ?, nationality = ?,
            state_id = ?, city_id = ?, residential_address = ?, employer_name_address = ?,
            phone_no = ?, email = ?, means_of_identification = ?, id_number = ?, nin = ?,
            bvn = ?, account_category = ?, purpose_of_account = ?, applicant_signed_date = ?,
            sync_status = 'synced', sync_error = NULL, updated_at = ?
         WHERE local_id = ?`,
        [
          sc.account_number,
          sc.first_name,
          sc.middle_name,
          sc.surname,
          sc.dob,
          sc.sex,
          sc.marital_status,
          sc.nationality,
          sc.state_id,
          sc.city_id,
          sc.residential_address,
          sc.employer_name_address,
          sc.phone_no,
          sc.email,
          sc.means_of_identification,
          sc.id_number,
          sc.nin,
          sc.bvn,
          sc.account_category,
          sc.purpose_of_account,
          sc.applicant_signed_date,
          nowIso(),
          existing[0].local_id,
        ],
      );
    }
    // else: local edits are pending — leave it alone, the outbox will push
    // the local version up rather than the pull clobbering it.
  }
}
