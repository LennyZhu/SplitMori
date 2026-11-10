import { createActivityRepository } from "../data/activities.ts";
import { getLocalDatabase, type LocalDatabase } from "../data/database.ts";
import { createFinanceRepository, expenseEditBlocker, type FinanceExpense, type ReviewedExpenseCorrectionRequest } from "../data/finance.ts";
import { failure, type Failure } from "../domain/result.ts";
import type { ActivityEventBalances } from "../domain/balance.ts";
import { withActivityReadSnapshot } from "./activityList.ts";
import { freeAccess, type ProAccess } from "./proEntitlement.ts";

export type ExpenseDetailData = NonNullable<Awaited<ReturnType<typeof loadExpenseDetail>>>;

export function loadExpenseDetail(activityId: string, expenseId: string, database?: LocalDatabase) {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activities = createActivityRepository(snapshot);
    const activity = await activities.getActivity(activityId);
    if (!activity) return null;
    const finance = createFinanceRepository(snapshot);
    const detail = await finance.getExpense(activityId, expenseId);
    if (!detail.ok) {
      if (detail.error.code === "EXPENSE_NOT_FOUND") return null;
      throw new Error(detail.error.code);
    }
    const history = await finance.listExpenseRevisions(activityId, expenseId);
    if (!history.ok) throw new Error(history.error.code);
    const active = await activities.getCreationBlocker();
    const { expense, occurredAt, currentVersion, refunds, refundVoids } = detail.value;
    const voided = new Map(refundVoids.map((event) => [event.targetEventId, event]));
    const versions = [...history.value].reverse();
    const refundHistory = [...refunds].reverse().map((refund) => ({
      refund, voidEvent: voided.get(refund.id),
      version: versions.find((version) => version.occurredAt < refund.occurredAt
        || (version.occurredAt === refund.occurredAt && version.sequence < refund.sequence)),
    }));
    return {
      activity, expense, expenseDate: expense.expenseDate ?? occurredAt, currentVersion, versions: history.value,
      refunds: refunds.filter(({ id }) => !voided.has(id)), voidedRefundCount: refundVoids.length, refundHistory,
      activeCount: active?.activeCount ?? 0,
      editBlocker: expenseEditBlocker(activity.status, active?.activeCount ?? 0, expense),
    };
  });
}

export function loadExpenseCorrectionPreview(
  activityId: string, expense: FinanceExpense, version: number, database?: LocalDatabase, hasProAccess: ProAccess = freeAccess,
) {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activity = await createActivityRepository(snapshot).getActivity(activityId);
    if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
    const preview = await createFinanceRepository(snapshot, hasProAccess).previewExpenseCorrection(activityId, expense.id, expense, version);
    return preview.ok ? { ok: true, value: { ...preview.value, activity } } as const : preview;
  });
}

type CorrectionSaveOutcome =
  | { status: "saved" | "notSaved" | "unknown" }
  | { status: "rejected"; error: Failure["error"] };

export async function saveReviewedExpenseCorrection(
  activityId: string, request: ReviewedExpenseCorrectionRequest,
  { verifyOnly = false, database, hasProAccess = freeAccess }: { verifyOnly?: boolean; database?: LocalDatabase; hasProAccess?: ProAccess } = {},
): Promise<CorrectionSaveOutcome> {
  let finance: ReturnType<typeof createFinanceRepository>;
  try {
    finance = createFinanceRepository(database ?? await getLocalDatabase(), hasProAccess);
  } catch {
    return { status: verifyOnly ? "unknown" : "notSaved" };
  }

  if (!verifyOnly) {
    try {
      const result = await finance.commitReviewedExpenseCorrection(activityId, request);
      if (result.ok) return { status: "saved" };
      if (result.error.code !== "FINANCE_STORAGE_ERROR") return { status: "rejected", error: result.error };
    } catch {
      // The write result was not received. Read the exact revision before offering any retry.
    }
  }

  try {
    const receipt = await finance.lookupReviewedExpenseCorrection(activityId, request);
    if (receipt.ok) return { status: receipt.value ? "saved" : "notSaved" };
    if (receipt.error.code === "REVISION_ID_CONFLICT") return { status: "rejected", error: receipt.error };
  } catch {
    // Keep an unconfirmed request in read-only verification mode.
  }
  return { status: "unknown" };
}

export function summarizeCorrectionBalances(snapshot: ActivityEventBalances) {
  return {
    effectiveMinor: snapshot.effectiveExpenses.reduce((sum, expense) => sum + BigInt(expense.effectiveTotalMinor), 0n),
    repaymentMinor: snapshot.balances.reduce((sum, member) => sum + BigInt(member.transferSentMinor), 0n),
    refundMinor: snapshot.balances.reduce((sum, member) => sum + BigInt(member.merchantRefundReceivedMinor), 0n),
    outstandingMinor: snapshot.balances.reduce((sum, member) => sum + BigInt(Math.max(0, member.netBalanceMinor)), 0n),
  };
}

export { summarizeExpenseRefunds } from "../domain/refundAllocation.ts";
