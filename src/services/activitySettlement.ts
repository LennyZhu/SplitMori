import { createActivityRepository } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { createFinanceRepository, type StoredFinanceEvent } from "../data/finance.ts";
import type { MemberTransfer } from "../domain/balance.ts";
import { withActivityReadSnapshot } from "./activityList.ts";

export type ActivitySettlementData = NonNullable<Awaited<ReturnType<typeof loadActivitySettlement>>>;

export function loadActivitySettlement(activityId: string, database?: LocalDatabase) {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activity = await createActivityRepository(snapshot).getActivity(activityId);
    if (!activity) return null;
    const ledger = await createFinanceRepository(snapshot).getActivityLedger(activityId);
    if (!ledger.ok) throw new Error(`Could not read activity ledger (${ledger.error.code})`);

    const { events, revisions, balanceSnapshot, suggestions } = ledger.value;
    const { balances, effectiveExpenses } = balanceSnapshot;
    const voidedRepayments = new Set(events.flatMap((event) => event.kind === "financialVoid" && event.targetKind === "memberTransfer"
      ? [event.targetEventId] : []));
    const repayments = events.filter((event): event is StoredFinanceEvent<MemberTransfer> =>
      event.kind === "memberTransfer" && !voidedRepayments.has(event.id)).reverse();
    const outstandingMinor = balances.reduce((sum, balance) => sum + BigInt(Math.max(0, balance.netBalanceMinor)), 0n);
    const status = events.length === 0 && revisions.length === 0 ? "empty" : outstandingMinor === 0n ? "settled" : "unsettled";
    const balancesById = new Map(balances.map((balance) => [balance.memberId, balance]));
    const members = activity.members.map(({ id, displayName }) => {
      const balance = balancesById.get(id);
      if (!balance) throw new Error(`Missing ledger balance for activity member ${id}`);
      return { ...balance, displayName };
    });

    return {
      activity, status, members, suggestions, repayments, outstandingMinor,
      expenseCount: effectiveExpenses.length,
      effectiveMinor: effectiveExpenses.reduce((sum, expense) => sum + BigInt(expense.effectiveTotalMinor), 0n),
      refundMinor: balances.reduce((sum, balance) => sum + BigInt(balance.merchantRefundReceivedMinor), 0n),
      repaymentMinor: repayments.reduce((sum, repayment) => sum + BigInt(repayment.amountMinor), 0n),
    };
  });
}
