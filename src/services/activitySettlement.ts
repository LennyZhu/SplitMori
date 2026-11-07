import { createActivityRepository } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { createFinanceRepository, type FinanceMemberTransfer, type StoredFinanceEvent } from "../data/finance.ts";
import type { StoredFinancialVoid } from "../data/financeVoids.ts";
import { withActivityReadSnapshot } from "./activityList.ts";

export type ActivitySettlementData = NonNullable<Awaited<ReturnType<typeof loadActivitySettlement>>>;
export type RepaymentHistoryEntry = {
  readonly transfer: StoredFinanceEvent<FinanceMemberTransfer>;
  readonly voidEvent?: StoredFinancialVoid;
};

export function loadActivitySettlement(activityId: string, database?: LocalDatabase) {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activity = await createActivityRepository(snapshot).getActivity(activityId);
    if (!activity) return null;
    const ledger = await createFinanceRepository(snapshot).getActivityLedger(activityId);
    if (!ledger.ok) throw new Error(`Could not read activity ledger (${ledger.error.code})`);

    const { events, revisions, balanceSnapshot, suggestions } = ledger.value;
    const { balances, effectiveExpenses } = balanceSnapshot;
    const voidsByTarget = new Map(events.flatMap((event) => event.kind === "financialVoid" && event.targetKind === "memberTransfer"
      ? [[event.targetEventId, event] as const] : []));
    const repaymentHistory: RepaymentHistoryEntry[] = events.flatMap((event) => event.kind === "memberTransfer"
      ? [{ transfer: event, voidEvent: voidsByTarget.get(event.id) }] : []).reverse();
    const repayments = repaymentHistory.filter(({ voidEvent }) => !voidEvent).map(({ transfer }) => transfer);
    const outstandingMinor = balances.reduce((sum, balance) => sum + BigInt(Math.max(0, balance.netBalanceMinor)), 0n);
    const status = events.length === 0 && revisions.length === 0 ? "empty" : outstandingMinor === 0n ? "settled" : "unsettled";
    const balancesById = new Map(balances.map((balance) => [balance.memberId, balance]));
    const members = activity.members.map(({ id, displayName }) => {
      const balance = balancesById.get(id);
      if (!balance) throw new Error(`Missing ledger balance for activity member ${id}`);
      return { ...balance, displayName };
    });

    return {
      activity, status, members, suggestions, repayments, repaymentHistory, outstandingMinor,
      expenseCount: effectiveExpenses.length,
      effectiveMinor: effectiveExpenses.reduce((sum, expense) => sum + BigInt(expense.effectiveTotalMinor), 0n),
      refundMinor: balances.reduce((sum, balance) => sum + BigInt(balance.merchantRefundReceivedMinor), 0n),
      repaymentMinor: repayments.reduce((sum, repayment) => sum + BigInt(repayment.amountMinor), 0n),
      voidedRepaymentMinor: repaymentHistory.reduce((sum, { transfer, voidEvent }) => sum + (voidEvent ? BigInt(transfer.amountMinor) : 0n), 0n),
    };
  });
}
