import { readActivityDetail, type ActivityDetail } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { insertNewExpenseInTransaction, type FinanceExpense, type StoredExpense } from "../data/finance.ts";
import { readQuickHistory, type QuickHistoryRecord } from "../data/quickSplits.ts";
import type { MerchantPayment } from "../domain/balance.ts";
import { failure, type Result } from "../domain/result.ts";
import { validateMemberIds, type Allocation } from "../domain/split.ts";

type MemberMapping = { readonly quickMemberId: string; readonly activityMemberId: string };

export type QuickSplitConversionRequest = {
  readonly requestId: string;
  readonly historyId: string;
  readonly activityId: string;
  readonly memberMapping: readonly MemberMapping[];
  readonly merchantPayment: MerchantPayment;
  /** Time of the expense in Unix milliseconds. Retry with the same value. */
  readonly occurredAt: number;
};

export type QuickSplitConversionReceipt = {
  readonly requestId: string;
  readonly historyId: string;
  readonly activityId: string;
  readonly memberMapping: readonly MemberMapping[];
  readonly event: StoredExpense;
  readonly source: Pick<QuickHistoryRecord, "createdAt" | "schemaVersion" | "input"> & {
    readonly split: QuickHistoryRecord["snapshot"]["split"];
  };
};

function validId(id: unknown): id is string {
  return typeof id === "string" && id.trim() !== "";
}

function mapExpense(
  history: QuickHistoryRecord, activity: ActivityDetail, request: QuickSplitConversionRequest,
): Result<FinanceExpense> {
  const split = history.snapshot?.split;
  if (!split?.total || !Array.isArray(split.allocations) || !Array.isArray(history.input?.members)
    || !split.explanation || split.explanation.kind !== history.input.method?.kind) {
    return failure("INVALID_SPLIT_SNAPSHOT", "allocations");
  }
  if (split.total.currency !== activity.currency) return failure("CURRENCY_MISMATCH", "currency");
  const { charges } = history.input;
  if (charges?.kind === "finalTotal" && charges.total.amountMinor !== split.total.amountMinor) {
    return failure("TOTAL_MISMATCH", "total");
  }

  const quickIds = history.input.members.map(({ id }) => id);
  const invalidIds = validateMemberIds(quickIds)
    ?? validateMemberIds(split.allocations.map(({ memberId }) => memberId), "allocations");
  if (invalidIds) return invalidIds;

  const sources = new Set(quickIds);
  const targets = new Set(activity.members.map(({ id }) => id));
  const mapped = new Map<string, string>();
  const assigned = new Set<string>();
  for (const { quickMemberId, activityMemberId } of request.memberMapping) {
    if (!sources.has(quickMemberId) || !targets.has(activityMemberId)
      || mapped.has(quickMemberId) || assigned.has(activityMemberId)) {
      return failure("INVALID_MEMBER_MAPPING", "memberMapping");
    }
    mapped.set(quickMemberId, activityMemberId);
    assigned.add(activityMemberId);
  }

  const allocations: Allocation[] = [];
  for (const { memberId, amountMinor } of split.allocations) {
    const targetId = mapped.get(memberId);
    if (targetId === undefined) return failure("INVALID_MEMBER_MAPPING", "memberMapping");
    allocations.push({ memberId: targetId, amountMinor });
  }
  return { ok: true, value: {
    id: `quick-conversion:${request.requestId}`,
    split: { total: split.total, allocations },
    merchantPayment: request.merchantPayment,
    splitMode: split.explanation.kind,
    allocationVersion: split.allocationVersion,
  } };
}

export function createQuickSplitConversionService(database: LocalDatabase) {
  return {
    async convertQuickHistory(input: QuickSplitConversionRequest): Promise<Result<QuickSplitConversionReceipt>> {
      try {
        const { requestId, historyId, activityId, occurredAt } = input;
        const merchantPayment = input.merchantPayment && {
          memberId: input.merchantPayment.memberId,
          currency: input.merchantPayment.currency,
          amountMinor: input.merchantPayment.amountMinor,
        };
        const memberMapping = input.memberMapping?.map(({ quickMemberId, activityMemberId }) => ({ quickMemberId, activityMemberId }))
          .sort((left, right) => {
            if (left.quickMemberId === right.quickMemberId) return 0;
            return left.quickMemberId < right.quickMemberId ? -1 : 1;
          }) ?? [];
        const request = { requestId, historyId, activityId, occurredAt, merchantPayment, memberMapping };
        const requestJson = JSON.stringify(request);

        return await database.write(async (transaction) => {
          if (!validId(requestId)) return failure("INVALID_CONVERSION_ID", "conversionRequestId");
          const previous = await transaction.getFirstAsync<{ requestJson: string; receiptJson: string }>(`
            SELECT request_json AS requestJson, receipt_json AS receiptJson
            FROM quick_split_conversions WHERE request_id = ?
          `, requestId);
          if (previous) {
            return previous.requestJson === requestJson
              ? { ok: true, value: JSON.parse(previous.receiptJson) as QuickSplitConversionReceipt }
              : failure("CONVERSION_REQUEST_CONFLICT", "conversionRequestId");
          }
          if (!validId(historyId)) return failure("INVALID_QUICK_RECORD_ID", "quickRecordId");
          if (!merchantPayment || !validId(merchantPayment.memberId)) {
            return failure("MISSING_MERCHANT_PAYMENT", "merchantPayment");
          }
          const converted = await transaction.getFirstAsync<{ requestId: string }>(`
            SELECT request_id AS requestId FROM quick_split_conversions WHERE history_id = ?
          `, historyId);
          if (converted) return failure("QUICK_HISTORY_ALREADY_CONVERTED", "quickRecordId");

          const history = await readQuickHistory(transaction, historyId);
          if (!history) return failure("QUICK_HISTORY_NOT_FOUND", "quickRecordId");
          const activity = await readActivityDetail(transaction, activityId);
          if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
          if (activity.status !== "active") return failure("ACTIVITY_COMPLETED", "activityId");
          const expense = mapExpense(history, activity, request);
          if (!expense.ok) return expense;

          const event = await insertNewExpenseInTransaction(transaction, activityId, occurredAt, expense.value);
          if (!event.ok) return event;
          const receipt: QuickSplitConversionReceipt = {
            requestId, historyId, activityId, memberMapping, event: event.value,
            source: { createdAt: history.createdAt, schemaVersion: history.schemaVersion, input: history.input,
              split: history.snapshot.split },
          };
          await transaction.runAsync(`
            INSERT INTO quick_split_conversions (request_id, history_id, activity_id, expense_id, request_json, receipt_json)
            VALUES (?, ?, ?, ?, ?, ?)
          `, requestId, historyId, activityId, event.value.expense.id, requestJson, JSON.stringify(receipt));
          return { ok: true, value: receipt };
        });
      } catch {
        return failure("QUICK_CONVERSION_STORAGE_ERROR", "storage");
      }
    },
  };
}
