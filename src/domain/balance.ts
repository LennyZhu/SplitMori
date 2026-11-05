import { isCurrency, validateMinorAmount, validateMoney, type Currency, type Money } from "./money.ts";
import { failure, type Failure, type Result } from "./result.ts";
import { validateMemberIds, type Allocation, type SplitResult } from "./split.ts";

export type MerchantPayment = Money & { readonly memberId: string };

export type Expense = {
  readonly id: string;
  readonly split: Pick<SplitResult, "total" | "allocations">;
  readonly merchantPayment: MerchantPayment;
};

export type MerchantRefund = Money & {
  readonly kind: "merchantRefund";
  readonly id: string;
  readonly expenseId: string;
  readonly recipientId: string;
  readonly reductions: readonly Allocation[];
};

export type MemberTransfer = Money & {
  readonly kind: "memberTransfer";
  readonly id: string;
  readonly fromMemberId: string;
  readonly toMemberId: string;
};

export type ExpenseRevisionEvent = { readonly kind: "expenseRevision"; readonly expense: Expense };

export type FinancialVoid = {
  readonly kind: "financialVoid";
  readonly id: string;
  readonly targetEventId: string;
  readonly targetKind: "merchantRefund" | "memberTransfer";
};

export type BalanceEvent = MerchantRefund | MemberTransfer | ExpenseRevisionEvent | FinancialVoid | {
  readonly kind: "expense";
  readonly expense: Expense;
};

export type MemberBalance = {
  readonly memberId: string;
  readonly merchantPaidMinor: number;
  /** Current share after any refund reductions. */
  readonly allocatedMinor: number;
  /** Positive means receivable, negative means payable. */
  readonly netBalanceMinor: number;
};

export type ActivityBalances = {
  readonly currency: Currency;
  readonly balances: readonly MemberBalance[];
};

export type MemberEventBalance = MemberBalance & {
  readonly merchantRefundReceivedMinor: number;
  readonly transferSentMinor: number;
  readonly transferReceivedMinor: number;
};

export type ActivityEventBalances = {
  readonly currency: Currency;
  readonly balances: readonly MemberEventBalance[];
  readonly effectiveExpenses: readonly { readonly expenseId: string; readonly effectiveTotalMinor: number }[];
};

type MemberTotals = {
  merchantPaid: bigint;
  refundReceived: bigint;
  allocated: bigint;
  transferSent: bigint;
  transferReceived: bigint;
};

type ExpenseTotals = {
  readonly gross: bigint;
  readonly payerId: string;
  readonly remainingAllocations: Map<string, bigint>;
  readonly refunds: MerchantRefund[];
  refunded: bigint;
};

const maxMinor = BigInt(Number.MAX_SAFE_INTEGER);

function netBalance(member: MemberTotals): bigint {
  return member.merchantPaid - member.refundReceived - member.allocated
    + member.transferSent - member.transferReceived;
}

function applyExpense(
  currency: Currency,
  members: ReadonlyMap<string, MemberTotals>,
  { split, merchantPayment }: Expense,
): Result<ExpenseTotals> {
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

  const remainingAllocations = new Map<string, bigint>();
  let allocatedTotal = 0n;
  for (const { memberId, amountMinor } of allocations) {
    const member = members.get(memberId);
    if (!member) return failure("MEMBER_NOT_PARTICIPATING", "allocations");
    const invalidAmount = validateMinorAmount(amountMinor, "allocations");
    if (invalidAmount) return invalidAmount;

    const share = BigInt(amountMinor);
    remainingAllocations.set(memberId, share);
    allocatedTotal += share;
    member.allocated += share;
  }
  if (allocatedTotal > maxMinor) return failure("AMOUNT_OVERFLOW", "allocations");
  if (allocatedTotal !== gross) return failure("TOTAL_MISMATCH", "allocations");

  payer.merchantPaid += BigInt(merchantPayment.amountMinor);
  return {
    ok: true,
    value: { gross, payerId: merchantPayment.memberId, remainingAllocations, refunds: [], refunded: 0n },
  };
}

function applyRefund(
  members: ReadonlyMap<string, MemberTotals>,
  expenses: ReadonlyMap<string, ExpenseTotals>,
  refund: MerchantRefund,
): Failure | undefined {
  const expense = expenses.get(refund.expenseId);
  if (!expense) return failure("EXPENSE_NOT_FOUND", "expenseId");
  const recipient = members.get(refund.recipientId);
  if (!recipient) return failure("MEMBER_NOT_PARTICIPATING", "merchantRefund");

  const amount = BigInt(refund.amountMinor);
  if (expense.refunded + amount > expense.gross) return failure("REFUND_EXCEEDS_EXPENSE", "merchantRefund");
  const reductions = refund.reductions ?? [];
  const invalidReductions = validateMemberIds(
    reductions.map(({ memberId }) => memberId),
    "refundReductions",
  );
  if (invalidReductions) return invalidReductions;

  let reductionTotal = 0n;
  for (const { memberId, amountMinor } of reductions) {
    const member = members.get(memberId);
    const remaining = expense.remainingAllocations.get(memberId);
    if (!member || remaining === undefined) return failure("MEMBER_NOT_PARTICIPATING", "refundReductions");
    const invalidAmount = validateMinorAmount(amountMinor, "refundReductions");
    if (invalidAmount) return invalidAmount;
    const reduction = BigInt(amountMinor);
    if (reduction > remaining) return failure("REFUND_REDUCTION_EXCEEDS_ALLOCATION", "refundReductions");

    reductionTotal += reduction;
    expense.remainingAllocations.set(memberId, remaining - reduction);
    member.allocated -= reduction;
  }
  if (reductionTotal !== amount) return failure("TOTAL_MISMATCH", "refundReductions");

  expense.refunded += amount;
  expense.refunds.push(refund);
  recipient.refundReceived += amount;
}

function carryRefundsForward(
  members: ReadonlyMap<string, MemberTotals>, expenses: ReadonlyMap<string, ExpenseTotals>, previous: ExpenseTotals,
): Failure | undefined {
  // Remove the old effective expense and reapply its refunds to the replacement shares.
  members.get(previous.payerId)!.merchantPaid -= previous.gross;
  for (const [memberId, share] of previous.remainingAllocations) members.get(memberId)!.allocated -= share;
  for (const refund of previous.refunds) {
    members.get(refund.recipientId)!.refundReceived -= BigInt(refund.amountMinor);
    const invalid = applyRefund(members, expenses, refund);
    if (invalid) return invalid;
  }
}

function applyTransfer(members: ReadonlyMap<string, MemberTotals>, transfer: MemberTransfer): Failure | undefined {
  const sender = members.get(transfer.fromMemberId);
  const recipient = members.get(transfer.toMemberId);
  if (!sender || !recipient) return failure("MEMBER_NOT_PARTICIPATING", "memberTransfer");
  if (sender === recipient) return failure("SELF_TRANSFER", "memberTransfer");

  const amount = BigInt(transfer.amountMinor);
  if (amount > -netBalance(sender) || amount > netBalance(recipient)) {
    return failure("TRANSFER_EXCEEDS_BALANCE", "memberTransfer");
  }
  if (sender.transferSent + amount > maxMinor || recipient.transferReceived + amount > maxMinor) {
    return failure("AMOUNT_OVERFLOW", "memberTransfer");
  }

  sender.transferSent += amount;
  recipient.transferReceived += amount;
}

function reverseEvent(
  members: ReadonlyMap<string, MemberTotals>, expenses: ReadonlyMap<string, ExpenseTotals>,
  target: MerchantRefund | MemberTransfer,
): Failure | undefined {
  const amount = BigInt(target.amountMinor);
  if (target.kind === "memberTransfer") {
    const sender = members.get(target.fromMemberId)!;
    const recipient = members.get(target.toMemberId)!;
    if (sender.transferSent < amount || recipient.transferReceived < amount) {
      return failure("VOID_LEDGER_CONFLICT", "targetEventId");
    }
    sender.transferSent -= amount;
    recipient.transferReceived -= amount;
    return;
  }

  const expense = expenses.get(target.expenseId);
  const recipient = members.get(target.recipientId)!;
  const refundIndex = expense?.refunds.findIndex(({ id }) => id === target.id) ?? -1;
  if (!expense || refundIndex === -1 || expense.refunded < amount || recipient.refundReceived < amount) {
    return failure("VOID_LEDGER_CONFLICT", "targetEventId");
  }
  for (const { memberId, amountMinor } of target.reductions) {
    const remaining = expense.remainingAllocations.get(memberId);
    if (remaining === undefined) return failure("VOID_LEDGER_CONFLICT", "targetEventId");
    const restored = BigInt(amountMinor);
    expense.remainingAllocations.set(memberId, remaining + restored);
    members.get(memberId)!.allocated += restored;
  }
  expense.refunds.splice(refundIndex, 1);
  expense.refunded -= amount;
  recipient.refundReceived -= amount;
}

export function calculateBalances(
  currency: Currency,
  memberIds: readonly string[],
  expenses: readonly Expense[],
): Result<ActivityBalances>;
/** Opening expenses are applied first, followed by events in the supplied chronological order. */
export function calculateBalances(
  currency: Currency,
  memberIds: readonly string[],
  expenses: readonly Expense[],
  events: readonly BalanceEvent[],
): Result<ActivityEventBalances>;
export function calculateBalances(
  currency: Currency,
  memberIds: readonly string[],
  expenses: readonly Expense[],
  events?: readonly BalanceEvent[],
): Result<ActivityBalances | ActivityEventBalances> {
  if (!isCurrency(currency)) return failure("UNSUPPORTED_CURRENCY", "currency");
  const invalidMembers = validateMemberIds(memberIds);
  if (invalidMembers) return invalidMembers;

  const members = new Map(memberIds.map((id): [string, MemberTotals] => [id, {
    merchantPaid: 0n, refundReceived: 0n, allocated: 0n, transferSent: 0n, transferReceived: 0n,
  }]));
  const expenseTotals = new Map<string, ExpenseTotals>();
  const eventIds = new Set<string>();
  const recordedEvents = new Map<string, MerchantRefund | MemberTransfer>();
  const voidedIds = new Set<string>();
  let activityTotal = 0n;

  const timeline: readonly BalanceEvent[] = [
    ...expenses.map((expense) => ({ kind: "expense" as const, expense })),
    ...(events ?? []),
  ];
  for (const event of timeline) {
    if (event?.kind === "expense" || event?.kind === "expenseRevision") {
      const { id } = event.expense;
      if (typeof id !== "string" || id.trim() === "") return failure("INVALID_EXPENSE_ID", "expenseId");
      const previous = expenseTotals.get(id);
      if (previous && event.kind === "expense") return failure("DUPLICATE_EXPENSE_ID", "expenseId");
      if (!previous && event.kind === "expenseRevision") return failure("EXPENSE_NOT_FOUND", "expenseId");
      const result = applyExpense(currency, members, event.expense);
      if (!result.ok) return result;
      activityTotal += result.value.gross - (previous?.gross ?? 0n);
      if (activityTotal > maxMinor) return failure("AMOUNT_OVERFLOW", "total");
      expenseTotals.set(id, result.value);
      if (previous) {
        const invalid = carryRefundsForward(members, expenseTotals, previous);
        if (invalid) return invalid;
      }
      continue;
    }
    if (event?.kind !== "merchantRefund" && event?.kind !== "memberTransfer" && event?.kind !== "financialVoid") {
      return failure("INVALID_EVENT_TYPE", "events");
    }
    if (typeof event.id !== "string" || event.id.trim() === "") return failure("INVALID_EVENT_ID", "eventId");
    if (eventIds.has(event.id)) return failure("DUPLICATE_EVENT_ID", "eventId");
    eventIds.add(event.id);
    if (event.kind === "financialVoid") {
      const target = recordedEvents.get(event.targetEventId);
      if (!target || target.kind !== event.targetKind) return failure("INVALID_VOID_TARGET", "targetEventId");
      if (voidedIds.has(target.id)) return failure("EVENT_ALREADY_VOIDED", "targetEventId");
      const invalid = reverseEvent(members, expenseTotals, target);
      if (invalid) return invalid;
      voidedIds.add(target.id);
      continue;
    }
    const invalidAmount = validateMoney(event, event.kind);
    if (invalidAmount) return invalidAmount;
    if (event.currency !== currency) return failure("CURRENCY_MISMATCH", event.kind);
    if (event.amountMinor === 0) return failure("NON_POSITIVE_AMOUNT", event.kind);

    const invalidEvent = event.kind === "merchantRefund"
      ? applyRefund(members, expenseTotals, event)
      : applyTransfer(members, event);
    if (invalidEvent) return invalidEvent;
    recordedEvents.set(event.id, event);
  }

  const balances: MemberBalance[] = [];
  const eventBalances: MemberEventBalance[] = [];
  for (const [memberId, member] of members) {
    const net = netBalance(member);
    if (net < -maxMinor || net > maxMinor) return failure("AMOUNT_OVERFLOW", "total");
    const balance = {
      memberId,
      merchantPaidMinor: Number(member.merchantPaid),
      allocatedMinor: Number(member.allocated),
      netBalanceMinor: Number(net),
    };
    if (events === undefined) {
      balances.push(balance);
    } else {
      eventBalances.push({
        ...balance,
        merchantRefundReceivedMinor: Number(member.refundReceived),
        transferSentMinor: Number(member.transferSent),
        transferReceivedMinor: Number(member.transferReceived),
      });
    }
  }
  if (events === undefined) return { ok: true, value: { currency, balances } };

  const effectiveExpenses = Array.from(expenseTotals, ([expenseId, { gross, refunded }]) => ({
    expenseId,
    effectiveTotalMinor: Number(gross - refunded),
  }));
  return { ok: true, value: { currency, balances: eventBalances, effectiveExpenses } };
}
