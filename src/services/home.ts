import { createActivityRepository } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { createFinanceRepository } from "../data/finance.ts";
import { createQuickSplitRepository } from "../data/quickSplits.ts";
import { validateMoney, type Money } from "../domain/money.ts";
import { summarizeActivity, withActivityReadSnapshot, type ActivitySummary } from "./activityList.ts";

export type HomeActivity = Pick<ActivitySummary, "id" | "name" | "total" | "memberCount" | "expenseCount" | "hasOutstanding">;

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
  return withActivityReadSnapshot(database, async (readOnly) => {
    const activities = createActivityRepository(readOnly);
    const finance = createFinanceRepository(readOnly);
    const history = await createQuickSplitRepository(readOnly).listQuickHistory();
    if (!history.ok) throw new Error(`Could not read quick split history (${history.error.code})`);
    const rows = await activities.listActivities();

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
      activeActivities.push(await summarizeActivity(finance, activity));
    }
    const recentRecords: HomeRecentRecord[] = [];
    for (const item of recent) {
      const { kind, id, timestamp } = item;
      if (kind === "activity") {
        recentRecords.push({ kind, timestamp, ...await summarizeActivity(finance, item.activity) });
      } else {
        const total = item.record.snapshot.split.total;
        if (validateMoney(total, "total")) throw new Error("Invalid saved quick split total");
        recentRecords.push({ kind, id, timestamp, total, memberCount: item.record.input.members.length });
      }
    }
    return { activeActivities, recentRecords };
  });
}
