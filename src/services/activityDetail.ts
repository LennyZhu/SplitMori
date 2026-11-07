import { createActivityRepository, type ActivityDetail } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { createFinanceRepository, projectCurrentExpenses, type FinanceExpense } from "../data/finance.ts";
import { withActivityReadSnapshot } from "./activityList.ts";

type ActivityExpenseRow = {
  readonly id: string;
  readonly name: string;
  readonly payerName: string;
  readonly splitMode: FinanceExpense["splitMode"];
  readonly occurredAt: number;
  readonly grossMinor: number;
  readonly effectiveMinor: number;
  readonly refundMinor: number;
};

type ActivityHistoryRow = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly occurredAt: number;
  readonly sequence: number;
  readonly amountMinor?: number;
  readonly voided?: boolean;
};

export type ActivityDetailData = {
  readonly activity: ActivityDetail;
  readonly expenses: readonly ActivityExpenseRow[];
  readonly history: readonly ActivityHistoryRow[];
  readonly balances: ReadonlyMap<string, number>;
  readonly grossMinor: bigint;
  readonly refundMinor: bigint;
  readonly effectiveMinor: bigint;
  readonly outstandingMinor: bigint;
};

export function loadActivityDetail(activityId: string, database?: LocalDatabase): Promise<ActivityDetailData | null> {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activity = await createActivityRepository(snapshot).getActivity(activityId);
    if (!activity) return null;
    const result = await createFinanceRepository(snapshot).getActivityLedger(activityId);
    if (!result.ok) throw new Error(`Could not read activity ledger (${result.error.code})`);

    const { events, revisions, balanceSnapshot } = result.value;
    const memberNames = new Map(activity.members.map(({ id, displayName }) => [id, displayName]));
    const memberName = (id: string) => memberNames.get(id) ?? "未知成員";
    const effectiveByExpense = new Map(balanceSnapshot.effectiveExpenses.map((expense) => [expense.expenseId, expense.effectiveTotalMinor]));
    const expenses = projectCurrentExpenses(events, revisions).map(({ expense, occurredAt }, index): ActivityExpenseRow => {
      const grossMinor = expense.split.total.amountMinor;
      const effectiveMinor = effectiveByExpense.get(expense.id);
      if (effectiveMinor === undefined) throw new Error("Missing effective expense in the activity ledger");
      return {
        id: expense.id, name: expense.name ?? `費用 ${index + 1}`, occurredAt: expense.expenseDate ?? occurredAt, splitMode: expense.splitMode,
        payerName: memberName(expense.merchantPayment.memberId), grossMinor, effectiveMinor,
        refundMinor: grossMinor - effectiveMinor,
      };
    });
    const expenseNames = new Map(expenses.map(({ id, name }) => [id, name]));
    const voided = new Set(events.flatMap((event) => event.kind === "financialVoid" ? [event.targetEventId] : []));
    const history: ActivityHistoryRow[] = [];
    for (const event of events) {
      const { occurredAt, sequence } = event;
      if (event.kind === "merchantRefund") {
        history.push({
          id: `refund:${event.id}`, label: "商家退款", description: `${expenseNames.get(event.expenseId) ?? "費用"} · ${memberName(event.recipientId)}收取`,
          occurredAt, sequence, amountMinor: event.amountMinor, voided: voided.has(event.id),
        });
      } else if (event.kind === "memberTransfer") {
        history.push({
          id: `transfer:${event.id}`, label: "成員還款",
          description: `${memberName(event.fromMemberId)} → ${memberName(event.toMemberId)}${event.note ? ` · ${event.note}` : ""}`,
          occurredAt, sequence, amountMinor: event.amountMinor, voided: voided.has(event.id),
        });
      } else if (event.kind === "financialVoid") {
        history.push({
          id: `void:${event.id}`, label: event.targetKind === "merchantRefund" ? "作廢商家退款" : "作廢成員還款",
          description: event.reason ?? "", occurredAt, sequence,
        });
      }
    }
    for (const revision of revisions) {
      history.push({
        id: `revision:${revision.id}`, label: "費用修訂", description: expenseNames.get(revision.expense.id) ?? "費用",
        occurredAt: revision.occurredAt, sequence: revision.sequence, amountMinor: revision.expense.split.total.amountMinor,
      });
    }

    const balances = new Map(balanceSnapshot.balances.map(({ memberId, netBalanceMinor }) => [memberId, netBalanceMinor]));
    const grossMinor = expenses.reduce((sum, expense) => sum + BigInt(expense.grossMinor), 0n);
    const effectiveMinor = expenses.reduce((sum, expense) => sum + BigInt(expense.effectiveMinor), 0n);
    const outstandingMinor = balanceSnapshot.balances.reduce(
      (sum, balance) => sum + BigInt(Math.max(0, balance.netBalanceMinor)), 0n,
    );
    return {
      activity, expenses: expenses.reverse(),
      history: history.sort((a, b) => b.occurredAt - a.occurredAt || b.sequence - a.sequence),
      balances, grossMinor, effectiveMinor, refundMinor: grossMinor - effectiveMinor, outstandingMinor,
    };
  });
}
