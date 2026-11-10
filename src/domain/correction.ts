import {
  calculateBalances, sameMerchantPayments, type ActivityEventBalances, type BalanceEvent, type Expense,
  type MerchantRefund,
} from "./balance.ts";
import type { Currency } from "./money.ts";
import { failure, type Result } from "./result.ts";
import { suggestTransfers, type TransferSuggestion } from "./settlement.ts";

export type ExpenseCorrectionInput = {
  readonly currency: Currency;
  readonly memberIds: readonly string[];
  readonly expenses: readonly Expense[];
  /** Events use the same chronological order as calculateBalances. */
  readonly events?: readonly BalanceEvent[];
  readonly original: Expense;
  readonly proposed: Expense;
};

type MemberBalanceChange = {
  readonly memberId: string;
  readonly beforeNetBalanceMinor: number;
  readonly afterNetBalanceMinor: number;
  readonly deltaMinor: number;
};

export type ExpenseCorrectionPreview = {
  readonly expense: {
    readonly before: Expense;
    readonly after: Expense;
    readonly refunds: readonly MerchantRefund[];
  };
  readonly before: ActivityEventBalances;
  readonly after: ActivityEventBalances;
  readonly memberChanges: readonly MemberBalanceChange[];
  readonly suggestions: readonly TransferSuggestion[];
};

function matchesSnapshot(current: Expense, original: Expense): boolean {
  const { total, allocations } = current.split;
  const previousSplit = original.split;
  if (!previousSplit?.total || !Array.isArray(previousSplit.allocations)) return false;

  return total.currency === previousSplit.total.currency
    && total.amountMinor === previousSplit.total.amountMinor
    && sameMerchantPayments(current, original)
    && allocations.length === previousSplit.allocations.length
    && allocations.every(({ memberId, amountMinor }, index) => {
      const previous = previousSplit.allocations[index];
      return memberId === previous?.memberId && amountMinor === previous.amountMinor;
    });
}

const maxMinor = BigInt(Number.MAX_SAFE_INTEGER);

/** Previews a replacement without editing the original expense or recording new events. */
export function previewExpenseCorrection(
  { currency, memberIds, expenses, events = [], original, proposed }: ExpenseCorrectionInput,
): Result<ExpenseCorrectionPreview> {
  if (proposed.id !== original.id) return failure("EXPENSE_CORRECTION_ID_MISMATCH", "expenseId");

  const before = calculateBalances(currency, memberIds, expenses, events);
  if (!before.ok) return before;

  const expenseId = original.id;
  let current = expenses.find((expense) => expense.id === expenseId);
  const refunds = new Map<string, MerchantRefund>();
  for (const event of events) {
    if ((event.kind === "expense" || event.kind === "expenseRevision") && event.expense.id === expenseId) {
      current = event.expense;
    }
    if (event.kind === "merchantRefund" && event.expenseId === expenseId) refunds.set(event.id, event);
    if (event.kind === "financialVoid" && event.targetKind === "merchantRefund") refunds.delete(event.targetEventId);
  }
  if (!current) return failure("EXPENSE_NOT_FOUND", "expenseId");
  if (!matchesSnapshot(current, original)) return failure("EXPENSE_SNAPSHOT_MISMATCH", "expenseId");

  const after = calculateBalances(currency, memberIds, expenses, [...events, { kind: "expenseRevision", expense: proposed }]);
  if (!after.ok) return after;

  const memberChanges: MemberBalanceChange[] = [];
  for (const [index, { memberId, netBalanceMinor: afterNetBalanceMinor }] of after.value.balances.entries()) {
    const { netBalanceMinor: beforeNetBalanceMinor } = before.value.balances[index];
    const delta = BigInt(afterNetBalanceMinor) - BigInt(beforeNetBalanceMinor);
    if (delta < -maxMinor || delta > maxMinor) {
      return failure("AMOUNT_OVERFLOW", "netBalanceMinor");
    }
    memberChanges.push({
      memberId, beforeNetBalanceMinor, afterNetBalanceMinor, deltaMinor: Number(delta),
    });
  }

  const suggestions = suggestTransfers(after.value);
  if (!suggestions.ok) return suggestions;

  return {
    ok: true,
    value: {
      expense: { before: current, after: proposed, refunds: [...refunds.values()] },
      before: before.value,
      after: after.value,
      memberChanges,
      suggestions: suggestions.value,
    },
  };
}
