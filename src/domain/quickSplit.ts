import { calculateBalances } from "./balance.ts";
import { allocateCharges, calculateCharges, type ChargeInput, type ChargedSplitResult } from "./charges.ts";
import { failure, type Result } from "./result.ts";
import { suggestTransfers, type TransferSuggestion } from "./settlement.ts";
import {
  splitCustom, splitEqual, splitIndividual, splitItemized, splitMultiTreat, splitTreat, validateMemberIds, type CustomSplitOptions,
  type CustomSplitResult, type IndividualSplitResult, type ItemizedSplitResult, type ItemSpending, type PersonalSpending, type SharedSpending,
  type SplitResult, type TreatOptions,
} from "./split.ts";

export type QuickSplitMethod =
  | { readonly kind: "equal"; readonly memberIds: readonly string[] }
  | { readonly kind: "treat"; readonly memberIds: readonly string[]; readonly options: TreatOptions | { readonly hosts: readonly TreatOptions[] } }
  | { readonly kind: "individual"; readonly personalSpending: readonly PersonalSpending[]; readonly shared: SharedSpending }
  | { readonly kind: "individual"; readonly memberIds: readonly string[]; readonly items: readonly ItemSpending[] }
  | { readonly kind: "custom"; readonly options: CustomSplitOptions };

export type QuickSplitMember = { readonly id: string; readonly displayName: string };

export type QuickSplitInput = {
  readonly members: readonly QuickSplitMember[];
  readonly charges: ChargeInput;
  readonly method: QuickSplitMethod;
  /** If present, this member paid the whole bill to the merchant. */
  readonly merchantPayerId?: string;
};

type QuickAllocation = SplitResult | IndividualSplitResult | ItemizedSplitResult | CustomSplitResult | ChargedSplitResult;

export type QuickSplitSnapshot = {
  readonly split: QuickAllocation;
  readonly suggestions: readonly TransferSuggestion[];
};

export function usesAdvancedSplit({ method, charges }: QuickSplitInput): boolean {
  return method.kind === "custom" || (method.kind === "treat" && "hosts" in method.options)
    || (method.kind === "individual" && "items" in method) || (charges.kind === "details" && charges.distribution !== undefined);
}

function calculateAllocation({ charges, method }: QuickSplitInput): Result<QuickAllocation> {
  if (charges.kind !== "details" && charges.kind !== "finalTotal") {
    return failure("INVALID_QUICK_INPUT", "quickInput");
  }
  const calculated = calculateCharges(charges);
  if (!calculated.ok) return calculated;
  const { total } = calculated.value;
  const subtotal = charges.kind === "details" ? charges.subtotal : total;
  if (charges.kind === "details" && charges.distribution !== undefined
    && (method.kind === "treat" || method.kind === "custom")) return failure("CHARGE_ALLOCATION_UNSUPPORTED", "chargeDistribution");

  switch (method.kind) {
    case "treat":
      return "hosts" in method.options ? splitMultiTreat(total, method.memberIds, method.options.hosts)
        : splitTreat(total, method.memberIds, method.options);
    case "custom":
      return splitCustom(total, method.options);
    case "equal": {
      const split = splitEqual(subtotal, method.memberIds);
      return split.ok && charges.kind === "details" ? allocateCharges(split.value, charges) : split;
    }
    case "individual": {
      const split = "items" in method ? splitItemized(subtotal, method.memberIds, method.items)
        : splitIndividual(subtotal, method.personalSpending, method.shared);
      return split.ok && charges.kind === "details" ? allocateCharges(split.value, charges) : split;
    }
    default:
      return failure("INVALID_QUICK_INPUT", "quickInput");
  }
}

export function calculateQuickSplit(input: QuickSplitInput): Result<QuickSplitSnapshot> {
  const memberIds = input.members.map(({ id }) => id);
  const invalidMembers = validateMemberIds(memberIds);
  if (invalidMembers) return invalidMembers;
  if (input.members.some(({ displayName }) => typeof displayName !== "string" || displayName.trim() === "")) {
    return failure("INVALID_QUICK_INPUT", "quickInput");
  }

  const split = calculateAllocation(input);
  if (!split.ok) return split;
  const members = new Set(memberIds);
  if (split.value.allocations.some(({ memberId }) => !members.has(memberId))) {
    return failure("MEMBER_NOT_PARTICIPATING", "allocations");
  }
  const { merchantPayerId } = input;
  if (merchantPayerId === undefined) return { ok: true, value: { split: split.value, suggestions: [] } };

  const balances = calculateBalances(split.value.total.currency, memberIds, [{
    id: "quick-preview", split: split.value, merchantPayment: { memberId: merchantPayerId, ...split.value.total },
  }]);
  if (!balances.ok) return balances;
  const suggestions = suggestTransfers(balances.value);
  if (!suggestions.ok) return suggestions;
  return { ok: true, value: { split: split.value, suggestions: suggestions.value } };
}
