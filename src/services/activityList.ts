import { createActivityRepository, type Activity } from "../data/activities.ts";
import { getLocalDatabase, type LocalDatabase } from "../data/database.ts";
import { createFinanceRepository } from "../data/finance.ts";
import type { Money } from "../domain/money.ts";

export type ActivitySummary = Activity & {
  readonly total: Money;
  readonly memberCount: number;
  readonly expenseCount: number;
  readonly hasOutstanding: boolean;
};

export async function withActivityReadSnapshot<T>(
  database: LocalDatabase | undefined, read: (snapshot: LocalDatabase) => Promise<T>,
): Promise<T> {
  const local = database ?? await getLocalDatabase();
  return local.read((connection) => read({
    read: (task) => task(connection),
    async write() { throw new Error("The activity snapshot is read-only"); },
    async backupSnapshot() { throw new Error("The activity snapshot is read-only"); },
  }));
}

export async function summarizeActivity(
  finance: Pick<ReturnType<typeof createFinanceRepository>, "getActivityLedger">,
  activity: Activity,
): Promise<ActivitySummary> {
  const ledger = await finance.getActivityLedger(activity.id);
  if (!ledger.ok) throw new Error(`Could not read activity ledger (${ledger.error.code})`);
  const { balances, currency, effectiveExpenses } = ledger.value.balanceSnapshot;
  // Effective expenses only subtract refunds from the domain's safe-integer gross total.
  const amountMinor = effectiveExpenses.reduce((sum, expense) => sum + expense.effectiveTotalMinor, 0);
  return {
    ...activity, total: { currency, amountMinor },
    memberCount: balances.length, expenseCount: effectiveExpenses.length,
    hasOutstanding: balances.some(({ netBalanceMinor }) => netBalanceMinor !== 0),
  };
}

export function loadActivityList(database?: LocalDatabase): Promise<readonly ActivitySummary[]> {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const rows = await createActivityRepository(snapshot).listActivities();
    const finance = createFinanceRepository(snapshot);
    rows.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const summaries: ActivitySummary[] = [];
    for (const activity of rows) summaries.push(await summarizeActivity(finance, activity));
    return summaries;
  });
}
