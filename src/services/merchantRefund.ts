import { createActivityRepository } from "../data/activities.ts";
import { getLocalDatabase, type LocalDatabase } from "../data/database.ts";
import {
  createFinanceRepository, type MerchantRefundInput, type MerchantRefundPreview, type MerchantRefundVoidPreview,
} from "../data/finance.ts";
import type { FinancialVoidRequest } from "../data/financeVoids.ts";
import { parseAmount } from "../domain/money.ts";
import { allocateProportionalRefund, remainingRefundShares } from "../domain/refundAllocation.ts";
import { failure, type DomainErrorCode, type Failure, type Result } from "../domain/result.ts";
import { withActivityReadSnapshot } from "./activityList.ts";
import type { ExpenseDetailData } from "./expenseDetail.ts";
import { expenseDateTimestamp } from "./expenseEditor.ts";

export type MerchantRefundDraft = { amount: string; recipientId: string; date: string; note: string };

export function inspectMerchantRefundDraft(draft: MerchantRefundDraft, data: ExpenseDetailData, now: Date) {
  const { expense, activity, refunds } = data;
  const errors: Partial<Record<keyof MerchantRefundDraft, DomainErrorCode>> = {};
  const amount = parseAmount(draft.amount.trim(), activity.currency);
  const shares = remainingRefundShares(expense.split.allocations, refunds);
  const reductions = amount.ok ? allocateProportionalRefund(amount.value.amountMinor, shares) : amount;
  if (!reductions.ok) errors.amount = reductions.error.code;
  if (!activity.members.some(({ id }) => id === draft.recipientId)) errors.recipientId = "MEMBER_NOT_PARTICIPATING";
  const occurredAt = expenseDateTimestamp(draft.date.trim(), now);
  if (occurredAt === undefined || occurredAt > now.getTime()) errors.date = "INVALID_EVENT_TIME";
  return {
    errors, reductions: reductions.ok ? reductions.value : undefined,
    prepared: amount.ok && occurredAt !== undefined && Object.keys(errors).length === 0 ? {
      occurredAt, refund: { ...amount.value, expenseId: expense.id, recipientId: draft.recipientId, note: draft.note },
    } : undefined,
  };
}

type Finance = ReturnType<typeof createFinanceRepository>;

function withRefundPreview<T>(activityId: string, project: (finance: Finance) => Promise<Result<T>>, database?: LocalDatabase) {
  return withActivityReadSnapshot(database, async (snapshot) => {
    const activity = await createActivityRepository(snapshot).getActivity(activityId);
    if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
    const preview = await project(createFinanceRepository(snapshot));
    return preview.ok ? { ok: true, value: { ...preview.value, activity } } as const : preview;
  });
}

export function loadMerchantRefundPreview(activityId: string, occurredAt: number, refund: MerchantRefundInput, database?: LocalDatabase) {
  return withRefundPreview(activityId, (finance) => finance.previewMerchantRefund(activityId, occurredAt, refund), database);
}

export function loadMerchantRefundVoidPreview(activityId: string, expenseId: string, request: FinancialVoidRequest, database?: LocalDatabase) {
  return withRefundPreview(activityId, (finance) => finance.previewMerchantRefundVoid(activityId, expenseId, request), database);
}

export type ReviewedRefund =
  | { kind: "record"; preview: MerchantRefundPreview }
  | { kind: "void"; preview: MerchantRefundVoidPreview };

export type MerchantRefundSaveOutcome =
  | { status: "saved" | "notSaved" | "unknown" }
  | { status: "rejected"; error: Failure["error"] };

export async function saveReviewedMerchantRefund(
  activityId: string, review: ReviewedRefund,
  { verifyOnly = false, database }: { verifyOnly?: boolean; database?: LocalDatabase } = {},
): Promise<MerchantRefundSaveOutcome> {
  let finance: Finance;
  try {
    finance = createFinanceRepository(database ?? await getLocalDatabase());
  } catch {
    return { status: verifyOnly ? "unknown" : "notSaved" };
  }

  if (!verifyOnly) {
    try {
      const result = review.kind === "record" ? await finance.commitReviewedMerchantRefund(activityId, review.preview)
        : await finance.commitReviewedMerchantRefundVoid(activityId, review.preview);
      if (result.ok) return { status: "saved" };
      if (result.error.code !== "FINANCE_STORAGE_ERROR") return { status: "rejected", error: result.error };
    } catch {
      // A lost write response must be resolved by the existing event ID first.
    }
  }

  try {
    const receipt = review.kind === "record" ? await finance.lookupMerchantRefund(activityId, review.preview)
      : await finance.lookupMerchantRefundVoid(activityId, review.preview.request);
    if (receipt.ok) return { status: receipt.value ? "saved" : "notSaved" };
    if (receipt.error.code === "EVENT_ID_CONFLICT") return { status: "rejected", error: receipt.error };
  } catch {
    // An unreadable receipt keeps the action in read-only verification mode.
  }
  return { status: "unknown" };
}
