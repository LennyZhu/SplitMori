import {
  calculateBalances, type ActivityEventBalances, type BalanceEvent, type Expense,
  type MemberEventBalance, type MerchantRefund,
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
  const payer = current.merchantPayment;
  const previousPayer = original.merchantPayment;
  if (!previousSplit?.total || !Array.isArray(previousSplit.allocations) || !previousPayer) return false;

  return total.currency === previousSplit.total.currency
    && total.amountMinor === previousSplit.total.amountMinor
    && payer.memberId === previousPayer.memberId
    && payer.currency === previousPayer.currency
    && payer.amountMinor === previousPayer.amountMinor
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
  const revisedEvents: BalanceEvent[] = [];
  const refunds: MerchantRefund[] = [];
  for (const event of events) {
    if (event.kind === "memberTransfer") continue;
    if (event.kind === "expense" && event.expense.id === expenseId) {
      current = event.expense;
      revisedEvents.push({ ...event, expense: proposed });
    } else {
      revisedEvents.push(event);
      if (event.kind === "merchantRefund" && event.expenseId === expenseId) refunds.push(event);
    }
  }
  if (!current) return failure("EXPENSE_NOT_FOUND", "expenseId");
  if (!matchesSnapshot(current, original)) return failure("EXPENSE_SNAPSHOT_MISMATCH", "expenseId");

  const revisedExpenses = expenses.map((expense) => expense.id === expenseId ? proposed : expense);
  const revised = calculateBalances(currency, memberIds, revisedExpenses, revisedEvents);
  if (!revised.ok) return revised;

  // Transfers were validated against the original timeline. Carry their net effects over exactly once.
  const balances: MemberEventBalance[] = [];
  const memberChanges: MemberBalanceChange[] = [];
  for (const [index, balance] of revised.value.balances.entries()) {
    const { netBalanceMinor: beforeNetBalanceMinor, transferSentMinor, transferReceivedMinor } =
      before.value.balances[index];
    const net = BigInt(balance.netBalanceMinor) + BigInt(transferSentMinor) - BigInt(transferReceivedMinor);
    const delta = net - BigInt(beforeNetBalanceMinor);
    if (net < -maxMinor || net > maxMinor || delta < -maxMinor || delta > maxMinor) {
      return failure("AMOUNT_OVERFLOW", "netBalanceMinor");
    }

    const afterNetBalanceMinor = Number(net);
    balances.push({
      ...balance, transferSentMinor, transferReceivedMinor, netBalanceMinor: afterNetBalanceMinor,
    });
    memberChanges.push({
      memberId: balance.memberId, beforeNetBalanceMinor, afterNetBalanceMinor, deltaMinor: Number(delta),
    });
  }

  const after = { ...revised.value, balances };
  const suggestions = suggestTransfers(after);
  if (!suggestions.ok) return suggestions;

  return {
    ok: true,
    value: {
      expense: { before: current, after: proposed, refunds },
      before: before.value,
      after,
      memberChanges,
      suggestions: suggestions.value,
    },
  };
}
