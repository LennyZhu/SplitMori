import { createActivityRepository } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { createFinanceRepository } from "../data/finance.ts";
import { merchantPaymentsOf } from "../domain/balance.ts";
import { withActivityReadSnapshot } from "./activityList.ts";

export function loadActivityMembers(activityId: string, database?: LocalDatabase) {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activity = await createActivityRepository(snapshot).getActivity(activityId);
    if (!activity) return null;
    const ledger = await createFinanceRepository(snapshot).getActivityLedger(activityId);
    if (!ledger.ok) throw new Error(ledger.error.code);
    const used = new Set<string>();
    for (const event of [...ledger.value.events, ...ledger.value.revisions]) {
      switch (event.kind) {
        case "expense":
        case "expenseRevision":
          for (const payment of merchantPaymentsOf(event.expense)) used.add(payment.memberId);
          for (const row of event.expense.split.allocations) used.add(row.memberId);
          break;
        case "merchantRefund":
          used.add(event.recipientId);
          for (const row of event.reductions) used.add(row.memberId);
          break;
        case "memberTransfer":
          used.add(event.fromMemberId);
          used.add(event.toMemberId);
      }
    }
    const shared = new Set((await snapshot.read((connection) => connection.getAllAsync<{ id: string }>(`
      SELECT member_id AS id FROM activity_members
      WHERE member_id IN (SELECT member_id FROM activity_members WHERE activity_id = ?)
      GROUP BY member_id HAVING COUNT(*) > 1
    `, activityId))).map(({ id }) => id));
    return {
      ...activity,
      members: activity.members.map((member) => ({ ...member, hasHistory: used.has(member.id), shared: shared.has(member.id) })),
    };
  });
}
