import { failure, type Failure, type Result } from "./result.ts";

const minorDigits = { HKD: 2, CNY: 2, MOP: 2, TWD: 2, USD: 2, JPY: 0 } as const;

export type Currency = keyof typeof minorDigits;

export type Money = {
  readonly currency: Currency;
  readonly amountMinor: number;
};

type AmountField = "amount" | "total" | "cover" | "personalSpending" | "sharedAmount";

function isCurrency(currency: unknown): currency is Currency {
  return typeof currency === "string" && Object.prototype.hasOwnProperty.call(minorDigits, currency);
}

export function validateMinorAmount(amountMinor: number, field: AmountField): Failure | undefined {
  if (!Number.isInteger(amountMinor)) return failure("INVALID_AMOUNT", field);
  if (amountMinor < 0) return failure("NEGATIVE_AMOUNT", field);
  if (!Number.isSafeInteger(amountMinor)) return failure("AMOUNT_OVERFLOW", field);
}

export function validateMoney(money: Money, field: AmountField): Failure | undefined {
  if (!isCurrency(money.currency)) return failure("UNSUPPORTED_CURRENCY", "currency");
  return validateMinorAmount(money.amountMinor, field);
}

/** Accepts a whole part with optional fractional digits, using an ASCII decimal point. */
export function parseAmount(input: string, currency: string): Result<Money> {
  if (!isCurrency(currency)) return failure("UNSUPPORTED_CURRENCY", "currency");
  if (typeof input !== "string") return failure("INVALID_AMOUNT", "amount");

  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(input);
  if (!match) return failure("INVALID_AMOUNT", "amount");
  const [, sign, whole, fraction = ""] = match;
  if (sign === "-") return failure("NEGATIVE_AMOUNT", "amount");

  const digits = minorDigits[currency];
  if (fraction.length > digits) return failure("INVALID_AMOUNT_PRECISION", "amount");

  const amountMinor = Number(whole + fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(amountMinor)) return failure("AMOUNT_OVERFLOW", "amount");
  return { ok: true, value: { currency, amountMinor } };
}

/** Formats a fixed-scale decimal string for the currency, without locale or symbol. */
export function formatAmount(money: Money): Result<string> {
  const invalid = validateMoney(money, "amount");
  if (invalid) return invalid;

  const digits = minorDigits[money.currency];
  const amount = String(money.amountMinor).padStart(digits + 1, "0");
  const formatted = digits === 0
    ? amount
    : `${amount.slice(0, -digits)}.${amount.slice(-digits)}`;
  return { ok: true, value: formatted };
}
