/**
 * Background sync engine.
 *
 * Runs on app start, when the browser fires an `online` event, on a periodic
 * timer, and on demand (a "sync now" button). Every pass:
 *   1. Confirms real server reachability (not just `navigator.onLine`).
 *   2. Refreshes cached lookups (states/PFAs) if online and stale.
 *   3. Drains the outbox in FIFO order, one job at a time.
 *   4. Pulls the latest client list from the server, merging without
 *      clobbering any client that still has unsynced local edits.
 *
 * The UI never calls the network directly for this feature — it writes to
 * SQLite via `clients-repo.ts` and reads a `SyncSummary` from here to render
 * a status indicator. This keeps "save" instant and "sync" entirely a
 * background concern, per the offline-first brief.
 */
import { getDb } from "./db";
import { ApiError } from "./api";
import {
  createClient,
  deleteClientRemote,
  fetchClients,
  pingServer,
  updateClient,
  updateEquityApplication,
  type ClientPayload,
} from "./clients-api";
import {
  finalizeClientDeleted,
  getClientWithRelations,
  markClientFailed,
  markClientSyncing,
  markEquityApplicationFailed,
  markEquityApplicationSyncing,
  mergeServerClients,
  reconcileClientSynced,
  reconcileEquityApplicationSynced,
} from "./clients-repo";
import type { LocalClientWithRelations } from "./types";
import {
  countActiveOutboxRows,
  listDueOutboxRows,
  markOutboxDone,
  markOutboxPermanentFailure,
  markOutboxRetry,
  markOutboxSyncing,
  removeOutboxFor,
  type OutboxRow,
} from "./sync-outbox";
import { getLookupsRefreshedAt, refreshStatesAndPfas } from "./lookups-repo";
import type { EquityApplicationFields, SyncSummary } from "./types";

const LOOKUPS_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

let isSyncing = false;
let isOffline = false;
let lastError: string | null = null;
let lastSyncedAt: string | null = null;
let periodicHandle: ReturnType<typeof setInterval> | null = null;

/** Minimum fields required before a client is worth attempting to push at all. */
function hasRequiredCoreFields(client: {
  first_name: string;
  surname: string;
  phone_no: string;
}): boolean {
  return (
    client.first_name.trim().length > 0 &&
    client.surname.trim().length > 0 &&
    client.phone_no.trim().length > 0
  );
}

/** A *create* additionally requires exactly 2 distinct, named referees (backend rule). */
function hasBothReferees(
  referees: { referee_number: 1 | 2; referee_name: string }[],
): boolean {
  const numbers = new Set(referees.map((r) => r.referee_number));
  return (
    referees.length === 2 &&
    numbers.has(1) &&
    numbers.has(2) &&
    referees.every((r) => r.referee_name.trim().length > 0)
  );
}

function buildClientPayload(client: LocalClientWithRelations): {
  payload: ClientPayload;
  ready: boolean;
} {
  const coreReady = hasRequiredCoreFields(client);
  const isCreate = client.server_id === null;
  const ready = isCreate ? coreReady && hasBothReferees(client.referees) : coreReady;

  const payload: ClientPayload = {
    account_number: client.account_number,
    first_name: client.first_name,
    middle_name: client.middle_name,
    surname: client.surname,
    dob: client.dob,
    sex: client.sex,
    marital_status: client.marital_status,
    nationality: client.nationality,
    state_id: client.state_id,
    city_id: client.city_id,
    residential_address: client.residential_address,
    employer_name_address: client.employer_name_address,
    phone_no: client.phone_no,
    email: client.email,
    means_of_identification: client.means_of_identification,
    id_number: client.id_number,
    nin: client.nin,
    bvn: client.bvn,
    account_category: client.account_category,
    purpose_of_account: client.purpose_of_account,
    applicant_signed_date: client.applicant_signed_date,
    next_of_kin: client.next_of_kin
      ? {
          name: client.next_of_kin.name,
          relationship: client.next_of_kin.relationship,
          phone: client.next_of_kin.phone,
          dob: client.next_of_kin.dob,
          address: client.next_of_kin.address,
          email: client.next_of_kin.email,
          occupation: client.next_of_kin.occupation,
          work_address: client.next_of_kin.work_address,
        }
      : null,
    spouses: client.spouses.map((s) => ({
      name: s.name,
      dob: s.dob,
      relationship: s.relationship,
      address: s.address,
      phone: s.phone,
      email: s.email,
      occupation: s.occupation,
      work_address: s.work_address,
      pin: s.pin,
      pension_fund_administrator_id: s.pension_fund_administrator_id,
      equity_contribution: s.equity_contribution,
    })),
    referees: client.referees.map((r) => ({
      referee_number: r.referee_number,
      referee_name: r.referee_name,
      known_period: r.known_period,
      current_account_with: r.current_account_with,
      suitability_comment: r.suitability_comment,
      bank_name_address: r.bank_name_address,
      referee_account_number: r.referee_account_number,
    })),
  };

  return { payload, ready };
}

function equityApplicationPayload(
  fields: EquityApplicationFields,
): Partial<EquityApplicationFields> {
  const {
    pension_fund_administrator_id,
    pin,
    mortgage_lender_name,
    mortgage_lender_address,
    property_type,
    property_type_address,
    mortgage_offer_type,
    evidence_of_marriage,
    equity_per_applicant,
    mortgage_account_number,
    value_of_property,
    amount_of_equity_payable,
    is_owner_occupier,
    occupation,
    date_employed,
    office_address,
    present_position,
    telephone_no,
    supplementary_mortgage_lender,
    purpose_of_loan,
    loan_amount,
    repayment_period,
    monthly_salary_income,
    source_of_loan_repayment,
    declaration_date,
  } = fields;
  return {
    pension_fund_administrator_id,
    pin,
    mortgage_lender_name,
    mortgage_lender_address,
    property_type,
    property_type_address,
    mortgage_offer_type,
    evidence_of_marriage,
    equity_per_applicant,
    mortgage_account_number,
    value_of_property,
    amount_of_equity_payable,
    is_owner_occupier,
    occupation,
    date_employed,
    office_address,
    present_position,
    telephone_no,
    supplementary_mortgage_lender,
    purpose_of_loan,
    loan_amount,
    repayment_period,
    monthly_salary_income,
    source_of_loan_repayment,
    declaration_date,
  };
}

/** Classify a failure per the brief: 4xx = don't auto-retry, 0/5xx = retry with backoff. */
async function handleFailure(row: OutboxRow, err: unknown): Promise<string> {
  const message =
    err instanceof ApiError ? err.message : "Unexpected error during sync.";
  const status = err instanceof ApiError ? err.status : 0;
  const isValidationOrClientError = status >= 400 && status < 500;

  if (isValidationOrClientError) {
    await markOutboxPermanentFailure(row.id, message);
  } else {
    await markOutboxRetry(row.id, row.attempt_count + 1, message);
  }
  return message;
}

async function attemptClientRow(token: string, row: OutboxRow): Promise<void> {
  const client = await getClientWithRelations(row.entity_local_id);
  if (!client) {
    // Client was deleted locally before ever syncing.
    await markOutboxDone(row.id);
    return;
  }

  // Deletion takes priority over any pending create/update.
  if (client.is_deleted) {
    if (client.server_id === null) {
      await finalizeClientDeleted(row.entity_local_id);
      await removeOutboxFor("equity_application", row.entity_local_id);
      await markOutboxDone(row.id);
      return;
    }
    await markOutboxSyncing(row.id, "delete");
    try {
      await deleteClientRemote(token, client.server_id);
      await finalizeClientDeleted(row.entity_local_id);
      await removeOutboxFor("equity_application", row.entity_local_id);
      await markOutboxDone(row.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        await finalizeClientDeleted(row.entity_local_id);
        await removeOutboxFor("equity_application", row.entity_local_id);
        await markOutboxDone(row.id);
        return;
      }
      lastError = await handleFailure(row, err);
    }
    return;
  }

  const built = buildClientPayload(client);
  if (!built.ready) {
    // Draft is incomplete (e.g. missing required fields or the 2 referees
    // needed to create). Not a failure — just not sync-eligible yet. Leave
    // the outbox row pending so it's picked up the moment the agent
    // finishes the wizard, without spamming retries or error states.
    return;
  }

  const operation = client.server_id === null ? "create" : "update";
  await markOutboxSyncing(row.id, operation);
  await markClientSyncing(row.entity_local_id);
  const sinceRev = client.local_rev;

  try {
    const result =
      operation === "create"
        ? await createClient(token, built.payload)
        : await updateClient(token, client.server_id as number, built.payload);

    await reconcileClientSynced(row.entity_local_id, result.id, sinceRev);
    await markOutboxDone(row.id);
  } catch (err) {
    lastError = await handleFailure(row, err);
    await markClientFailed(row.entity_local_id, lastError);
  }
}

async function attemptEquityApplicationRow(
  token: string,
  row: OutboxRow,
): Promise<void> {
  const client = await getClientWithRelations(row.entity_local_id);
  if (!client || !client.equity_application) {
    await markOutboxDone(row.id);
    return;
  }

  if (client.server_id === null) {
    // Blocked on the parent client syncing first — leave pending, no error.
    return;
  }

  await markOutboxSyncing(row.id, "update");
  await markEquityApplicationSyncing(row.entity_local_id);
  const sinceRev = client.equity_application.local_rev;

  try {
    await updateEquityApplication(
      token,
      client.server_id,
      equityApplicationPayload(client.equity_application),
    );
    await reconcileEquityApplicationSynced(row.entity_local_id, sinceRev);
    await markOutboxDone(row.id);
  } catch (err) {
    lastError = await handleFailure(row, err);
    await markEquityApplicationFailed(row.entity_local_id, lastError);
  }
}

/** Drain the outbox in FIFO order. Creates naturally precede updates for the
 * same entity because they share one coalesced row (see sync-outbox.ts). */
async function drainOutbox(token: string): Promise<void> {
  const rows = await listDueOutboxRows();
  for (const row of rows) {
    if (row.entity_type === "client") {
      await attemptClientRow(token, row);
    } else {
      await attemptEquityApplicationRow(token, row);
    }
  }
}

async function refreshLookupsIfStale(token: string): Promise<void> {
  try {
    const refreshedAt = await getLookupsRefreshedAt();
    const stale =
      !refreshedAt || Date.now() - new Date(refreshedAt).getTime() > LOOKUPS_STALE_AFTER_MS;
    if (stale) {
      await refreshStatesAndPfas(token);
    }
  } catch {
    // Lookups are a nice-to-have refresh; never let it block the outbox drain.
  }
}

async function pullClientList(token: string): Promise<void> {
  try {
    const page = await fetchClients(token);
    await mergeServerClients(page.data.map((c) => ({ ...c })));
  } catch {
    // Best-effort — the local list remains whatever it already was.
  }
}

/** Run one full sync pass. Safe to call concurrently — re-entrant calls are ignored. */
export async function runSyncPass(getToken: () => Promise<string | null>): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const token = await getToken();
    if (!token) {
      isOffline = true;
      return;
    }

    const reachable = await pingServer(token);
    isOffline = !reachable;
    if (!reachable) return;

    await refreshLookupsIfStale(token);
    await drainOutbox(token);
    await pullClientList(token);

    const { pending, failed } = await countActiveOutboxRows();
    if (pending === 0 && failed === 0) {
      lastError = null;
    }
    lastSyncedAt = new Date().toISOString();
  } finally {
    isSyncing = false;
  }
}

export async function getSyncSummary(): Promise<SyncSummary> {
  const { pending, failed } = await countActiveOutboxRows();
  return {
    state: isSyncing ? "syncing" : isOffline ? "offline" : "idle",
    pendingCount: pending,
    failedCount: failed,
    lastError,
    lastSyncedAt,
  };
}

export interface SyncController {
  triggerSync: () => void;
  stop: () => void;
}

/**
 * Wire up the automatic sync triggers: an immediate pass, a periodic
 * fallback poll (since Tauri webviews don't reliably fire browser
 * connectivity events against a real server), and a listener for the
 * browser's `online` event as a fast-path nudge when it does fire.
 */
export function startBackgroundSync(
  getToken: () => Promise<string | null>,
  intervalMs = 30_000,
): SyncController {
  const trigger = () => {
    void runSyncPass(getToken);
  };

  trigger();
  periodicHandle = setInterval(trigger, intervalMs);
  window.addEventListener("online", trigger);

  return {
    triggerSync: trigger,
    stop: () => {
      if (periodicHandle) clearInterval(periodicHandle);
      window.removeEventListener("online", trigger);
    },
  };
}

/** Exposed for tests/manual poking; not otherwise used outside this module. */
export async function _debugDbHandle() {
  return getDb();
}
