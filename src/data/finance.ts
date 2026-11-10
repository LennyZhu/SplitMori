import {
  calculateBalances, type ActivityEventBalances, type Expense, type MemberTransfer, type MerchantRefund,
} from "../domain/balance.ts";
import { previewExpenseCorrection, type ExpenseCorrectionPreview } from "../domain/correction.ts";
import type { Currency } from "../domain/money.ts";
import { calculateQuickSplit, type QuickSplitInput } from "../domain/quickSplit.ts";
import { allocateProportionalRefund, remainingRefundShares } from "../domain/refundAllocation.ts";
import { failure, type Result } from "../domain/result.ts";
import { suggestTransfers, type TransferSuggestion } from "../domain/settlement.ts";
import type { Allocation } from "../domain/split.ts";
import { freeAccess, type ProAccess } from "../services/proEntitlement.ts";
import type { ActivityStatus } from "./activities.ts";
import type { LocalDatabase, SQLiteConnection, SQLiteReader } from "./database.ts";
import {
  insertExpenseRevision, nextFinanceSequence, readExpenseRevisions, type ExpenseVersion, type StoredExpenseRevision,
} from "./financeRevisions.ts";
import {
  findFinancialVoid, insertFinancialVoid, readFinancialVoids, type FinancialVoidRequest, type StoredFinancialVoid,
} from "./financeVoids.ts";
import { migrations } from "./migrations.ts";

const splitModes = ["equal", "treat", "individual", "custom"] as const;
export type FinanceExpense = Expense & {
  readonly name?: string;
  /** The bill date is separate from the audit event's position in the ledger. */
  readonly expenseDate?: number;
  readonly splitInput?: QuickSplitInput;
  readonly splitMode: typeof splitModes[number];
  readonly allocationVersion: number;
};

type ExpenseEvent = { readonly kind: "expense"; readonly expense: FinanceExpense };
export type FinanceMemberTransfer = MemberTransfer & { readonly note?: string };
export type FinanceMerchantRefund = MerchantRefund & {
  readonly note?: string;
  readonly distribution?: "proportional";
  readonly recordedAt?: number;
};
export type MerchantRefundInput = Omit<FinanceMerchantRefund, "kind" | "reductions" | "distribution" | "recordedAt">;

type FinanceEvent = ExpenseEvent | FinanceMerchantRefund | FinanceMemberTransfer;

export type ExpectedTransferBalances = { readonly fromNetBalanceMinor: number; readonly toNetBalanceMinor: number };

export type StoredFinanceEvent<T extends FinanceEvent = FinanceEvent> = T & {
  /** Unix time in milliseconds. Equal times are ordered by insertion sequence. */
  readonly occurredAt: number;
  readonly sequence: number;
};

export type StoredExpense = StoredFinanceEvent<ExpenseEvent>;

type CurrentExpense = StoredFinanceEvent<ExpenseEvent> & { readonly currentVersion: number };

export type ExpenseDetail = CurrentExpense & {
  readonly refunds: readonly StoredFinanceEvent<FinanceMerchantRefund>[];
  readonly refundVoids: readonly StoredFinancialVoid[];
};

type AuditEvent = StoredFinanceEvent | StoredFinancialVoid;

export type ActivityLedger = {
  readonly events: readonly AuditEvent[];
  readonly revisions: readonly StoredExpenseRevision[];
  readonly balanceSnapshot: ActivityEventBalances;
  readonly suggestions: readonly TransferSuggestion[];
};

export type ExpenseCorrectionRequest = {
  readonly expenseId: string;
  readonly revisionId: string;
  readonly expectedVersion: number;
  readonly occurredAt: number;
  readonly proposed: FinanceExpense;
  /** Refund IDs whose unchanged reductions were explicitly reviewed in the preview. */
  readonly reviewedRefundIds?: readonly string[];
  /** The interactive flow submits the token from its reviewed ledger. */
  readonly expectedLedger?: string;
};

export type ReviewedExpenseCorrectionRequest = ExpenseCorrectionRequest & { readonly expectedLedger: string };

export type FinanceCorrectionPreview = Omit<ExpenseCorrectionPreview, "expense"> & {
  readonly currentVersion: number;
  readonly ledgerToken: string;
  readonly beforeSuggestions: readonly TransferSuggestion[];
  readonly beforeDate: number;
  readonly afterDate: number;
  readonly expense: ExpenseCorrectionPreview["expense"] & {
    readonly before: FinanceExpense;
    readonly after: FinanceExpense;
  };
};

type LedgerEntry = AuditEvent | StoredExpenseRevision;

type RefundImpact = {
  readonly ledgerToken: string;
  readonly before: ActivityEventBalances;
  readonly after: ActivityEventBalances;
  readonly beforeSuggestions: readonly TransferSuggestion[];
  readonly afterSuggestions: readonly TransferSuggestion[];
  readonly beforeShares: readonly Allocation[];
  readonly afterShares: readonly Allocation[];
  readonly expense: FinanceExpense;
  readonly currentVersion: number;
};
export type MerchantRefundPreview = RefundImpact & { readonly refund: FinanceMerchantRefund; readonly occurredAt: number };
export type MerchantRefundVoidPreview = RefundImpact & {
  readonly refund: StoredFinanceEvent<FinanceMerchantRefund>;
  readonly request: FinancialVoidRequest;
};

function refundLedgerToken(activity: ActivityContext, timeline: readonly LedgerEntry[], action: unknown) {
  return JSON.stringify([activity, timeline, action]);
}

function refundVoidTokenAction(event: Omit<StoredFinancialVoid, "sequence">) {
  // A void appends to the reviewed ledger. Its timestamp is set when the user confirms.
  return ["voidRefund", event.id, event.targetEventId, event.reason];
}

function prepareMerchantRefund(input: MerchantRefundInput, reductions: readonly Allocation[], distribution?: "proportional"):
  Result<FinanceMerchantRefund> {
  const { id, expenseId, recipientId, currency, amountMinor, note } = input;
  if (typeof id !== "string" || id.trim() === "") return failure("INVALID_EVENT_ID", "eventId");
  if (note !== undefined && typeof note !== "string") return failure("INVALID_REFUND_DETAILS", "merchantRefund");
  if (distribution !== undefined && distribution !== "proportional") return failure("INVALID_REFUND_DETAILS", "merchantRefund");
  const trimmed = note?.trim();
  return { ok: true, value: {
    kind: "merchantRefund", id, expenseId, recipientId, currency, amountMinor, reductions: reductions.map((row) => ({ ...row })),
    ...(trimmed ? { note: trimmed } : {}), ...(distribution ? { distribution } : {}),
  } };
}

function compareLedgerOrder(left: LedgerEntry, right: LedgerEntry): number {
  return left.occurredAt - right.occurredAt || left.sequence - right.sequence;
}

function orderedTimeline(
  events: readonly StoredFinanceEvent[], revisions: readonly StoredExpenseRevision[], voids: readonly StoredFinancialVoid[],
): LedgerEntry[] {
  return [...events, ...revisions, ...voids].sort(compareLedgerOrder);
}

function ledgerSequence(timeline: readonly LedgerEntry[]): number {
  // A backdated write can sort earlier while still changing the reviewed ledger.
  return timeline.reduce((latest, entry) => Math.max(latest, entry.sequence), 0);
}

function correctionLedgerToken(activity: ActivityContext, timeline: readonly LedgerEntry[], replacement: FinanceExpense): string {
  // The exact facts and proposed snapshot also distinguish a restored ledger with matching sequence numbers.
  return JSON.stringify([activity, timeline, replacement]);
}

function prepareFinancialVoid(
  activityId: string, targetKind: StoredFinancialVoid["targetKind"], request: FinancialVoidRequest,
): Result<Omit<StoredFinancialVoid, "sequence">> {
  const { id, targetEventId, occurredAt } = request;
  const reason = request.reason ?? null;
  if (typeof id !== "string" || id.trim() === "") return failure("INVALID_EVENT_ID", "eventId");
  if (typeof targetEventId !== "string" || targetEventId.trim() === "" || targetEventId === id) {
    return failure("INVALID_VOID_TARGET", "targetEventId");
  }
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return failure("INVALID_EVENT_TIME", "occurredAt");
  if (reason !== null && typeof reason !== "string") return failure("INVALID_VOID_REASON", "voidReason");
  return { ok: true, value: { kind: "financialVoid", id, activityId, targetEventId, targetKind, occurredAt, reason } };
}

function sameVoid(saved: StoredFinancialVoid, event: Omit<StoredFinancialVoid, "sequence">): boolean {
  return saved.activityId === event.activityId && saved.targetKind === event.targetKind && saved.targetEventId === event.targetEventId
    && saved.occurredAt === event.occurredAt && saved.reason === event.reason;
}

function projectFinancialVoid(
  activity: ActivityContext, timeline: readonly LedgerEntry[], event: Omit<StoredFinancialVoid, "sequence">,
  expectedSequence?: number,
): Result<ActivityEventBalances> {
  if (!timeline.some((entry) => entry.kind === event.targetKind && entry.id === event.targetEventId)) {
    return failure("INVALID_VOID_TARGET", "targetEventId");
  }
  if (timeline.some((entry) => entry.kind === "financialVoid" && entry.targetEventId === event.targetEventId)) {
    return failure("EVENT_ALREADY_VOIDED", "targetEventId");
  }
  if (event.targetKind === "merchantRefund" && activity.status === "completed") return failure("ACTIVITY_COMPLETED", "activityId");
  if (expectedSequence !== undefined && ledgerSequence(timeline) !== expectedSequence) return failure("VOID_LEDGER_CHANGED", "events");
  if (timeline.some((entry) => entry.occurredAt > event.occurredAt)) return failure("VOID_OUT_OF_ORDER", "occurredAt");
  return calculateBalances(activity.currency, activity.memberIds, [], [...timeline, event]);
}

function currentExpense(
  original: StoredFinanceEvent<ExpenseEvent>, latest: StoredExpenseRevision | undefined,
): CurrentExpense {
  return { ...original, expense: latest?.expense ?? original.expense, currentVersion: latest?.version ?? 1 };
}

export function projectCurrentExpenses(
  events: readonly AuditEvent[], revisions: readonly StoredExpenseRevision[],
): CurrentExpense[] {
  const latest = new Map(revisions.map((revision) => [revision.expense.id, revision]));
  return events.filter((event) => event.kind === "expense")
    .map((event) => currentExpense(event, latest.get(event.expense.id)));
}

function latestRevision(revisions: readonly StoredExpenseRevision[], expenseId: string): StoredExpenseRevision | undefined {
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    if (revisions[index].expense.id === expenseId) return revisions[index];
  }
}

function expenseRefundContext(timeline: readonly LedgerEntry[], expenseId: string) {
  const current = timeline.findLast((entry) => (entry.kind === "expense" || entry.kind === "expenseRevision") && entry.expense.id === expenseId);
  if (current?.kind !== "expense" && current?.kind !== "expenseRevision") return;
  const voided = new Set(timeline.flatMap((entry) => entry.kind === "financialVoid" && entry.targetKind === "merchantRefund"
    ? [entry.targetEventId] : []));
  const activeRefunds = timeline.filter((entry): entry is StoredFinanceEvent<FinanceMerchantRefund> =>
    entry.kind === "merchantRefund" && entry.expenseId === expenseId && !voided.has(entry.id));
  return {
    expense: current.expense, currentVersion: current.kind === "expense" ? 1 : current.version, activeRefunds,
    beforeShares: remainingRefundShares(current.expense.split.allocations, activeRefunds),
  };
}

function projectRefundImpact(
  activity: ActivityContext, timeline: readonly LedgerEntry[], context: NonNullable<ReturnType<typeof expenseRefundContext>>,
  after: ActivityEventBalances, nextRefunds: readonly MerchantRefund[], action: unknown,
): Result<RefundImpact> {
  const before = calculateBalances(activity.currency, activity.memberIds, [], timeline);
  if (!before.ok) return before;
  const oldSuggestions = suggestTransfers(before.value);
  if (!oldSuggestions.ok) return oldSuggestions;
  const newSuggestions = suggestTransfers(after);
  if (!newSuggestions.ok) return newSuggestions;
  return { ok: true, value: {
    ledgerToken: refundLedgerToken(activity, timeline, action), before: before.value, after,
    beforeSuggestions: oldSuggestions.value, afterSuggestions: newSuggestions.value,
    expense: context.expense, currentVersion: context.currentVersion, beforeShares: context.beforeShares,
    afterShares: remainingRefundShares(context.expense.split.allocations, nextRefunds),
  } };
}

type ActivityContext = {
  id: string;
  currency: Currency;
  status: ActivityStatus;
  updatedAt: number;
  activeCount: number;
  memberIds: readonly string[];
};

type EventRow = {
  id: string;
  kind: FinanceEvent["kind"];
  occurredAt: number;
  sequence: number;
  amountMinor: number | null;
  expenseCurrency: Currency | null;
  expenseName: string | null;
  expenseDate: number | null;
  splitInput: string | null;
  splitMode: FinanceExpense["splitMode"] | null;
  allocationVersion: number | null;
  expenseId: string | null;
  recipientId: string | null;
  fromMemberId: string | null;
  toMemberId: string | null;
  transferNote: string | null;
  refundNote: string | null;
  refundDistribution: FinanceMerchantRefund["distribution"] | null;
  refundRecordedAt: number | null;
};

async function readActivity(connection: SQLiteReader, id: string): Promise<ActivityContext | null> {
  const activity = await connection.getFirstAsync<Omit<ActivityContext, "memberIds">>(
    `SELECT id, currency, status, updated_at AS updatedAt,
      (SELECT COUNT(*) FROM activities WHERE status = 'active') AS activeCount FROM activities WHERE id = ?`, id,
  );
  if (!activity) return null;
  const members = await connection.getAllAsync<{ memberId: string }>(`
    SELECT member_id AS memberId FROM activity_members WHERE activity_id = ? ORDER BY position
  `, id);
  return { ...activity, memberIds: members.map(({ memberId }) => memberId) };
}

export function expenseEditBlocker(status: ActivityStatus, activeCount: number, mode: FinanceExpense["splitMode"], hasProAccess = false):
  "ACTIVITY_COMPLETED" | "EXPENSE_EDIT_LIMIT" | "UNSUPPORTED_EXPENSE_EDIT" | undefined {
  if (status === "completed") return "ACTIVITY_COMPLETED";
  if (activeCount > 1 && !hasProAccess) return "EXPENSE_EDIT_LIMIT";
  if (mode === "custom") return "UNSUPPORTED_EXPENSE_EDIT";
}

function correctionReplacement(previous: FinanceExpense, proposed: FinanceExpense): FinanceExpense {
  const name = proposed.name ?? previous.name;
  const expenseDate = proposed.expenseDate ?? previous.expenseDate;
  return { ...proposed, ...(name === undefined ? {} : { name }), ...(expenseDate === undefined ? {} : { expenseDate }) };
}

function groupAllocations(rows: readonly (Allocation & { ownerId: string })[]): Map<string, Allocation[]> {
  const groups = new Map<string, Allocation[]>();
  for (const { ownerId, memberId, amountMinor } of rows) {
    const entry = { memberId, amountMinor };
    const group = groups.get(ownerId);
    if (group) group.push(entry);
    else groups.set(ownerId, [entry]);
  }
  return groups;
}

async function readEvents(connection: SQLiteReader, activity: ActivityContext, schemaVersion: number = migrations.length): Promise<StoredFinanceEvent[]> {
  const { id: activityId, currency } = activity;
  const rows = await connection.getAllAsync<EventRow>(`
    SELECT f.id, f.kind, f.occurred_at AS occurredAt, f.sequence,
           COALESCE(e.amount_minor, r.amount_minor, t.amount_minor) AS amountMinor,
           e.currency AS expenseCurrency, ${schemaVersion >= 7 ? "e.name" : "NULL"} AS expenseName,
           ${schemaVersion >= 9 ? "e.expense_date" : "NULL"} AS expenseDate,
           ${schemaVersion >= 9 ? "e.split_input" : "NULL"} AS splitInput,
           e.split_mode AS splitMode, e.allocation_version AS allocationVersion,
           r.expense_id AS expenseId, r.recipient_id AS recipientId,
           t.from_member_id AS fromMemberId, t.to_member_id AS toMemberId,
           ${schemaVersion >= 8 ? "t.note" : "NULL"} AS transferNote,
           ${schemaVersion >= 11 ? "r.note" : "NULL"} AS refundNote,
           ${schemaVersion >= 11 ? "r.distribution" : "NULL"} AS refundDistribution,
           ${schemaVersion >= 11 ? "r.recorded_at" : "NULL"} AS refundRecordedAt
    FROM financial_events AS f
    LEFT JOIN expenses AS e ON e.id = f.id AND e.activity_id = f.activity_id AND f.kind = 'expense'
    LEFT JOIN merchant_refunds AS r ON r.id = f.id AND r.activity_id = f.activity_id AND f.kind = 'merchantRefund'
    LEFT JOIN member_transfers AS t ON t.id = f.id AND t.activity_id = f.activity_id AND f.kind = 'memberTransfer'
    WHERE f.activity_id = ? ORDER BY f.occurred_at, f.sequence
  `, activityId);
  const allocations = groupAllocations(await connection.getAllAsync<Allocation & { ownerId: string }>(`
    SELECT expense_id AS ownerId, member_id AS memberId, amount_minor AS amountMinor
    FROM expense_allocations WHERE activity_id = ? ORDER BY expense_id, position
  `, activityId));
  const payments = groupAllocations(await connection.getAllAsync<Allocation & { ownerId: string }>(`
    SELECT expense_id AS ownerId, member_id AS memberId, amount_minor AS amountMinor
    FROM merchant_payments WHERE activity_id = ?
  `, activityId));
  const reductions = groupAllocations(await connection.getAllAsync<Allocation & { ownerId: string }>(`
    SELECT r.refund_id AS ownerId, r.member_id AS memberId, r.amount_minor AS amountMinor
    FROM refund_reductions AS r
    JOIN activity_members AS a ON a.activity_id = r.activity_id AND a.member_id = r.member_id
    WHERE r.activity_id = ? ORDER BY r.refund_id, a.position
  `, activityId));

  return rows.map((row): StoredFinanceEvent => {
    const { id, kind, occurredAt, sequence, amountMinor } = row;
    const order = { occurredAt, sequence };
    if (kind === "expense" && amountMinor !== null && row.expenseCurrency && row.splitMode
      && row.allocationVersion !== null) {
      const expenseAllocations = allocations.get(id);
      const merchantPayments = payments.get(id);
      if (expenseAllocations && merchantPayments?.length === 1) {
        return {
          ...order, kind, expense: {
            id, splitMode: row.splitMode, allocationVersion: row.allocationVersion,
            ...(row.expenseName === null ? {} : { name: row.expenseName }),
            ...(row.expenseDate === null ? {} : { expenseDate: row.expenseDate }),
            ...(row.splitInput === null ? {} : { splitInput: JSON.parse(row.splitInput) as QuickSplitInput }),
            split: { total: { currency: row.expenseCurrency, amountMinor }, allocations: expenseAllocations },
            merchantPayment: { ...merchantPayments[0], currency: row.expenseCurrency },
          },
        };
      }
    }
    if (kind === "merchantRefund" && amountMinor !== null && row.expenseId && row.recipientId) {
      const refundReductions = reductions.get(id);
      if (refundReductions) {
        return { ...order, kind, id, currency, amountMinor, expenseId: row.expenseId,
          recipientId: row.recipientId, reductions: refundReductions,
          ...(row.refundNote == null ? {} : { note: row.refundNote }),
          ...(row.refundDistribution == null ? {} : { distribution: row.refundDistribution }),
          ...(row.refundRecordedAt == null ? {} : { recordedAt: row.refundRecordedAt }) };
      }
    }
    if (kind === "memberTransfer" && amountMinor !== null && row.fromMemberId && row.toMemberId) {
      return { ...order, kind, id, currency, amountMinor, fromMemberId: row.fromMemberId, toMemberId: row.toMemberId,
        ...(row.transferNote === null ? {} : { note: row.transferNote }) };
    }
    throw new Error(`Invalid stored financial event ${id}`);
  });
}

/** Replays the financial facts on a read-only backup connection without migrations or writes. */
export async function validateStoredLedgers(connection: SQLiteReader, schemaVersion: number): Promise<Result<true>> {
  const rows = await connection.getAllAsync<{ id: string }>("SELECT id FROM activities ORDER BY id");
  for (const { id } of rows) {
    const activity = await readActivity(connection, id);
    if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
    const events = schemaVersion >= 2 ? await readEvents(connection, activity, schemaVersion) : [];
    const revisions = schemaVersion >= 3 ? await readExpenseRevisions(connection, id, schemaVersion) : [];
    const voids = schemaVersion >= 6 ? await readFinancialVoids(connection, id) : [];
    for (const entry of [...events, ...revisions]) {
      if (entry.kind !== "expense" && entry.kind !== "expenseRevision") continue;
      const invalid = validateSplitSnapshot(entry.expense);
      if (invalid) return invalid;
    }
    const balances = calculateBalances(activity.currency, activity.memberIds, [], orderedTimeline(events, revisions, voids));
    if (!balances.ok) return balances;
  }
  return { ok: true, value: true };
}

function eventId(event: FinanceEvent): string {
  return event.kind === "expense" ? event.expense.id : event.id;
}

function sameAllocations(saved: readonly Allocation[], requested: readonly Allocation[]): boolean {
  if (saved.length !== requested.length) return false;
  const amounts = new Map(requested.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  return amounts.size === saved.length && saved.every(({ memberId, amountMinor }) => amounts.get(memberId) === amountMinor);
}

function sameEvent(saved: FinanceEvent, requested: FinanceEvent): boolean {
  if (saved.kind === "expense" && requested.kind === "expense") {
    return sameExpense(saved.expense, requested.expense);
  }
  if (saved.kind === "merchantRefund" && requested.kind === "merchantRefund") {
    return saved.expenseId === requested.expenseId && saved.recipientId === requested.recipientId
      && saved.currency === requested.currency && saved.amountMinor === requested.amountMinor
      && saved.note === requested.note && saved.distribution === requested.distribution
      && sameAllocations(saved.reductions, requested.reductions ?? []);
  }
  if (saved.kind === "memberTransfer" && requested.kind === "memberTransfer") {
    return saved.fromMemberId === requested.fromMemberId && saved.toMemberId === requested.toMemberId
      && saved.currency === requested.currency && saved.amountMinor === requested.amountMinor && saved.note === requested.note;
  }
  return false;
}

function sameExpense(original: FinanceExpense, input: FinanceExpense): boolean {
  return original.id === input.id
    && original.name === input.name && original.expenseDate === input.expenseDate
    && JSON.stringify(original.splitInput) === JSON.stringify(input.splitInput)
    && original.splitMode === input.splitMode && original.allocationVersion === input.allocationVersion
    && original.split.total.currency === input.split.total.currency
    && original.split.total.amountMinor === input.split.total.amountMinor
    && original.merchantPayment.memberId === input.merchantPayment?.memberId
    && original.merchantPayment.currency === input.merchantPayment.currency
    && original.merchantPayment.amountMinor === input.merchantPayment.amountMinor
    && sameAllocations(original.split.allocations, input.split.allocations);
}

function copyExpense(expense: FinanceExpense): FinanceExpense {
  return {
    ...expense,
    split: { total: { ...expense.split.total }, allocations: expense.split.allocations.map((row) => ({ ...row })) },
    merchantPayment: expense.merchantPayment && { ...expense.merchantPayment },
    ...(expense.splitInput === undefined ? {} : { splitInput: JSON.parse(JSON.stringify(expense.splitInput)) as QuickSplitInput }),
  };
}

function validateSplitSnapshot(expense: FinanceExpense) {
  if (!splitModes.includes(expense.splitMode)
    || !Number.isSafeInteger(expense.allocationVersion) || expense.allocationVersion < 1) {
    return failure("INVALID_SPLIT_SNAPSHOT", "allocations");
  }
  if (expense.name !== undefined && (typeof expense.name !== "string" || expense.name.trim() === "")) {
    return failure("INVALID_EXPENSE_NAME", "expenseName");
  }
  if (expense.expenseDate !== undefined && (!Number.isSafeInteger(expense.expenseDate) || expense.expenseDate < 0
    || !Number.isFinite(new Date(expense.expenseDate).getTime()))) return failure("INVALID_EVENT_TIME", "occurredAt");
  if (expense.splitInput !== undefined) {
    try {
      const input = expense.splitInput;
      const result = calculateQuickSplit(input);
      if (input.merchantPayerId === undefined && input.method.kind === expense.splitMode && result.ok
        && result.value.split.total.currency === expense.split.total.currency
        && result.value.split.total.amountMinor === expense.split.total.amountMinor
        && result.value.split.allocationVersion === expense.allocationVersion
        && sameAllocations(result.value.split.allocations, expense.split.allocations)) return;
    } catch {
      // Invalid input metadata must never be persisted as part of a financial snapshot.
    }
    return failure("INVALID_SPLIT_SNAPSHOT", "allocations");
  }
}

async function insertEvent(
  transaction: SQLiteConnection, activity: ActivityContext, occurredAt: number, event: FinanceEvent,
): Promise<StoredFinanceEvent> {
  const id = eventId(event);
  const { id: activityId } = activity;
  const inserted = await transaction.getFirstAsync<{ sequence: number }>(`
    INSERT INTO financial_events (sequence, id, activity_id, kind, occurred_at)
    VALUES (${nextFinanceSequence}, ?, ?, ?, ?)
    RETURNING sequence
  `, id, activityId, event.kind, occurredAt);
  if (!inserted) throw new Error("Financial event was not inserted");
  const order = { occurredAt, sequence: inserted.sequence };

  if (event.kind === "expense") {
    const { expense } = event;
    const { split, merchantPayment, splitMode, allocationVersion, name, expenseDate, splitInput } = expense;
    const { currency, amountMinor } = split.total;
    await transaction.runAsync(`
      INSERT INTO expenses (id, activity_id, currency, amount_minor, split_mode, allocation_version, name, expense_date, split_input)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, activityId, currency, amountMinor, splitMode, allocationVersion, name ?? null, expenseDate ?? null,
    splitInput === undefined ? null : JSON.stringify(splitInput));

    const amounts = new Map(split.allocations.map((allocation) => [allocation.memberId, allocation.amountMinor]));
    const allocations: Allocation[] = [];
    for (const [position, memberId] of activity.memberIds.entries()) {
      const share = amounts.get(memberId);
      if (share === undefined) continue;
      await transaction.runAsync(`
        INSERT INTO expense_allocations (activity_id, expense_id, member_id, amount_minor, position)
        VALUES (?, ?, ?, ?, ?)
      `, activityId, id, memberId, share, position);
      allocations.push({ memberId, amountMinor: share });
    }
    await transaction.runAsync(`
      INSERT INTO merchant_payments (activity_id, expense_id, member_id, amount_minor) VALUES (?, ?, ?, ?)
    `, activityId, id, merchantPayment.memberId, merchantPayment.amountMinor);
    return {
      ...order, kind: "expense", expense: {
        ...expense,
        split: { total: { currency, amountMinor }, allocations },
        merchantPayment: { memberId: merchantPayment.memberId, currency, amountMinor: merchantPayment.amountMinor },
      },
    };
  }

  if (event.kind === "merchantRefund") {
    const { expenseId, recipientId, amountMinor, note, distribution, recordedAt } = event;
    await transaction.runAsync(`
      INSERT INTO merchant_refunds (id, activity_id, expense_id, recipient_id, amount_minor, note, distribution, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, id, activityId, expenseId, recipientId, amountMinor, note ?? null, distribution ?? null, recordedAt ?? null);
    const amounts = new Map(event.reductions.map((reduction) => [reduction.memberId, reduction.amountMinor]));
    const reductions: Allocation[] = [];
    for (const memberId of activity.memberIds) {
      const reduction = amounts.get(memberId);
      if (reduction === undefined) continue;
      await transaction.runAsync(`
        INSERT INTO refund_reductions (activity_id, expense_id, refund_id, member_id, amount_minor)
        VALUES (?, ?, ?, ?, ?)
      `, activityId, expenseId, id, memberId, reduction);
      reductions.push({ memberId, amountMinor: reduction });
    }
    return { ...order, ...event, reductions };
  }

  const { fromMemberId, toMemberId, amountMinor, currency, note } = event;
  await transaction.runAsync(`
    INSERT INTO member_transfers (id, activity_id, from_member_id, to_member_id, amount_minor, note) VALUES (?, ?, ?, ?, ?, ?)
  `, id, activityId, fromMemberId, toMemberId, amountMinor, note ?? null);
  return { ...order, kind: event.kind, id, fromMemberId, toMemberId, amountMinor, currency,
    ...(note === undefined ? {} : { note }) };
}

async function withStorage<T>(task: () => Promise<Result<T>>, onError?: (error: unknown) => void): Promise<Result<T>> {
  try {
    return await task();
  } catch (error) {
    onError?.(error);
    return failure("FINANCE_STORAGE_ERROR", "storage");
  }
}

function logCorrectionStorageError(revisionId: string, stage: string, error: unknown) {
  if (typeof __DEV__ === "undefined" || !__DEV__) return;
  const rawCode = error instanceof Error && "code" in error ? error.code : undefined;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : "FINANCE_STORAGE_ERROR";
  console.warn("[SplitMori correction]", {
    revisionId, stage, code, errorType: error instanceof AggregateError ? "AggregateError" : error instanceof Error ? "Error" : typeof error,
  });
}

function refundReviewKey(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

async function readCorrectionReceipt(
  connection: SQLiteReader, activityId: string, request: ExpenseCorrectionRequest,
): Promise<Result<StoredExpenseRevision | null>> {
  const { expenseId, revisionId, expectedVersion, occurredAt, proposed } = request;
  if (revisionId === expenseId) return failure("REVISION_ID_CONFLICT", "revisionId");
  const receipt = await connection.getFirstAsync<{ activityId: string; expenseId: string; refundReview: string }>(
    "SELECT activity_id AS activityId, expense_id AS expenseId, reviewed_refund_ids AS refundReview FROM expense_revisions WHERE id = ?",
    revisionId,
  );
  if (!receipt) return { ok: true, value: null };
  if (receipt.activityId !== activityId || receipt.expenseId !== expenseId
    || receipt.refundReview !== refundReviewKey(new Set(request.reviewedRefundIds))) {
    return failure("REVISION_ID_CONFLICT", "revisionId");
  }
  const revisions = await readExpenseRevisions(connection, activityId);
  const saved = revisions.find(({ id }) => id === revisionId);
  if (!saved || saved.version - 1 !== expectedVersion || saved.occurredAt !== occurredAt) {
    return failure("REVISION_ID_CONFLICT", "revisionId");
  }
  if (sameExpense(saved.expense, proposed)) return { ok: true, value: saved };

  // Earlier repository callers could omit the bill name or date and inherit them.
  const activity = await readActivity(connection, activityId);
  if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
  const previous = expectedVersion === 1
    ? (await readEvents(connection, activity)).find((event): event is StoredExpense =>
      event.kind === "expense" && event.expense.id === expenseId)?.expense
    : revisions.find(({ expense, version }) => expense.id === expenseId && version === expectedVersion)?.expense;
  return previous && sameExpense(saved.expense, correctionReplacement(previous, proposed))
    ? { ok: true, value: saved } : failure("REVISION_ID_CONFLICT", "revisionId");
}

function projectRecordedEvent(
  activity: ActivityContext, ordered: readonly LedgerEntry[], occurredAt: number, event: FinanceEvent, reviewedRefund = false,
): Result<ActivityEventBalances> {
  const next = ordered.findIndex((entry) => entry.occurredAt > occurredAt);
  const index = next === -1 ? ordered.length : next;
  const backdatedTransfer = event.kind === "memberTransfer" && next !== -1;
  // A backdated repayment must be valid both against current balances and at its place in history.
  if (backdatedTransfer) {
    const current = calculateBalances(activity.currency, activity.memberIds, [], [...ordered, event]);
    if (!current.ok) return current;
  }
  const balances = calculateBalances(activity.currency, activity.memberIds, [], [...ordered.slice(0, index), event, ...ordered.slice(index)]);
  if (balances.ok || next === -1) return balances;
  if (backdatedTransfer) return failure("TRANSFER_DATE_CONFLICT", "occurredAt");
  if (reviewedRefund) return failure("REFUND_DATE_CONFLICT", "occurredAt");
  return balances;
}

async function recordInTransaction(
  transaction: SQLiteConnection, activityId: string, occurredAt: number, event: FinanceEvent, allowRetry = true,
  expectedBalances?: ExpectedTransferBalances, expectedRefundLedger?: string, hasProAccess: ProAccess = freeAccess,
): Promise<Result<StoredFinanceEvent>> {
  const id = eventId(event);
  if (typeof id !== "string" || id.trim() === "") {
    return event.kind === "expense" ? failure("INVALID_EXPENSE_ID", "expenseId") : failure("INVALID_EVENT_ID", "eventId");
  }
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return failure("INVALID_EVENT_TIME", "occurredAt");

  const existing = await transaction.getFirstAsync<{ activityId: string }>(
    "SELECT activity_id AS activityId FROM financial_events WHERE id = ?", id,
  );
  if (existing && (!allowRetry || existing.activityId !== activityId)) return failure("EVENT_ID_CONFLICT", "eventId");
  if (await findFinancialVoid(transaction, id)) return failure("EVENT_ID_CONFLICT", "eventId");

  const activity = await readActivity(transaction, activityId);
  if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
  const history = await readEvents(transaction, activity);
  if (existing) {
    const saved = history.find((entry) => eventId(entry) === id);
    if (!saved || saved.occurredAt !== occurredAt || !sameEvent(saved, event)) {
      return failure("EVENT_ID_CONFLICT", "eventId");
    }
    return { ok: true, value: saved };
  }
  if (activity.status === "completed" && event.kind !== "memberTransfer") {
    return failure("ACTIVITY_COMPLETED", "activityId");
  }
  if (event.kind === "memberTransfer" && occurredAt > Date.now()) return failure("INVALID_EVENT_TIME", "occurredAt");
  if (event.kind === "expense") {
    if (activity.activeCount > 1 && !hasProAccess()) return failure("EXPENSE_EDIT_LIMIT", "activityId");
    const invalid = validateSplitSnapshot(event.expense);
    if (invalid) return invalid;
  }

  const ordered = orderedTimeline(
    history, await readExpenseRevisions(transaction, activityId), await readFinancialVoids(transaction, activityId),
  );
  if (event.kind === "merchantRefund" && expectedRefundLedger !== undefined) {
    if (refundLedgerToken(activity, ordered, [occurredAt, event]) !== expectedRefundLedger) {
      return failure("REFUND_LEDGER_CHANGED", "events");
    }
    if (!Number.isFinite(new Date(occurredAt).getTime()) || occurredAt > Date.now()) return failure("INVALID_EVENT_TIME", "occurredAt");
    const context = expenseRefundContext(ordered, event.expenseId);
    if (!context) return failure("EXPENSE_NOT_FOUND", "expenseId");
    const reductions = allocateProportionalRefund(event.amountMinor, context.beforeShares);
    if (!reductions.ok) return reductions;
    if (event.distribution !== "proportional" || !sameAllocations(event.reductions, reductions.value)) {
      return failure("INVALID_REFUND_DETAILS", "refundReductions");
    }
  }
  const balances = projectRecordedEvent(activity, ordered, occurredAt, event, expectedRefundLedger !== undefined);
  if (!balances.ok) return balances;
  if (event.kind === "memberTransfer" && expectedBalances) {
    const current = calculateBalances(activity.currency, activity.memberIds, [], ordered);
    if (!current.ok) return current;
    const from = current.value.balances.find(({ memberId }) => memberId === event.fromMemberId);
    const to = current.value.balances.find(({ memberId }) => memberId === event.toMemberId);
    if (from?.netBalanceMinor !== expectedBalances.fromNetBalanceMinor || to?.netBalanceMinor !== expectedBalances.toNetBalanceMinor) {
      return failure("TRANSFER_BALANCES_CHANGED", "memberTransfer");
    }
  }

  const persisted = event.kind === "merchantRefund" && expectedRefundLedger !== undefined
    ? { ...event, recordedAt: Date.now() } : event;
  const saved = await insertEvent(transaction, activity, occurredAt, persisted);
  return { ok: true, value: saved };
}

/** Requires an existing write transaction. A caller-owned receipt handles retries. */
export async function insertNewExpenseInTransaction(
  transaction: SQLiteConnection, activityId: string, occurredAt: number, expense: FinanceExpense, hasProAccess: ProAccess = freeAccess,
): Promise<Result<StoredExpense>> {
  const result = await recordInTransaction(transaction, activityId, occurredAt, { kind: "expense", expense }, false, undefined, undefined, hasProAccess);
  if (!result.ok) return result;
  if (result.value.kind !== "expense") throw new Error("Expected a stored expense");
  return { ok: true, value: result.value };
}

export function createFinanceRepository(database: LocalDatabase, hasProAccess: ProAccess = freeAccess) {
  function readLedger<T>(
    activityId: string,
    project: (activity: ActivityContext, events: StoredFinanceEvent[], revisions: StoredExpenseRevision[],
      voids: StoredFinancialVoid[]) => Result<T>,
  ): Promise<Result<T>> {
    return withStorage(() => database.read(async (connection) => {
      const activity = await readActivity(connection, activityId);
      if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
      return project(activity, await readEvents(connection, activity), await readExpenseRevisions(connection, activityId),
        await readFinancialVoids(connection, activityId));
    }));
  }

  function record(activityId: string, occurredAt: number, event: FinanceEvent, expectedBalances?: ExpectedTransferBalances): Promise<Result<StoredFinanceEvent>> {
    return withStorage(() => database.write((transaction) =>
      recordInTransaction(transaction, activityId, occurredAt, event, true, expectedBalances, undefined, hasProAccess)));
  }

  async function voidFinancialEvent(
    activityId: string, targetKind: StoredFinancialVoid["targetKind"], request: FinancialVoidRequest,
    expectedSequence?: number, expectedRefundLedger?: string,
  ): Promise<Result<StoredFinancialVoid>> {
    const prepared = prepareFinancialVoid(activityId, targetKind, request);
    if (!prepared.ok) return prepared;
    const event = prepared.value;
    const { id } = event;

    return withStorage(() => database.write(async (transaction) => {
      const existing = await findFinancialVoid(transaction, id);
      if (existing) {
        return sameVoid(existing, event) ? { ok: true, value: existing } : failure("EVENT_ID_CONFLICT", "eventId");
      }
      if (await transaction.getFirstAsync("SELECT id FROM financial_events WHERE id = ?", id)) {
        return failure("EVENT_ID_CONFLICT", "eventId");
      }
      const activity = await readActivity(transaction, activityId);
      if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
      const timeline = orderedTimeline(
        await readEvents(transaction, activity), await readExpenseRevisions(transaction, activityId),
        await readFinancialVoids(transaction, activityId),
      );
      if (expectedRefundLedger !== undefined) {
        if (refundLedgerToken(activity, timeline, refundVoidTokenAction(event)) !== expectedRefundLedger) {
          return failure("REFUND_LEDGER_CHANGED", "events");
        }
        if (event.occurredAt > Date.now()) return failure("INVALID_EVENT_TIME", "occurredAt");
      }
      const balances = projectFinancialVoid(activity, timeline, event, expectedSequence);
      if (!balances.ok) return balances;

      const saved = await insertFinancialVoid(transaction, event);
      return { ok: true, value: saved };
    }));
  }

  function previewCorrection(
    activity: ActivityContext, events: StoredFinanceEvent[], revisions: StoredExpenseRevision[],
    voids: StoredFinancialVoid[], expenseId: string, proposed: FinanceExpense, expectedVersion?: number,
  ): Result<FinanceCorrectionPreview> {
    if (activity.status === "completed") return failure("ACTIVITY_COMPLETED", "activityId");
    const original = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
    if (original?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
    const latest = latestRevision(revisions, expenseId);
    const current = currentExpense(original, latest);
    if (expectedVersion !== undefined && current.currentVersion !== expectedVersion) {
      return failure("EXPENSE_VERSION_CONFLICT", "expectedVersion");
    }
    const mode = current.expense.splitMode === "custom" ? "custom" : proposed.splitMode;
    const blocker = expenseEditBlocker(activity.status, activity.activeCount, expectedVersion === undefined ? "equal" : mode, hasProAccess());
    if (blocker) return failure(blocker, "activityId");
    const replacement = correctionReplacement(current.expense, proposed);
    const invalid = validateSplitSnapshot(replacement);
    if (invalid) return invalid;

    const timeline = orderedTimeline(events, revisions, voids);
    const preview = previewExpenseCorrection({
      currency: activity.currency, memberIds: activity.memberIds, expenses: [],
      events: timeline, original: current.expense, proposed: replacement,
    });
    if (!preview.ok) return preview;
    const beforeSuggestions = suggestTransfers(preview.value.before);
    if (!beforeSuggestions.ok) return beforeSuggestions;
    return { ok: true, value: {
      ...preview.value, currentVersion: current.currentVersion,
      ledgerToken: correctionLedgerToken(activity, timeline, replacement), beforeSuggestions: beforeSuggestions.value,
      beforeDate: current.expense.expenseDate ?? original.occurredAt,
      afterDate: replacement.expenseDate ?? original.occurredAt,
      expense: { ...preview.value.expense, before: current.expense, after: replacement },
    } };
  }

  function commitExpenseCorrection(activityId: string, request: ExpenseCorrectionRequest): Promise<Result<StoredExpenseRevision>> {
    const { expenseId, revisionId, expectedVersion, occurredAt, expectedLedger } = request;
    if (typeof revisionId !== "string" || revisionId.trim() === "") {
      return Promise.resolve(failure("INVALID_REVISION_ID", "revisionId"));
    }
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      return Promise.resolve(failure("INVALID_EVENT_TIME", "occurredAt"));
    }
    const proposed = copyExpense(request.proposed);
    const reviewedRefundIds = new Set(request.reviewedRefundIds);
    const refundReview = refundReviewKey(reviewedRefundIds);
    const identity = { ...request, proposed, reviewedRefundIds: [...reviewedRefundIds] };
    let stage = "begin-write";

    return withStorage(() => database.write(async (transaction) => {
      stage = "lookup-existing";
      const existing = await readCorrectionReceipt(transaction, activityId, identity);
      if (!existing.ok) return existing;
      if (existing.value) {
        stage = "commit";
        return { ok: true, value: existing.value };
      }
      stage = "validate-ledger";
      const revisions = await readExpenseRevisions(transaction, activityId);
      const activity = await readActivity(transaction, activityId);
      if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
      const events = await readEvents(transaction, activity);
      const original = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);

      const voids = await readFinancialVoids(transaction, activityId);
      if (original?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
      const latest = latestRevision(revisions, expenseId);
      const currentVersion = latest?.version ?? 1;
      if (currentVersion !== expectedVersion) return failure("EXPENSE_VERSION_CONFLICT", "expectedVersion");
      if (currentVersion === Number.MAX_SAFE_INTEGER) return failure("AMOUNT_OVERFLOW", "expectedVersion");

      const timeline = orderedTimeline(events, revisions, voids);
      const replacement = correctionReplacement(latest?.expense ?? original.expense, proposed);
      if (expectedLedger !== undefined && correctionLedgerToken(activity, timeline, replacement) !== expectedLedger) {
        return failure("CORRECTION_LEDGER_CHANGED", "events");
      }
      // The audit event follows the facts reviewed in the preview, regardless of the bill date.
      if (timeline.some((event) => event.occurredAt > occurredAt)) {
        return failure("REVISION_OUT_OF_ORDER", "occurredAt");
      }
      const preview = previewCorrection(activity, events, revisions, voids, expenseId, proposed,
        expectedLedger === undefined ? undefined : expectedVersion);
      if (!preview.ok) return preview;
      const { before, after, refunds } = preview.value.expense;
      if (refunds.length > 0 && (expectedLedger !== undefined || !sameAllocations(before.split.allocations, after.split.allocations))
        && (reviewedRefundIds.size !== refunds.length || refunds.some(({ id }) => !reviewedRefundIds.has(id)))) {
        return failure("REFUND_REVIEW_REQUIRED", "reviewedRefundIds");
      }

      stage = "insert-revision";
      const saved = await insertExpenseRevision(transaction, activityId, activity.memberIds, {
        id: revisionId, version: currentVersion + 1, occurredAt, expense: after, refundReview,
      });
      stage = "commit";
      return { ok: true, value: saved };
    }), (error) => logCorrectionStorageError(revisionId, stage, error));
  }

  return {
    createExpense: (activityId: string, occurredAt: number, expense: FinanceExpense) => record(activityId, occurredAt, {
      kind: "expense", expense: copyExpense(expense),
    }),
    async recordMerchantRefund(activityId: string, occurredAt: number, refund: Omit<FinanceMerchantRefund, "kind" | "recordedAt">) {
      const event = prepareMerchantRefund(refund, refund.reductions ?? [], refund.distribution);
      return event.ok ? record(activityId, occurredAt, event.value) : event;
    },
    previewMerchantRefund(activityId: string, occurredAt: number, input: MerchantRefundInput) {
      return readLedger<MerchantRefundPreview>(activityId, (activity, events, revisions, voids) => {
        if (activity.status === "completed") return failure("ACTIVITY_COMPLETED", "activityId");
        if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || !Number.isFinite(new Date(occurredAt).getTime())
          || occurredAt > Date.now()) return failure("INVALID_EVENT_TIME", "occurredAt");
        const timeline = orderedTimeline(events, revisions, voids);
        const context = expenseRefundContext(timeline, input.expenseId);
        if (!context) return failure("EXPENSE_NOT_FOUND", "expenseId");
        const reductions = allocateProportionalRefund(input.amountMinor, context.beforeShares);
        if (!reductions.ok) return reductions;
        const refund = prepareMerchantRefund(input, reductions.value, "proportional");
        if (!refund.ok) return refund;
        if (!activity.memberIds.includes(refund.value.recipientId)) return failure("MEMBER_NOT_PARTICIPATING", "merchantRefund");
        if (input.currency !== activity.currency) return failure("CURRENCY_MISMATCH", "currency");
        const after = projectRecordedEvent(activity, timeline, occurredAt, refund.value, true);
        if (!after.ok) return after;
        const impact = projectRefundImpact(activity, timeline, context, after.value, [...context.activeRefunds, refund.value],
          [occurredAt, refund.value]);
        return impact.ok ? { ok: true, value: { ...impact.value, occurredAt, refund: refund.value } } : impact;
      });
    },
    async commitReviewedMerchantRefund(activityId: string, { occurredAt, refund, ledgerToken }:
      Pick<MerchantRefundPreview, "occurredAt" | "refund" | "ledgerToken">) {
      if (!ledgerToken) return failure("REFUND_LEDGER_CHANGED", "events");
      const event = prepareMerchantRefund(refund, refund.reductions, refund.distribution);
      if (!event.ok) return event;
      return withStorage(() => database.write((transaction) =>
        recordInTransaction(transaction, activityId, occurredAt, event.value, true, undefined, ledgerToken)));
    },
    lookupMerchantRefund(activityId: string, { occurredAt, refund }: Pick<MerchantRefundPreview, "occurredAt" | "refund">) {
      return withStorage<StoredFinanceEvent<FinanceMerchantRefund> | null>(() => database.read(async (connection) => {
        const receipt = await connection.getFirstAsync<{ activityId: string; kind: string }>(
          "SELECT activity_id AS activityId, kind FROM financial_events WHERE id = ?", refund.id,
        );
        if (!receipt) return { ok: true, value: null };
        if (receipt.activityId !== activityId || receipt.kind !== "merchantRefund") return failure("EVENT_ID_CONFLICT", "eventId");
        const activity = await readActivity(connection, activityId);
        if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
        const saved = (await readEvents(connection, activity)).find((event) => event.kind === "merchantRefund" && event.id === refund.id);
        return saved?.kind === "merchantRefund" && saved.occurredAt === occurredAt && sameEvent(saved, refund)
          ? { ok: true, value: saved } : failure("EVENT_ID_CONFLICT", "eventId");
      }));
    },
    recordMemberTransfer(activityId: string, occurredAt: number, transfer: Omit<FinanceMemberTransfer, "kind">,
      expectedBalances?: ExpectedTransferBalances) {
      if (transfer.note !== undefined && typeof transfer.note !== "string") {
        return Promise.resolve(failure("INVALID_TRANSFER_NOTE", "memberTransfer"));
      }
      return record(activityId, occurredAt, { ...transfer, kind: "memberTransfer", note: transfer.note?.trim() || undefined },
        expectedBalances && { ...expectedBalances });
    },
    voidMerchantRefund: (activityId: string, request: FinancialVoidRequest) => voidFinancialEvent(activityId, "merchantRefund", request),
    previewMerchantRefundVoid(activityId: string, expenseId: string, request: FinancialVoidRequest) {
      const candidate = { ...request };
      const event = prepareFinancialVoid(activityId, "merchantRefund", candidate);
      if (!event.ok) return Promise.resolve(event);
      if (event.value.occurredAt > Date.now()) return Promise.resolve(failure("INVALID_EVENT_TIME", "occurredAt"));
      return readLedger<MerchantRefundVoidPreview>(activityId, (activity, events, revisions, voids) => {
        const refund = events.find((entry) => entry.kind === "merchantRefund" && entry.id === candidate.targetEventId);
        if (refund?.kind !== "merchantRefund" || refund.expenseId !== expenseId) return failure("INVALID_VOID_TARGET", "targetEventId");
        const timeline = orderedTimeline(events, revisions, voids);
        const after = projectFinancialVoid(activity, timeline, event.value);
        if (!after.ok) return after;
        const context = expenseRefundContext(timeline, expenseId);
        if (!context) return failure("EXPENSE_NOT_FOUND", "expenseId");
        const impact = projectRefundImpact(activity, timeline, context, after.value,
          context.activeRefunds.filter(({ id }) => id !== refund.id), refundVoidTokenAction(event.value));
        return impact.ok ? { ok: true, value: { ...impact.value, refund, request: candidate } } : impact;
      });
    },
    async commitReviewedMerchantRefundVoid(activityId: string, { request, ledgerToken }: Pick<MerchantRefundVoidPreview, "request" | "ledgerToken">) {
      if (!ledgerToken) return failure("REFUND_LEDGER_CHANGED", "events");
      return voidFinancialEvent(activityId, "merchantRefund", request, undefined, ledgerToken);
    },
    async lookupMerchantRefundVoid(activityId: string, request: FinancialVoidRequest) {
      const event = prepareFinancialVoid(activityId, "merchantRefund", request);
      if (!event.ok) return event;
      return withStorage<StoredFinancialVoid | null>(() => database.read(async (connection) => {
        const saved = await findFinancialVoid(connection, request.id);
        if (saved && !sameVoid(saved, event.value)) return failure("EVENT_ID_CONFLICT", "eventId");
        return { ok: true, value: saved };
      }));
    },
    async previewMemberTransferVoid(activityId: string, request: FinancialVoidRequest) {
      const prepared = prepareFinancialVoid(activityId, "memberTransfer", request);
      if (!prepared.ok) return prepared;
      return readLedger<{ readonly balanceSnapshot: ActivityEventBalances; readonly expectedSequence: number }>(
        activityId, (activity, events, revisions, voids) => {
          const timeline = orderedTimeline(events, revisions, voids);
          const projected = projectFinancialVoid(activity, timeline, prepared.value);
          return projected.ok ? { ok: true, value: { balanceSnapshot: projected.value, expectedSequence: ledgerSequence(timeline) } }
            : projected;
        });
    },
    voidMemberTransfer: (activityId: string, request: FinancialVoidRequest, expectedSequence?: number) =>
      voidFinancialEvent(activityId, "memberTransfer", request, expectedSequence),
    listExpenses: (activityId: string) => readLedger(activityId, (_activity, events, revisions) => ({
      ok: true, value: projectCurrentExpenses(events, revisions),
    })),
    getExpense: (activityId: string, expenseId: string) => readLedger<ExpenseDetail>(activityId, (_activity, events, revisions, voids) => {
      const expense = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
      if (expense?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
      const refunds = events.filter((event): event is StoredFinanceEvent<FinanceMerchantRefund> =>
        event.kind === "merchantRefund" && event.expenseId === expenseId);
      const refundIds = new Set(refunds.map(({ id }) => id));
      const refundVoids = voids.filter((event) => event.targetKind === "merchantRefund" && refundIds.has(event.targetEventId));
      const latest = latestRevision(revisions, expenseId);
      return { ok: true, value: { ...currentExpense(expense, latest), refunds, refundVoids } };
    }),
    previewExpenseCorrection: (activityId: string, expenseId: string, proposed: FinanceExpense, expectedVersion?: number) => {
      const candidate = copyExpense(proposed);
      return readLedger(activityId, (activity, events, revisions, voids) =>
        previewCorrection(activity, events, revisions, voids, expenseId, candidate, expectedVersion));
    },
    commitExpenseCorrection,
    async commitReviewedExpenseCorrection(activityId: string, request: ReviewedExpenseCorrectionRequest) {
      if (!request.expectedLedger) return failure("CORRECTION_LEDGER_CHANGED", "events");
      return commitExpenseCorrection(activityId, request);
    },
    lookupReviewedExpenseCorrection: (activityId: string, request: ReviewedExpenseCorrectionRequest) =>
      withStorage(() => database.read((connection) => readCorrectionReceipt(connection, activityId, request)),
        (error) => logCorrectionStorageError(request.revisionId, "read-receipt", error)),
    listExpenseRevisions: (activityId: string, expenseId: string) => readLedger<readonly ExpenseVersion[]>(
      activityId, (_activity, events, revisions) => {
        const original = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
        if (original?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
        const baseline = { ...original, id: expenseId, version: 1 };
        return { ok: true, value: [baseline, ...revisions.filter((revision) => revision.expense.id === expenseId)] };
      },
    ),
    listEvents: (activityId: string) => readLedger(activityId, (_activity, events, _revisions, voids) => ({
      ok: true, value: [...events, ...voids].sort(compareLedgerOrder),
    })),
    getActivityLedger: (activityId: string) => readLedger<ActivityLedger>(activityId, (activity, events, revisions, voids) => {
      const timeline = orderedTimeline(events, revisions, voids);
      const balances = calculateBalances(activity.currency, activity.memberIds, [], timeline);
      if (!balances.ok) return balances;
      const suggestions = suggestTransfers(balances.value);
      if (!suggestions.ok) return suggestions;
      return { ok: true, value: {
        events: timeline.filter((entry) => entry.kind !== "expenseRevision"),
        revisions, balanceSnapshot: balances.value, suggestions: suggestions.value,
      } };
    }),
  };
}
