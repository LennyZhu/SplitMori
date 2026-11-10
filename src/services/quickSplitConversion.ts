import { readActivityDetail, type Activity, type ActivityDetail } from "../data/activities.ts";
import type { LocalDatabase } from "../data/database.ts";
import { insertNewExpenseInTransaction, type FinanceExpense, type StoredExpense } from "../data/finance.ts";
import { readQuickHistory, type QuickHistoryRecord } from "../data/quickSplits.ts";
import type { MerchantPayment } from "../domain/balance.ts";
import { validateMinorAmount, validateMoney, type Currency, type Money } from "../domain/money.ts";
import { usesAdvancedSplit, type QuickSplitInput, type QuickSplitMethod } from "../domain/quickSplit.ts";
import type { ChargeDistribution } from "../domain/charges.ts";
import { failure, type Result } from "../domain/result.ts";
import { validateMemberIds, type Allocation } from "../domain/split.ts";
import { freeAccess, type ProAccess } from "./proEntitlement.ts";

export type MemberMapping = { readonly quickMemberId: string; readonly activityMemberId: string };

export type QuickSplitConversionRequest = {
  readonly requestId: string;
  readonly historyId: string;
  readonly activityId: string;
  /** Required by the app. Legacy callers can still create unnamed conversions. */
  readonly expenseName?: string;
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

export type ConversionDestination = { readonly activityId: string; readonly activityName: string };
export type ConversionSource = { readonly history: QuickHistoryRecord; readonly destination: ConversionDestination | null };
export type ConversionTarget = Pick<Activity, "id" | "name" | "status" | "currency"> & {
  readonly memberCount: number;
  readonly expenseCount: number;
};

export function canSelectConversionTarget(target: ConversionTarget, history: QuickHistoryRecord): boolean {
  return target.status === "active" && target.currency === history.snapshot.split.total.currency
    && target.memberCount >= history.input.members.length;
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.trim() !== "";
}

export function projectQuickConversion(
  history: QuickHistoryRecord, activity: ActivityDetail, memberMapping: readonly MemberMapping[],
): Result<{ readonly total: Money; readonly allocations: readonly Allocation[] }> {
  const split = history.snapshot?.split;
  if (!split?.total || !Array.isArray(split.allocations) || !Array.isArray(history.input?.members)
    || !split.explanation || split.explanation.kind !== history.input.method?.kind) {
    return failure("INVALID_SPLIT_SNAPSHOT", "allocations");
  }
  if (split.total.currency !== activity.currency) return failure("CURRENCY_MISMATCH", "currency");
  const invalidTotal = validateMoney(split.total, "total");
  if (invalidTotal) return invalidTotal;
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
  for (const { quickMemberId, activityMemberId } of memberMapping) {
    if (!sources.has(quickMemberId) || !targets.has(activityMemberId)
      || mapped.has(quickMemberId) || assigned.has(activityMemberId)) {
      return failure("INVALID_MEMBER_MAPPING", "memberMapping");
    }
    mapped.set(quickMemberId, activityMemberId);
    assigned.add(activityMemberId);
  }
  if (mapped.size !== sources.size) return failure("INVALID_MEMBER_MAPPING", "memberMapping");

  const allocations: Allocation[] = [];
  let sum = 0n;
  for (const { memberId, amountMinor } of split.allocations) {
    const targetId = mapped.get(memberId);
    if (targetId === undefined) return failure("INVALID_MEMBER_MAPPING", "memberMapping");
    const invalidAmount = validateMinorAmount(amountMinor, "allocations");
    if (invalidAmount) return invalidAmount;
    sum += BigInt(amountMinor);
    allocations.push({ memberId: targetId, amountMinor });
  }
  if (sum !== BigInt(split.total.amountMinor)) return failure("TOTAL_MISMATCH", "allocations");
  return { ok: true, value: { total: split.total, allocations } };
}

function mapExpense(history: QuickHistoryRecord, activity: ActivityDetail, request: QuickSplitConversionRequest): Result<FinanceExpense> {
  const split = projectQuickConversion(history, activity, request.memberMapping);
  if (!split.ok) return split;
  return { ok: true, value: {
    id: `quick-conversion:${request.requestId}`,
    ...(request.expenseName === undefined ? {} : { name: request.expenseName }),
    split: split.value,
    merchantPayment: request.merchantPayment,
    splitMode: history.snapshot.split.explanation.kind,
    allocationVersion: history.snapshot.split.allocationVersion,
    ...(usesAdvancedSplit(history.input) && { splitInput: mapSplitInput(history.input, request.memberMapping) }),
  } };
}

/** The source member order is part of the saved rounding calculation. */
function mapSplitInput(input: QuickSplitInput, mapping: readonly MemberMapping[]): QuickSplitInput {
  const ids = new Map(mapping.map(({ quickMemberId, activityMemberId }) => [quickMemberId, activityMemberId]));
  const id = (source: string) => {
    const target = ids.get(source);
    if (!target) throw new Error("Missing expense participant mapping");
    return target;
  };
  const member = <T extends { memberId: string }>(value: T) => ({ ...value, memberId: id(value.memberId) });
  const host = <T extends { hostId: string }>(value: T) => ({ ...value, hostId: id(value.hostId) });
  const distribution = (rule?: ChargeDistribution) =>
    rule?.kind === "selected" ? { ...rule, memberIds: rule.memberIds.map(id) } : rule;
  const { method, charges } = input;
  let mapped: QuickSplitMethod;
  switch (method.kind) {
    case "equal": mapped = { ...method, memberIds: method.memberIds.map(id) }; break;
    case "treat":
      mapped = { ...method, memberIds: method.memberIds.map(id), options: "hosts" in method.options
        ? { hosts: method.options.hosts.map(host) } : host(method.options) };
      break;
    case "individual":
      mapped = "items" in method
        ? { ...method, memberIds: method.memberIds.map(id), items: method.items.map((item) => ({ ...item, memberIds: item.memberIds.map(id) })) }
        : { ...method, personalSpending: method.personalSpending.map(member),
          shared: { ...method.shared, memberIds: method.shared.memberIds.map(id) } };
      break;
    case "custom": {
      const { options } = method;
      mapped = { kind: "custom", options: options.kind === "fixed" ? { ...options, members: options.members.map(member) }
        : options.kind === "percentage" ? { ...options, members: options.members.map(member) }
        : { ...options, members: options.members.map(member) } };
      break;
    }
  }
  return { members: input.members.map((entry) => ({ ...entry, id: id(entry.id) })), method: mapped,
    charges: charges.kind === "details" && charges.distribution
      ? { ...charges, distribution: { serviceFee: distribution(charges.distribution.serviceFee), discount: distribution(charges.distribution.discount) } }
      : charges,
  };
}

export function createQuickSplitConversionService(database: LocalDatabase, hasProAccess: ProAccess = freeAccess) {
  return {
    getSource(historyId: string): Promise<ConversionSource | null> {
      return database.read(async (connection) => {
        const history = await readQuickHistory(connection, historyId);
        if (!history) return null;
        const destination = await connection.getFirstAsync<ConversionDestination>(`
          SELECT c.activity_id AS activityId, a.name AS activityName
          FROM quick_split_conversions AS c JOIN activities AS a ON a.id = c.activity_id
          WHERE c.history_id = ?
        `, historyId);
        return { history, destination };
      });
    },

    listTargets(currency: Currency): Promise<ConversionTarget[]> {
      return database.read((connection) => connection.getAllAsync<ConversionTarget>(`
        SELECT a.id, a.name, a.status, a.currency,
          (SELECT COUNT(*) FROM activity_members WHERE activity_id = a.id) AS memberCount,
          (SELECT COUNT(*) FROM expenses WHERE activity_id = a.id) AS expenseCount
        FROM activities AS a WHERE a.currency = ?
        ORDER BY a.status, a.updated_at DESC, a.created_at DESC, a.id
      `, currency));
    },

    async convertQuickHistory(input: QuickSplitConversionRequest): Promise<Result<QuickSplitConversionReceipt>> {
      try {
        const { requestId, historyId, activityId, occurredAt } = input;
        if (input.expenseName !== undefined && !validId(input.expenseName)) return failure("INVALID_EXPENSE_NAME", "expenseName");
        const expenseName = input.expenseName?.trim();
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
        const request = { requestId, historyId, activityId, occurredAt, merchantPayment, memberMapping,
          ...(expenseName === undefined ? {} : { expenseName }) };
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

          const event = await insertNewExpenseInTransaction(transaction, activityId, occurredAt, expense.value, hasProAccess);
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
