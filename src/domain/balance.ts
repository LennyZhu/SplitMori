import { isCurrency, validateMinorAmount, validateMoney, type Currency, type Money } from "./money.ts";
import { failure, type Result } from "./result.ts";
import { validateMemberIds, type SplitResult } from "./split.ts";

export type MerchantPayment = Money & { readonly memberId: string };

export type Expense = {
  readonly id: string;
  readonly split: Pick<SplitResult, "total" | "allocations">;
  readonly merchantPayment: MerchantPayment;
};

export type MemberBalance = {
  readonly memberId: string;
  readonly merchantPaidMinor: number;
  readonly allocatedMinor: number;
  /** Positive means receivable, negative means payable. */
  readonly netBalanceMinor: number;
};

export type ActivityBalances = {
  readonly currency: Currency;
  readonly balances: readonly MemberBalance[];
};

const maxMinor = BigInt(Number.MAX_SAFE_INTEGER);

/** Calculates original expense balances for every activity member in input order. */
export function calculateBalances(
  currency: Currency,
  memberIds: readonly string[],
  expenses: readonly Expense[],
): Result<ActivityBalances> {
  if (!isCurrency(currency)) return failure("UNSUPPORTED_CURRENCY", "currency");
  const invalidMembers = validateMemberIds(memberIds);
  if (invalidMembers) return invalidMembers;

  const members = new Map(memberIds.map((id) => [id, { merchantPaid: 0n, allocated: 0n }]));
  const expenseIds = new Set<string>();
  let activityTotal = 0n;

  for (const { id, split, merchantPayment } of expenses) {
    if (typeof id !== "string" || id.trim() === "") return failure("INVALID_EXPENSE_ID", "expenseId");
    if (expenseIds.has(id)) return failure("DUPLICATE_EXPENSE_ID", "expenseId");
    expenseIds.add(id);

    const { total, allocations } = split;
    const invalidTotal = validateMoney(total, "total");
    if (invalidTotal) return invalidTotal;
    if (total.currency !== currency) return failure("CURRENCY_MISMATCH", "currency");
    const gross = BigInt(total.amountMinor);

    if (!merchantPayment) return failure("MISSING_MERCHANT_PAYMENT", "merchantPayment");
    const invalidPayment = validateMoney(merchantPayment, "merchantPayment");
    if (invalidPayment) return invalidPayment;
    if (merchantPayment.currency !== currency) return failure("CURRENCY_MISMATCH", "merchantPayment");
    const payer = members.get(merchantPayment.memberId);
    if (!payer) return failure("MEMBER_NOT_PARTICIPATING", "merchantPayment");
    if (merchantPayment.amountMinor !== total.amountMinor) {
      return failure("TOTAL_MISMATCH", "merchantPayment");
    }

    const invalidAllocations = validateMemberIds(
      allocations.map(({ memberId }) => memberId),
      "allocations",
    );
    if (invalidAllocations) return invalidAllocations;

    let allocatedTotal = 0n;
    for (const { memberId, amountMinor } of allocations) {
      const member = members.get(memberId);
      if (!member) return failure("MEMBER_NOT_PARTICIPATING", "allocations");
      const invalidAmount = validateMinorAmount(amountMinor, "allocations");
      if (invalidAmount) return invalidAmount;

      const share = BigInt(amountMinor);
      allocatedTotal += share;
      member.allocated += share;
    }
    if (allocatedTotal > maxMinor) return failure("AMOUNT_OVERFLOW", "allocations");
    if (allocatedTotal !== gross) return failure("TOTAL_MISMATCH", "allocations");

    activityTotal += gross;
    if (activityTotal > maxMinor) return failure("AMOUNT_OVERFLOW", "total");
    payer.merchantPaid += BigInt(merchantPayment.amountMinor);
  }

  // Matching payment and allocation totals make the balances zero-sum.
  // Each amount fits within the checked activity total before converting back to number.
  const balances = Array.from(members, ([memberId, { merchantPaid, allocated }]): MemberBalance => ({
    memberId,
    merchantPaidMinor: Number(merchantPaid),
    allocatedMinor: Number(allocated),
    netBalanceMinor: Number(merchantPaid - allocated),
  }));
  return { ok: true, value: { currency, balances } };
}
