export type DomainErrorCode =
  | "UNSUPPORTED_CURRENCY"
  | "INVALID_AMOUNT"
  | "INVALID_AMOUNT_PRECISION"
  | "NEGATIVE_AMOUNT"
  | "AMOUNT_OVERFLOW"
  | "NO_PARTICIPANTS"
  | "INVALID_MEMBER_ID"
  | "DUPLICATE_MEMBER_ID"
  | "HOST_NOT_PARTICIPATING"
  | "INVALID_PERCENTAGE"
  | "COVER_EXCEEDS_TOTAL"
  | "NO_REMAINDER_PARTICIPANTS";

type ErrorField = "currency" | "amount" | "total" | "memberIds" | "hostId" | "cover";

export type Failure = {
  readonly ok: false;
  readonly error: { readonly code: DomainErrorCode; readonly field: ErrorField };
};

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

export function failure(code: DomainErrorCode, field: ErrorField): Failure {
  return { ok: false, error: { code, field } };
}
