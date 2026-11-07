import type { MerchantRefund } from "./balance.ts";
import { validateMinorAmount } from "./money.ts";
import { failure, type Result } from "./result.ts";
import { allocateByWeight, type Allocation } from "./split.ts";

export function summarizeExpenseRefunds(refunds: readonly MerchantRefund[]) {
  const reductions = new Map<string, number>();
  let amountMinor = 0;
  for (const refund of refunds) {
    amountMinor += refund.amountMinor;
    for (const reduction of refund.reductions) {
      reductions.set(reduction.memberId, (reductions.get(reduction.memberId) ?? 0) + reduction.amountMinor);
    }
  }
  return { amountMinor, reductions };
}

export function remainingRefundShares(allocations: readonly Allocation[], refunds: readonly MerchantRefund[]) {
  const { reductions } = summarizeExpenseRefunds(refunds);
  return allocations.map(({ memberId, amountMinor }) => ({ memberId, amountMinor: amountMinor - (reductions.get(memberId) ?? 0) }));
}

export function allocateProportionalRefund(amountMinor: number, shares: readonly Allocation[]): Result<Allocation[]> {
  const invalid = validateMinorAmount(amountMinor, "merchantRefund");
  if (invalid) return invalid;
  if (amountMinor === 0) return failure("NON_POSITIVE_AMOUNT", "merchantRefund");
  const weights = shares.map((share) => share.amountMinor);
  if (weights.some((weight) => validateMinorAmount(weight, "refundReductions"))) {
    return failure("REFUND_REDUCTION_EXCEEDS_ALLOCATION", "refundReductions");
  }
  if (BigInt(amountMinor) > weights.reduce((sum, weight) => sum + BigInt(weight), 0n)) {
    return failure("REFUND_EXCEEDS_EXPENSE", "merchantRefund");
  }
  const reductions = allocateByWeight(amountMinor, weights);
  return { ok: true, value: shares.flatMap(({ memberId }, index) => reductions[index] > 0
    ? [{ memberId, amountMinor: reductions[index] }] : []) };
}
