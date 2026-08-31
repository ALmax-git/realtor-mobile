/**
 * Shared TypeScript shapes for the offline client-intake feature.
 *
 * Field names deliberately mirror the `realtor-web` API contract
 * (snake_case, matching `ClientRequest`/`EquityApplicationRequest`) rather
 * than being translated to camelCase, so a local record can be serialized
 * to a sync payload with no field-mapping step to get wrong. Local-only
 * bookkeeping fields (sync status, local ids, dirty flags) are kept
 * separate from the API-shaped fields so it's obvious at a glance which
 * fields travel over the wire and which never leave the device.
 */

export type SyncStatus = "pending" | "syncing" | "synced" | "failed";

export type Sex = "male" | "female";
export type MaritalStatus = "single" | "married" | "divorced" | "widowed";
export type MeansOfIdentification =
  | "nimc"
  | "voters_card"
  | "international_passport";
export type AccountCategory = "current" | "savings";
export type MortgageOfferType = "single" | "joint";

/** The API-shaped fields of a client — what actually gets POSTed/PUT. */
export interface ClientFields {
  account_number: string | null;
  first_name: string;
  middle_name: string | null;
  surname: string;
  dob: string | null;
  sex: Sex | null;
  marital_status: MaritalStatus | null;
  nationality: string | null;
  state_id: number | null;
  city_id: number | null;
  residential_address: string | null;
  employer_name_address: string | null;
  phone_no: string;
  email: string | null;
  means_of_identification: MeansOfIdentification | null;
  id_number: string | null;
  nin: string | null;
  bvn: string | null;
  account_category: AccountCategory | null;
  purpose_of_account: string | null;
  applicant_signed_date: string | null;
}

export interface NextOfKinFields {
  name: string;
  relationship: string;
  phone: string;
  dob: string | null;
  address: string | null;
  email: string | null;
  occupation: string | null;
  work_address: string | null;
}

export interface SpouseFields {
  name: string;
  dob: string | null;
  relationship: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  occupation: string | null;
  work_address: string | null;
  pin: string | null;
  pension_fund_administrator_id: number | null;
  equity_contribution: number | null;
}

export interface RefereeFields {
  referee_number: 1 | 2;
  referee_name: string;
  known_period: string | null;
  current_account_with: string | null;
  suitability_comment: string | null;
  bank_name_address: string | null;
  referee_account_number: string | null;
}

export interface EquityApplicationFields {
  pension_fund_administrator_id: number | null;
  pin: string | null;
  mortgage_lender_name: string | null;
  mortgage_lender_address: string | null;
  property_type: string | null;
  property_type_address: string | null;
  mortgage_offer_type: MortgageOfferType | null;
  evidence_of_marriage: boolean | null;
  equity_per_applicant: number | null;
  mortgage_account_number: string | null;
  value_of_property: number | null;
  amount_of_equity_payable: number | null;
  is_owner_occupier: boolean | null;
  occupation: string | null;
  date_employed: string | null;
  office_address: string | null;
  present_position: string | null;
  telephone_no: string | null;
  supplementary_mortgage_lender: string | null;
  purpose_of_loan: string | null;
  loan_amount: number | null;
  repayment_period: string | null;
  monthly_salary_income: number | null;
  source_of_loan_repayment: string | null;
  declaration_date: string | null;
}

/** Local sync bookkeeping shared by clients and equity applications. */
export interface SyncMeta {
  server_id: number | null;
  sync_status: SyncStatus;
  sync_error: string | null;
  is_dirty: boolean;
  local_rev: number;
}

export interface LocalNextOfKin extends NextOfKinFields {
  local_id: string;
  client_local_id: string;
}

export interface LocalSpouse extends SpouseFields {
  local_id: string;
  client_local_id: string;
  sequence: number;
}

export interface LocalReferee extends RefereeFields {
  local_id: string;
  client_local_id: string;
}

export interface LocalEquityApplication
  extends EquityApplicationFields,
    SyncMeta {
  client_local_id: string;
  updated_at: string;
}

export interface LocalClient extends ClientFields, SyncMeta {
  local_id: string;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** A client with all nested relations loaded — the shape the wizard/UI work with. */
export interface LocalClientWithRelations extends LocalClient {
  next_of_kin: LocalNextOfKin | null;
  spouses: LocalSpouse[];
  referees: LocalReferee[];
  equity_application: LocalEquityApplication | null;
}

export interface LookupState {
  id: number;
  name: string;
}

export interface LookupCity {
  id: number;
  state_id: number;
  name: string;
}

export interface LookupPfa {
  id: number;
  name: string;
  code: string | null;
}

/** Overall sync-engine status surfaced to the UI status indicator. */
export interface SyncSummary {
  state: "idle" | "syncing" | "offline";
  pendingCount: number;
  failedCount: number;
  lastError: string | null;
  lastSyncedAt: string | null;
}
