/**
 * Client-side validation mirroring the backend's `ClientRequest` rules
 * (`app/Http/Requests/Api/V1/ClientRequest.php` in `realtor-web`), so a
 * field agent gets the same feedback offline that they'd eventually get
 * from the server — required fields, exactly 2 distinct referees, and the
 * 11-digit NIN/BVN checks — without ever calling the network to get it.
 *
 * Records are allowed to be saved locally at any completeness level (they're
 * drafts); these checks only gate whether a record is *ready to sync* as a
 * create, surfaced by the wizard as step-level errors and an overall
 * "ready to submit" flag.
 */
import type {
  LocalClientWithRelations,
  NextOfKinFields,
  RefereeFields,
} from "./types";

export type FieldErrors = Record<string, string>;

const DIGITS_11 = /^\d{11}$/;

export function validateClientCore(
  client: Pick<
    LocalClientWithRelations,
    "first_name" | "surname" | "phone_no" | "nin" | "bvn" | "email"
  >,
): FieldErrors {
  const errors: FieldErrors = {};

  if (!client.first_name || client.first_name.trim().length === 0) {
    errors.first_name = "First name is required.";
  }
  if (!client.surname || client.surname.trim().length === 0) {
    errors.surname = "Surname is required.";
  }
  if (!client.phone_no || client.phone_no.trim().length === 0) {
    errors.phone_no = "Phone number is required.";
  }
  if (client.nin && !DIGITS_11.test(client.nin)) {
    errors.nin = "NIN must be exactly 11 digits.";
  }
  if (client.bvn && !DIGITS_11.test(client.bvn)) {
    errors.bvn = "BVN must be exactly 11 digits.";
  }
  if (client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email)) {
    errors.email = "Enter a valid email address.";
  }

  return errors;
}

/** Next-of-kin is optional as a whole, but if any field is filled the required ones must be too. */
export function validateNextOfKin(kin: NextOfKinFields | null): FieldErrors {
  if (!kin) return {};
  const errors: FieldErrors = {};
  if (!kin.name || kin.name.trim().length === 0) {
    errors.name = "Name is required.";
  }
  if (!kin.relationship || kin.relationship.trim().length === 0) {
    errors.relationship = "Relationship is required.";
  }
  if (!kin.phone || kin.phone.trim().length === 0) {
    errors.phone = "Phone number is required.";
  }
  return errors;
}

export function validateReferees(referees: RefereeFields[]): FieldErrors {
  const errors: FieldErrors = {};

  if (referees.length !== 2) {
    errors.count = "Exactly 2 referees are required.";
  }

  const numbers = referees.map((r) => r.referee_number);
  if (new Set(numbers).size !== numbers.length) {
    errors.referee_number = "Referee numbers must be distinct (1 and 2).";
  }
  if (!numbers.includes(1) || (referees.length === 2 && !numbers.includes(2))) {
    errors.referee_number = "Referees must be numbered 1 and 2.";
  }

  referees.forEach((r, i) => {
    if (!r.referee_name || r.referee_name.trim().length === 0) {
      errors[`referee_${i}_name`] = `Referee ${i + 1} name is required.`;
    }
  });

  return errors;
}

export function isReadyToSubmit(client: LocalClientWithRelations): boolean {
  const coreErrors = validateClientCore(client);
  const refereeErrors = validateReferees(client.referees);
  return (
    Object.keys(coreErrors).length === 0 && Object.keys(refereeErrors).length === 0
  );
}
