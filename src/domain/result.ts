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
  | "NO_REMAINDER_PARTICIPANTS"
  | "MEMBER_NOT_PARTICIPATING"
  | "TOTAL_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "INVALID_EXPENSE_ID"
  | "DUPLICATE_EXPENSE_ID"
  | "MISSING_MERCHANT_PAYMENT"
  | "INVALID_EVENT_TYPE"
  | "INVALID_EVENT_ID"
  | "DUPLICATE_EVENT_ID"
  | "NON_POSITIVE_AMOUNT"
  | "EXPENSE_NOT_FOUND"
  | "REFUND_EXCEEDS_EXPENSE"
  | "REFUND_REDUCTION_EXCEEDS_ALLOCATION"
  | "SELF_TRANSFER"
  | "TRANSFER_EXCEEDS_BALANCE";

type ErrorField =
  | "currency"
  | "amount"
  | "total"
  | "memberIds"
  | "hostId"
  | "cover"
  | "personalSpending"
  | "sharedAmount"
  | "sharedMemberIds"
  | "expenseId"
  | "merchantPayment"
  | "allocations"
  | "events"
  | "eventId"
  | "merchantRefund"
  | "refundReductions"
  | "memberTransfer";

export type Failure = {
  readonly ok: false;
  readonly error: { readonly code: DomainErrorCode; readonly field: ErrorField };
};

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

export function failure(code: DomainErrorCode, field: ErrorField): Failure {
  return { ok: false, error: { code, field } };
}
