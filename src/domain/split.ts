import { validateMinorAmount, validateMoney, type Money } from "./money.ts";
import { failure, type Failure, type Result } from "./result.ts";

export type Allocation = {
  readonly memberId: string;
  readonly amountMinor: number;
};

type EqualBreakdown = {
  readonly baseMinor: number;
  /** The first this many eligible members receive one extra minor unit each. */
  readonly extraMinorUnits: number;
};

/** Fixed cover uses the bill's currency. Percentage cover uses 100 basis points per 1%. */
export type TreatCover =
  | { readonly kind: "fixed"; readonly amountMinor: number }
  | { readonly kind: "percentage"; readonly basisPoints: number };

export type TreatOptions = {
  readonly hostId: string;
  readonly cover: TreatCover;
  readonly includeHostInRemainder?: boolean;
};

export type SplitResult = {
  readonly total: Money;
  readonly allocations: readonly Allocation[];
  readonly allocationVersion: 1;
  readonly explanation:
    | ({ readonly kind: "equal" } & EqualBreakdown)
    | {
        readonly kind: "treat";
        readonly hostId: string;
        readonly cover: TreatCover;
        readonly coveredMinor: number;
        readonly remainderMinor: number;
        readonly includeHostInRemainder: boolean;
        readonly remainderSplit: EqualBreakdown;
      };
};

export type PersonalSpending = {
  readonly memberId: string;
  readonly personalMinor: number;
};

export type SharedSpending = {
  readonly amountMinor: number;
  readonly memberIds: readonly string[];
};

export type IndividualSplitResult = {
  readonly total: Money;
  readonly allocations: readonly (Allocation & {
    readonly personalMinor: number;
    readonly sharedMinor: number;
  })[];
  readonly allocationVersion: 1;
  readonly explanation: {
    readonly kind: "individual";
    readonly sharedTotalMinor: number;
    readonly sharedMemberIds: readonly string[];
    readonly sharedSplit: EqualBreakdown;
  };
};

export function validateMemberIds(
  memberIds: readonly string[],
  field: "memberIds" | "sharedMemberIds" | "allocations" = "memberIds",
): Failure | undefined {
  if (memberIds.length === 0) return failure("NO_PARTICIPANTS", field);

  const seen = new Set<string>();
  for (const memberId of memberIds) {
    if (typeof memberId !== "string" || memberId.trim() === "") {
      return failure("INVALID_MEMBER_ID", field);
    }
    if (seen.has(memberId)) return failure("DUPLICATE_MEMBER_ID", field);
    seen.add(memberId);
  }
}

function allocateEvenly(totalMinor: number, memberIds: readonly string[]) {
  const count = BigInt(memberIds.length);
  const total = BigInt(totalMinor);
  const baseMinor = count === 0n ? 0 : Number(total / count);
  const extraMinorUnits = count === 0n ? 0 : Number(total % count);

  // Equal weights have tied fractional remainders, so snapshot order breaks the tie.
  const allocations = memberIds.map((memberId, index): Allocation => ({
    memberId,
    amountMinor: baseMinor + (index < extraMinorUnits ? 1 : 0),
  }));
  return { allocations, breakdown: { baseMinor, extraMinorUnits } };
}

/** Pass participating IDs in their stable snapshot order. */
export function splitEqual(total: Money, memberIds: readonly string[]): Result<SplitResult> {
  const invalid = validateMoney(total, "total") ?? validateMemberIds(memberIds);
  if (invalid) return invalid;

  const { currency, amountMinor } = total;
  const { allocations, breakdown } = allocateEvenly(amountMinor, memberIds);
  return {
    ok: true,
    value: {
      total: { currency, amountMinor },
      allocations,
      allocationVersion: 1,
      explanation: { kind: "equal", ...breakdown },
    },
  };
}

function resolveCover(totalMinor: number, cover: TreatCover): Result<number> {
  if (cover.kind === "fixed") {
    const invalid = validateMinorAmount(cover.amountMinor, "cover");
    if (invalid) return invalid;
    return { ok: true, value: cover.amountMinor };
  }

  const { basisPoints } = cover;
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    return failure("INVALID_PERCENTAGE", "cover");
  }

  // Round a half minor unit up before allocating the remainder.
  const product = BigInt(totalMinor) * BigInt(basisPoints);
  return { ok: true, value: Number((product + 5_000n) / 10_000n) };
}

/** Calculates liability only. Pass participating IDs in their stable snapshot order. */
export function splitTreat(
  total: Money,
  memberIds: readonly string[],
  options: TreatOptions,
): Result<SplitResult> {
  const invalid = validateMoney(total, "total") ?? validateMemberIds(memberIds);
  if (invalid) return invalid;

  const { hostId, cover, includeHostInRemainder = false } = options;
  const hostIndex = memberIds.indexOf(hostId);
  if (hostIndex === -1) return failure("HOST_NOT_PARTICIPATING", "hostId");

  const { currency, amountMinor } = total;
  const covered = resolveCover(amountMinor, cover);
  if (!covered.ok) return covered;
  const coveredMinor = covered.value;
  if (coveredMinor > amountMinor) return failure("COVER_EXCEEDS_TOTAL", "cover");

  const remainderMinor = amountMinor - coveredMinor;
  const remainderIds = includeHostInRemainder ? memberIds : memberIds.filter((id) => id !== hostId);
  if (remainderMinor > 0 && remainderIds.length === 0) {
    return failure("NO_REMAINDER_PARTICIPANTS", "memberIds");
  }

  const { allocations, breakdown } = allocateEvenly(remainderMinor, remainderIds);
  if (includeHostInRemainder) {
    const hostAllocation = allocations[hostIndex];
    allocations[hostIndex] = {
      memberId: hostId,
      amountMinor: hostAllocation.amountMinor + coveredMinor,
    };
  } else {
    allocations.splice(hostIndex, 0, { memberId: hostId, amountMinor: coveredMinor });
  }

  return {
    ok: true,
    value: {
      total: { currency, amountMinor },
      allocations,
      allocationVersion: 1,
      explanation: {
        kind: "treat",
        hostId,
        cover: { ...cover },
        coveredMinor,
        remainderMinor,
        includeHostInRemainder,
        remainderSplit: breakdown,
      },
    },
  };
}

/** Pass one personal amount per member in stable snapshot order, including zero amounts. */
export function splitIndividual(
  total: Money,
  personalSpending: readonly PersonalSpending[],
  shared: SharedSpending,
): Result<IndividualSplitResult> {
  const memberIds = personalSpending.map(({ memberId }) => memberId);
  const invalid = validateMoney(total, "total")
    ?? validateMemberIds(memberIds)
    ?? validateMinorAmount(shared.amountMinor, "sharedAmount");
  if (invalid) return invalid;

  if (shared.amountMinor > 0 || shared.memberIds.length > 0) {
    const invalidSharedMembers = validateMemberIds(shared.memberIds, "sharedMemberIds");
    if (invalidSharedMembers) return invalidSharedMembers;
  }

  const selected = new Set(shared.memberIds);
  const sharedMemberIds = memberIds.filter((memberId) => selected.has(memberId));
  if (sharedMemberIds.length !== selected.size) {
    return failure("MEMBER_NOT_PARTICIPATING", "sharedMemberIds");
  }

  let spendingTotal = BigInt(shared.amountMinor);
  for (const { personalMinor } of personalSpending) {
    const invalidPersonal = validateMinorAmount(personalMinor, "personalSpending");
    if (invalidPersonal) return invalidPersonal;
    spendingTotal += BigInt(personalMinor);
  }

  const { currency, amountMinor } = total;
  if (spendingTotal > BigInt(Number.MAX_SAFE_INTEGER)) return failure("AMOUNT_OVERFLOW", "total");
  if (spendingTotal !== BigInt(amountMinor)) return failure("TOTAL_MISMATCH", "total");

  const { allocations: sharedAllocations, breakdown } = allocateEvenly(
    shared.amountMinor,
    sharedMemberIds,
  );
  const sharedByMember = new Map(sharedAllocations.map((share) => [share.memberId, share.amountMinor]));
  const allocations = personalSpending.map(({ memberId, personalMinor }) => {
    const sharedMinor = sharedByMember.get(memberId) ?? 0;
    return { memberId, personalMinor, sharedMinor, amountMinor: personalMinor + sharedMinor };
  });

  return {
    ok: true,
    value: {
      total: { currency, amountMinor },
      allocations,
      allocationVersion: 1,
      explanation: {
        kind: "individual",
        sharedTotalMinor: shared.amountMinor,
        sharedMemberIds,
        sharedSplit: breakdown,
      },
    },
  };
}
