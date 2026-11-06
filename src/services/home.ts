import { createActivityRepository, type Activity } from "../data/activities.ts";
import { getLocalDatabase, type LocalDatabase } from "../data/database.ts";
import { createFinanceRepository } from "../data/finance.ts";
import { createQuickSplitRepository } from "../data/quickSplits.ts";
import { validateMoney, type Money } from "../domain/money.ts";

export type HomeActivity = {
  readonly id: string;
  readonly name: string;
  readonly total: Money;
  readonly memberCount: number;
  readonly expenseCount: number;
  readonly hasOutstanding: boolean;
};

export type HomeRecentRecord =
  | (HomeActivity & { readonly kind: "activity"; readonly timestamp: number })
  | {
    readonly kind: "quick";
    readonly id: string;
    readonly total: Money;
    readonly memberCount: number;
    readonly timestamp: number;
  };

export type HomeData = {
  readonly activeActivities: readonly HomeActivity[];
  readonly recentRecords: readonly HomeRecentRecord[];
};

const recentLimit = 3;

export async function loadHomeData(database?: LocalDatabase): Promise<HomeData> {
  const local = database ?? await getLocalDatabase();
  return local.read(async (connection) => {
    // All repository reads share one transaction so the home reflects one ledger snapshot.
    const readOnly: LocalDatabase = {
      read: (task) => task(connection),
      async write() { throw new Error("The home snapshot is read-only"); },
      async backupSnapshot() { throw new Error("The home snapshot is read-only"); },
    };
    const activities = createActivityRepository(readOnly);
    const finance = createFinanceRepository(readOnly);
    const history = await createQuickSplitRepository(readOnly).listQuickHistory();
    if (!history.ok) throw new Error(`Could not read quick split history (${history.error.code})`);
    const rows = await activities.listActivities();

    async function summarize(activity: Activity): Promise<HomeActivity> {
      const ledger = await finance.getActivityLedger(activity.id);
      if (!ledger.ok) throw new Error(`Could not read activity ledger (${ledger.error.code})`);
      const { balances, currency, effectiveExpenses } = ledger.value.balanceSnapshot;
      // The ledger bounds gross totals to safe integers, and effective totals only subtract refunds.
      const amountMinor = effectiveExpenses.reduce((sum, expense) => sum + expense.effectiveTotalMinor, 0);
      return {
        id: activity.id, name: activity.name, total: { currency, amountMinor },
        memberCount: balances.length, expenseCount: effectiveExpenses.length,
        hasOutstanding: balances.some(({ netBalanceMinor }) => netBalanceMinor !== 0),
      };
    }

    const recent = [
      ...rows.filter(({ status }) => status === "completed").map((activity) => ({
        kind: "activity" as const, id: activity.id, timestamp: activity.updatedAt, activity,
      })),
      ...history.value.map((record) => ({
        kind: "quick" as const, id: record.id, timestamp: record.createdAt, record,
      })),
    ].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, recentLimit);

    const activeActivities: HomeActivity[] = [];
    for (const activity of rows.filter(({ status }) => status === "active")) {
      activeActivities.push(await summarize(activity));
    }
    const recentRecords: HomeRecentRecord[] = [];
    for (const item of recent) {
      const { kind, id, timestamp } = item;
      if (kind === "activity") {
        recentRecords.push({ kind, timestamp, ...await summarize(item.activity) });
      } else {
        const total = item.record.snapshot.split.total;
        if (validateMoney(total, "total")) throw new Error("Invalid saved quick split total");
        recentRecords.push({ kind, id, timestamp, total, memberCount: item.record.input.members.length });
      }
    }
    return { activeActivities, recentRecords };
  });
}
