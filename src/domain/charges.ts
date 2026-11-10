import { roundBasisPoints, validateMinorAmount, validateMoney, type Money } from "./money.ts";
import { failure, type Result } from "./result.ts";
import {
  allocateByWeight, validateMemberIds, type Allocation, type IndividualSplitResult, type ItemizedSplitResult, type SplitResult,
} from "./split.ts";

type ServiceFee =
  | { readonly kind: "manual"; readonly amountMinor: number; readonly basis?: never }
  | { readonly kind: "quick10"; readonly basis?: "beforeDiscount" | "afterDiscount"; readonly amountMinor?: never };

export type ChargeDistribution = { readonly kind: "equal" }
  | { readonly kind: "selected"; readonly memberIds: readonly string[] };

export type ChargeDetailsInput = {
  readonly kind: "details";
  readonly subtotal: Money;
  readonly discountMinor?: number;
  readonly serviceFee?: ServiceFee;
  readonly receiptTotal?: Money;
  readonly distribution?: { readonly serviceFee?: ChargeDistribution; readonly discount?: ChargeDistribution };
};

type FinalTotal = { readonly kind: "finalTotal"; readonly total: Money };
export type ChargeInput = FinalTotal | ChargeDetailsInput;

export type CalculatedChargeDetails = {
  readonly kind: "details";
  readonly subtotal: Money;
  readonly discountMinor: number;
  readonly serviceFeeMinor: number;
  readonly total: Money;
};

export type ChargedSplitResult = {
  readonly total: Money;
  readonly allocations: readonly (Allocation & {
    readonly baseMinor: number;
    readonly serviceFeeMinor: number;
    readonly discountMinor: number;
  })[];
  readonly allocationVersion: 1;
  readonly explanation: Exclude<SplitResult["explanation"], { kind: "treat" }>
    | IndividualSplitResult["explanation"] | ItemizedSplitResult["explanation"];
};

function calculateDetails(
  { subtotal, discountMinor = 0, serviceFee, receiptTotal }: ChargeDetailsInput,
): Result<CalculatedChargeDetails> {
  const invalid = validateMoney(subtotal, "subtotal") ?? validateMinorAmount(discountMinor, "discount");
  if (invalid) return invalid;
  if (discountMinor > subtotal.amountMinor) return failure("DISCOUNT_EXCEEDS_SUBTOTAL", "discount");

  const discountedMinor = subtotal.amountMinor - discountMinor;
  let serviceFeeMinor = 0;
  if (serviceFee?.kind === "manual") {
    if (serviceFee.basis !== undefined) return failure("SERVICE_FEE_CONFLICT", "serviceFee");
    const invalidFee = validateMinorAmount(serviceFee.amountMinor, "serviceFee");
    if (invalidFee) return invalidFee;
    serviceFeeMinor = serviceFee.amountMinor;
  } else if (serviceFee?.kind === "quick10") {
    if (serviceFee.amountMinor !== undefined) return failure("SERVICE_FEE_CONFLICT", "serviceFee");
    const { basis = "beforeDiscount" } = serviceFee;
    if (basis !== "beforeDiscount" && basis !== "afterDiscount") return failure("INVALID_SERVICE_FEE", "serviceFee");
    const basisMinor = basis === "beforeDiscount" ? subtotal.amountMinor : discountedMinor;
    serviceFeeMinor = roundBasisPoints(basisMinor, 1000);
  } else if (serviceFee !== undefined) {
    return failure("INVALID_SERVICE_FEE", "serviceFee");
  }

  const finalMinor = BigInt(discountedMinor) + BigInt(serviceFeeMinor);
  if (finalMinor > BigInt(Number.MAX_SAFE_INTEGER)) return failure("AMOUNT_OVERFLOW", "total");
  const total = { currency: subtotal.currency, amountMinor: Number(finalMinor) };
  if (receiptTotal !== undefined) {
    const invalidReceipt = validateMoney(receiptTotal, "receiptTotal");
    if (invalidReceipt) return invalidReceipt;
    if (receiptTotal.currency !== total.currency) return failure("CURRENCY_MISMATCH", "receiptTotal");
    if (receiptTotal.amountMinor !== total.amountMinor) return failure("TOTAL_MISMATCH", "receiptTotal");
  }

  return { ok: true, value: { kind: "details", subtotal: { ...subtotal }, discountMinor, serviceFeeMinor, total } };
}

export function calculateCharges(input: ChargeInput): Result<FinalTotal | CalculatedChargeDetails> {
  if (input.kind === "details") return calculateDetails(input);
  const invalid = validateMoney(input.total, "total");
  if (invalid) return invalid;
  return { ok: true, value: { kind: "finalTotal", total: { ...input.total } } };
}

/** Apply details to a split of the subtotal. For a treat, pass the calculated final total to splitTreat. */
export function allocateCharges(
  base: SplitResult | IndividualSplitResult | ItemizedSplitResult,
  details: ChargeDetailsInput,
): Result<ChargedSplitResult> {
  const { explanation } = base;
  if (explanation.kind === "treat") return failure("CHARGE_ALLOCATION_UNSUPPORTED", "charges");

  const calculated = calculateDetails(details);
  if (!calculated.ok) return calculated;
  const { subtotal, discountMinor, serviceFeeMinor, total } = calculated.value;
  const invalid = validateMoney(base.total, "subtotal")
    ?? validateMemberIds(base.allocations.map(({ memberId }) => memberId), "allocations");
  if (invalid) return invalid;
  if (base.total.currency !== subtotal.currency) return failure("CURRENCY_MISMATCH", "subtotal");
  if (base.total.amountMinor !== subtotal.amountMinor) return failure("TOTAL_MISMATCH", "subtotal");

  const weights: number[] = [];
  let weightTotal = 0n;
  for (const { amountMinor } of base.allocations) {
    const invalidAmount = validateMinorAmount(amountMinor, "allocations");
    if (invalidAmount) return invalidAmount;
    weights.push(amountMinor);
    weightTotal += BigInt(amountMinor);
  }
  if (weightTotal > BigInt(Number.MAX_SAFE_INTEGER)) return failure("AMOUNT_OVERFLOW", "allocations");
  if (weightTotal !== BigInt(subtotal.amountMinor)) return failure("TOTAL_MISMATCH", "allocations");
  const participantIds = base.allocations.map(({ memberId }) => memberId);
  function distribute(amountMinor: number, rule: ChargeDistribution | undefined): Result<number[]> {
    if (rule === undefined) {
      if (weightTotal === 0n && amountMinor > 0) return failure("NO_CHARGE_WEIGHTS", "charges");
      return { ok: true, value: allocateByWeight(amountMinor, weights) };
    }
    if (rule.kind === "equal") return { ok: true, value: allocateByWeight(amountMinor, weights.map(() => 1)) };
    if (rule.kind !== "selected" || !Array.isArray(rule.memberIds)) return failure("INVALID_QUICK_INPUT", "chargeDistribution");
    const invalidSelection = validateMemberIds(rule.memberIds);
    if (invalidSelection) return failure(invalidSelection.error.code, "chargeDistribution");
    const selected = new Set(rule.memberIds);
    if (rule.memberIds.some((id) => !participantIds.includes(id))) return failure("MEMBER_NOT_PARTICIPATING", "chargeDistribution");
    return { ok: true, value: allocateByWeight(amountMinor, participantIds.map((id) => selected.has(id) ? 1 : 0)) };
  }
  const fees = distribute(serviceFeeMinor, details.distribution?.serviceFee);
  if (!fees.ok) return fees;
  const discounts = distribute(discountMinor, details.distribution?.discount);
  if (!discounts.ok) return discounts;
  const allocations: ChargedSplitResult["allocations"][number][] = [];
  for (const [index, { memberId, amountMinor: baseMinor }] of base.allocations.entries()) {
    const serviceFeeMinor = fees.value[index];
    const discountMinor = discounts.value[index];
    const adjusted = BigInt(baseMinor) - BigInt(discountMinor) + BigInt(serviceFeeMinor);
    if (adjusted < 0n) return failure("CHARGE_SHARE_NEGATIVE", "chargeDistribution");
    if (adjusted > BigInt(Number.MAX_SAFE_INTEGER)) return failure("AMOUNT_OVERFLOW", "chargeDistribution");
    allocations.push({ memberId, baseMinor, serviceFeeMinor, discountMinor, amountMinor: Number(adjusted) });
  }
  return { ok: true, value: { total, allocations, allocationVersion: base.allocationVersion, explanation } };
}
