/**
 * Backend enum values for client/equity-application dropdowns.
 *
 * Values below were confirmed against `app/Enums/*.php` in the sibling
 * `realtor-web` repo (Sex, MaritalStatus, MeansOfIdentification,
 * AccountCategory, MortgageOfferType) so the wizard sends strings the
 * Laravel `Enum` validation rule actually accepts, rather than guesses.
 * If those backend enums change, update the value lists here to match —
 * the labels are free to change independently.
 */

export interface EnumOption<T extends string> {
  value: T;
  label: string;
}

export const SEX_OPTIONS: EnumOption<"male" | "female">[] = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
];

export const MARITAL_STATUS_OPTIONS: EnumOption<
  "single" | "married" | "divorced" | "widowed"
>[] = [
  { value: "single", label: "Single" },
  { value: "married", label: "Married" },
  { value: "divorced", label: "Divorced" },
  { value: "widowed", label: "Widowed" },
];

export const MEANS_OF_IDENTIFICATION_OPTIONS: EnumOption<
  "nimc" | "voters_card" | "international_passport"
>[] = [
  { value: "nimc", label: "NIMC (National ID)" },
  { value: "voters_card", label: "Voter's Card" },
  { value: "international_passport", label: "International Passport" },
];

export const ACCOUNT_CATEGORY_OPTIONS: EnumOption<"current" | "savings">[] = [
  { value: "current", label: "Current" },
  { value: "savings", label: "Savings" },
];

export const MORTGAGE_OFFER_TYPE_OPTIONS: EnumOption<"single" | "joint">[] = [
  { value: "single", label: "Single" },
  { value: "joint", label: "Joint" },
];
