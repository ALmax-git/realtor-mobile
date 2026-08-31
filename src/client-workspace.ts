/**
 * Alpine component for the post-login experience: the local client
 * dashboard and the client-intake wizard.
 *
 * Everything here reads/writes through `lib/clients-repo.ts` (SQLite) —
 * never `fetch` directly — so every action (save a step, add a referee,
 * delete a draft) completes instantly regardless of connectivity. Network
 * activity is entirely the background sync engine's job (`lib/sync-engine.ts`);
 * this component only *starts* it (once auth is confirmed) and polls its
 * status for the little sync indicator in the header.
 *
 * Kept as its own `Alpine.data()` factory (registered from `main.ts`)
 * rather than folded into `authApp()`, since auth and client-intake are
 * different concerns with different lifetimes — this component is wired to
 * start/stop its background sync via `client-auth-ready` / `client-auth-logout`
 * window events dispatched by `authApp()`, rather than being handed the
 * token directly, so it never needs to know *how* auth works.
 */
import { getStoredToken } from "./lib/auth-store";
import {
  createDraftClient,
  deleteClient as deleteClientLocal,
  getClientWithRelations,
  listClients,
  replaceReferees,
  replaceSpouses,
  saveClientCore,
  saveEquityApplication,
  saveNextOfKin,
} from "./lib/clients-repo";
import {
  getCachedCitiesForState,
  getCachedPfas,
  getCachedStates,
  refreshCitiesForState,
} from "./lib/lookups-repo";
import { getSyncSummary, startBackgroundSync, type SyncController } from "./lib/sync-engine";
import { touchOutbox } from "./lib/sync-outbox";
import {
  validateClientCore,
  validateNextOfKin,
  validateReferees,
  type FieldErrors,
} from "./lib/validation";
import {
  ACCOUNT_CATEGORY_OPTIONS,
  MARITAL_STATUS_OPTIONS,
  MEANS_OF_IDENTIFICATION_OPTIONS,
  MORTGAGE_OFFER_TYPE_OPTIONS,
  SEX_OPTIONS,
} from "./lib/enums";
import type {
  EquityApplicationFields,
  LocalClient,
  LocalClientWithRelations,
  LookupCity,
  LookupPfa,
  LookupState,
  NextOfKinFields,
  RefereeFields,
  SpouseFields,
  SyncSummary,
} from "./lib/types";

type Screen = "dashboard" | "wizard";

const WIZARD_STEPS = [
  "Client info",
  "Next of kin",
  "Spouse(s)",
  "Referees",
  "Equity application",
  "Review",
] as const;

/**
 * Every field is nullable server-side (`EquityApplicationRequest` rules are
 * all `['nullable', ...]`) — a field officer may simply not have this
 * information yet, and the record must still save/submit without it. This
 * step is purely optional polish on top of the required client/referee data.
 */
function blankEquityApplication(): EquityApplicationFields {
  return {
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
}

/**
 * Alpine's `.number` modifier leaves an empty `<select>`/number `<input>` as
 * `""` (it only coerces strings that parse as a valid float) rather than
 * `null`. Every nullable numeric field in the schema (state_id, city_id,
 * pension_fund_administrator_id, equity_contribution, ...) is normalized
 * through this before it touches SQLite or an API payload so we never store
 * `""` where the column is really an integer/real.
 */
function numOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isNaN(n) ? null : n;
}

function blankNextOfKin(): NextOfKinFields {
  return {
    name: "",
    relationship: "",
    phone: "",
    dob: null,
    address: null,
    email: null,
    occupation: null,
    work_address: null,
  };
}

function blankSpouse(): SpouseFields {
  return {
    name: "",
    dob: null,
    relationship: null,
    address: null,
    phone: null,
    email: null,
    occupation: null,
    work_address: null,
    pin: null,
    pension_fund_administrator_id: null,
    equity_contribution: null,
  };
}

function blankReferee(number: 1 | 2): RefereeFields {
  return {
    referee_number: number,
    referee_name: "",
    known_period: null,
    current_account_with: null,
    suitability_comment: null,
    bank_name_address: null,
    referee_account_number: null,
  };
}

export interface ClientWorkspaceState {
  screen: Screen;
  clients: LocalClient[];
  loadingClients: boolean;
  syncSummary: SyncSummary;
  syncControl: SyncController | null;

  // enum options for <select> bindings, exposed on the component for the template
  sexOptions: typeof SEX_OPTIONS;
  maritalStatusOptions: typeof MARITAL_STATUS_OPTIONS;
  meansOfIdOptions: typeof MEANS_OF_IDENTIFICATION_OPTIONS;
  accountCategoryOptions: typeof ACCOUNT_CATEGORY_OPTIONS;
  mortgageOfferTypeOptions: typeof MORTGAGE_OFFER_TYPE_OPTIONS;

  states: LookupState[];
  cities: LookupCity[];
  pfas: LookupPfa[];

  // wizard state
  wizardStep: number;
  wizardSteps: typeof WIZARD_STEPS;
  clientLocalId: string | null;
  hasNextOfKin: boolean;
  core: LocalClientWithRelations | null;
  nextOfKin: NextOfKinFields;
  spouses: SpouseFields[];
  referees: [RefereeFields, RefereeFields];
  equityApplication: EquityApplicationFields;
  coreErrors: FieldErrors;
  nextOfKinErrors: FieldErrors;
  refereeErrors: FieldErrors;
  saving: boolean;
  wizardError: string;

  setEquityBoolField(
    field: "evidence_of_marriage" | "is_owner_occupier",
    value: boolean | null,
  ): void;
  normalizedEquityApplication(): EquityApplicationFields;

  init(): Promise<void>;
  loadClients(): Promise<void>;
  startNewClient(): Promise<void>;
  resumeClient(localId: string): Promise<void>;
  backToDashboard(): Promise<void>;
  removeClient(localId: string): Promise<void>;
  triggerSyncNow(): void;

  onStateChange(): Promise<void>;
  addSpouse(): void;
  removeSpouse(index: number): void;
  goStep(step: number): Promise<void>;
  nextStep(): Promise<void>;
  prevStep(): void;
  saveCurrentStep(): Promise<boolean>;
  submitClient(): Promise<void>;

  syncBadge(client: LocalClient): { label: string; className: string };
}

export function clientWorkspace(): ClientWorkspaceState {
  return {
    screen: "dashboard",
    clients: [],
    loadingClients: false,
    syncSummary: {
      state: "idle",
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
      lastSyncedAt: null,
    },
    syncControl: null,

    sexOptions: SEX_OPTIONS,
    maritalStatusOptions: MARITAL_STATUS_OPTIONS,
    meansOfIdOptions: MEANS_OF_IDENTIFICATION_OPTIONS,
    accountCategoryOptions: ACCOUNT_CATEGORY_OPTIONS,
    mortgageOfferTypeOptions: MORTGAGE_OFFER_TYPE_OPTIONS,

    states: [],
    cities: [],
    pfas: [],

    wizardStep: 0,
    wizardSteps: WIZARD_STEPS,
    clientLocalId: null,
    hasNextOfKin: false,
    core: null,
    nextOfKin: blankNextOfKin(),
    spouses: [],
    referees: [blankReferee(1), blankReferee(2)],
    equityApplication: blankEquityApplication(),
    coreErrors: {},
    nextOfKinErrors: {},
    refereeErrors: {},
    saving: false,
    wizardError: "",

    async init() {
      await this.loadClients();
      this.states = await getCachedStates();
      this.pfas = await getCachedPfas();

      // Poll the sync engine's status every few seconds for the header badge
      // and to keep the dashboard's per-client status fresh as jobs drain.
      this.syncSummary = await getSyncSummary();
      setInterval(async () => {
        this.syncSummary = await getSyncSummary();
        if (this.screen === "dashboard") {
          await this.loadClients();
        }
      }, 4000);

      window.addEventListener("client-auth-ready", () => {
        if (this.syncControl) return;
        this.syncControl = startBackgroundSync(getStoredToken);
      });
      window.addEventListener("client-auth-logout", () => {
        this.syncControl?.stop();
        this.syncControl = null;
      });
    },

    async loadClients() {
      this.loadingClients = true;
      try {
        this.clients = await listClients();
      } finally {
        this.loadingClients = false;
      }
    },

    triggerSyncNow() {
      this.syncControl?.triggerSync();
    },

    async startNewClient() {
      const localId = await createDraftClient();
      await this.resumeClient(localId);
    },

    async resumeClient(localId: string) {
      const client = await getClientWithRelations(localId);
      if (!client) return;

      this.clientLocalId = localId;
      this.core = client;
      this.hasNextOfKin = client.next_of_kin !== null;
      this.nextOfKin = client.next_of_kin
        ? { ...client.next_of_kin }
        : blankNextOfKin();
      this.spouses = client.spouses.length > 0 ? client.spouses.map((s) => ({ ...s })) : [];
      this.referees = [
        client.referees.find((r) => r.referee_number === 1) ?? blankReferee(1),
        client.referees.find((r) => r.referee_number === 2) ?? blankReferee(2),
      ];
      this.equityApplication = client.equity_application
        ? { ...client.equity_application }
        : blankEquityApplication();
      this.coreErrors = {};
      this.nextOfKinErrors = {};
      this.refereeErrors = {};
      this.wizardError = "";
      this.wizardStep = 0;
      this.screen = "wizard";

      if (client.state_id) {
        this.cities = await getCachedCitiesForState(client.state_id);
      } else {
        this.cities = [];
      }
    },

    async backToDashboard() {
      await this.saveCurrentStep();
      this.screen = "dashboard";
      await this.loadClients();
    },

    async removeClient(localId: string) {
      await deleteClientLocal(localId);
      await this.loadClients();
    },

    async onStateChange() {
      if (!this.core) return;
      this.core.city_id = null;
      const stateId = numOrNull(this.core.state_id);
      if (!stateId) {
        this.cities = [];
        return;
      }
      this.cities = await getCachedCitiesForState(stateId);

      // Best-effort background refresh in case the cache is stale/empty;
      // silently ignored if offline.
      const token = await getStoredToken();
      if (token) {
        try {
          await refreshCitiesForState(token, stateId);
          this.cities = await getCachedCitiesForState(stateId);
        } catch {
          // offline or request failed — keep whatever was cached
        }
      }
    },

    addSpouse() {
      this.spouses.push(blankSpouse());
    },

    removeSpouse(index: number) {
      this.spouses.splice(index, 1);
    },

    async goStep(step: number) {
      const ok = await this.saveCurrentStep();
      if (ok) this.wizardStep = step;
    },

    async nextStep() {
      const ok = await this.saveCurrentStep();
      if (ok && this.wizardStep < this.wizardSteps.length - 1) {
        this.wizardStep += 1;
      }
    },

    prevStep() {
      if (this.wizardStep > 0) this.wizardStep -= 1;
    },

    /** Persist whichever step is currently active. Always saves (drafts are allowed
     * to be incomplete) but blocks advancing past a step with hard errors. */
    async saveCurrentStep() {
      if (!this.clientLocalId || !this.core) return false;
      this.wizardError = "";

      if (this.wizardStep === 0) {
        this.coreErrors = validateClientCore(this.core);
        await saveClientCore(this.clientLocalId, {
          account_number: this.core.account_number,
          first_name: this.core.first_name,
          middle_name: this.core.middle_name,
          surname: this.core.surname,
          dob: this.core.dob,
          sex: this.core.sex,
          marital_status: this.core.marital_status,
          nationality: this.core.nationality,
          state_id: numOrNull(this.core.state_id),
          city_id: numOrNull(this.core.city_id),
          residential_address: this.core.residential_address,
          employer_name_address: this.core.employer_name_address,
          phone_no: this.core.phone_no,
          email: this.core.email,
          means_of_identification: this.core.means_of_identification,
          id_number: this.core.id_number,
          nin: this.core.nin,
          bvn: this.core.bvn,
          account_category: this.core.account_category,
          purpose_of_account: this.core.purpose_of_account,
          applicant_signed_date: this.core.applicant_signed_date,
        });
        if (Object.keys(this.coreErrors).length > 0) return false;
        return true;
      }

      if (this.wizardStep === 1) {
        const kin = this.hasNextOfKin ? this.nextOfKin : null;
        this.nextOfKinErrors = validateNextOfKin(kin);
        if (Object.keys(this.nextOfKinErrors).length > 0) return false;
        await saveNextOfKin(this.clientLocalId, kin);
        return true;
      }

      if (this.wizardStep === 2) {
        const normalized = this.spouses.map((s) => ({
          ...s,
          pension_fund_administrator_id: numOrNull(s.pension_fund_administrator_id),
          equity_contribution: numOrNull(s.equity_contribution),
        }));
        await replaceSpouses(this.clientLocalId, normalized);
        return true;
      }

      if (this.wizardStep === 3) {
        this.refereeErrors = validateReferees(this.referees);
        await replaceReferees(this.clientLocalId, this.referees);
        return Object.keys(this.refereeErrors).length === 0;
      }

      if (this.wizardStep === 4) {
        // Entirely optional — every field is nullable server-side, so there's
        // nothing to block advancing on here, just numeric normalization
        // (see numOrNull) so an emptied number/select input persists as
        // `null` rather than `""`.
        await saveEquityApplication(this.clientLocalId, this.normalizedEquityApplication());
        return true;
      }

      return true;
    },

    /** Normalize the equity-application form state before it touches SQLite/the API. */
    normalizedEquityApplication(): EquityApplicationFields {
      const e = this.equityApplication;
      return {
        ...e,
        pension_fund_administrator_id: numOrNull(e.pension_fund_administrator_id),
        equity_per_applicant: numOrNull(e.equity_per_applicant),
        value_of_property: numOrNull(e.value_of_property),
        amount_of_equity_payable: numOrNull(e.amount_of_equity_payable),
        loan_amount: numOrNull(e.loan_amount),
        monthly_salary_income: numOrNull(e.monthly_salary_income),
      };
    },

    setEquityBoolField(field, value) {
      this.equityApplication[field] = value;
    },

    async submitClient() {
      if (!this.clientLocalId) return;
      this.saving = true;
      this.wizardError = "";
      try {
        const okCore = await this.saveCurrentStep();
        if (!this.core) return;

        this.coreErrors = validateClientCore(this.core);
        this.refereeErrors = validateReferees(this.referees);

        if (
          Object.keys(this.coreErrors).length > 0 ||
          Object.keys(this.refereeErrors).length > 0 ||
          !okCore
        ) {
          this.wizardError =
            "Please fix the highlighted fields before submitting — a client needs the required core fields and exactly 2 referees.";
          return;
        }

        // Persist final referee/next-of-kin/equity-application state
        // explicitly (in case the agent jumped here via a step tab without
        // visiting every prior step last). Equity-application fields are all
        // optional and never block submission either way.
        await replaceReferees(this.clientLocalId, this.referees);
        await saveNextOfKin(this.clientLocalId, this.hasNextOfKin ? this.nextOfKin : null);
        await saveEquityApplication(this.clientLocalId, this.normalizedEquityApplication());

        // Make sure there's an active outbox job even if a previous attempt
        // was marked failed_permanent (e.g. the agent just fixed a
        // validation error) — the sync engine re-checks readiness itself on
        // every pass (see sync-engine.ts hasBothReferees/hasRequiredCoreFields).
        await touchOutbox("client", this.clientLocalId);

        this.triggerSyncNow();
        this.screen = "dashboard";
        await this.loadClients();
      } finally {
        this.saving = false;
      }
    },

    syncBadge(client: LocalClient): { label: string; className: string } {
      switch (client.sync_status) {
        case "synced":
          return { label: "Synced", className: "bg-teal-400/15 text-teal-300" };
        case "syncing":
          return { label: "Syncing…", className: "bg-sky-400/15 text-sky-300" };
        case "failed":
          return { label: "Sync error", className: "bg-rose-400/15 text-rose-300" };
        default:
          return client.server_id === null
            ? { label: "Draft (not synced)", className: "bg-amber-400/15 text-amber-300" }
            : { label: "Pending sync", className: "bg-amber-400/15 text-amber-300" };
      }
    },
  };
}
