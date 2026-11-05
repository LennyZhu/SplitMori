import {
  calculateBalances, type ActivityEventBalances, type Expense, type MemberTransfer, type MerchantRefund,
} from "../domain/balance.ts";
import { previewExpenseCorrection, type ExpenseCorrectionPreview } from "../domain/correction.ts";
import type { Currency } from "../domain/money.ts";
import { failure, type Result } from "../domain/result.ts";
import { suggestTransfers, type TransferSuggestion } from "../domain/settlement.ts";
import type { Allocation } from "../domain/split.ts";
import type { ActivityStatus } from "./activities.ts";
import type { LocalDatabase, SQLiteConnection, SQLiteReader } from "./database.ts";
import {
  insertExpenseRevision, nextFinanceSequence, readExpenseRevisions, type ExpenseVersion, type StoredExpenseRevision,
} from "./financeRevisions.ts";

const splitModes = ["equal", "treat", "individual", "custom"] as const;
export type FinanceExpense = Expense & {
  readonly splitMode: typeof splitModes[number];
  readonly allocationVersion: number;
};

type ExpenseEvent = { readonly kind: "expense"; readonly expense: FinanceExpense };
type FinanceEvent = ExpenseEvent | MerchantRefund | MemberTransfer;

export type StoredFinanceEvent<T extends FinanceEvent = FinanceEvent> = T & {
  /** Unix time in milliseconds. Equal times are ordered by insertion sequence. */
  readonly occurredAt: number;
  readonly sequence: number;
};

export type StoredExpense = StoredFinanceEvent<ExpenseEvent>;

type CurrentExpense = StoredFinanceEvent<ExpenseEvent> & { readonly currentVersion: number };

export type ExpenseDetail = CurrentExpense & {
  readonly refunds: readonly StoredFinanceEvent<MerchantRefund>[];
};

export type ActivityLedger = {
  readonly events: readonly StoredFinanceEvent[];
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
};

export type FinanceCorrectionPreview = ExpenseCorrectionPreview & { readonly currentVersion: number };

type LedgerEntry = StoredFinanceEvent | StoredExpenseRevision;

function orderedTimeline(events: readonly StoredFinanceEvent[], revisions: readonly StoredExpenseRevision[]): LedgerEntry[] {
  return [...events, ...revisions].sort((left, right) =>
    left.occurredAt - right.occurredAt || left.sequence - right.sequence);
}

function currentExpense(
  original: StoredFinanceEvent<ExpenseEvent>, latest: StoredExpenseRevision | undefined,
): CurrentExpense {
  return { ...original, expense: latest?.expense ?? original.expense, currentVersion: latest?.version ?? 1 };
}

function latestRevision(revisions: readonly StoredExpenseRevision[], expenseId: string): StoredExpenseRevision | undefined {
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    if (revisions[index].expense.id === expenseId) return revisions[index];
  }
}

type ActivityContext = {
  id: string;
  currency: Currency;
  status: ActivityStatus;
  memberIds: readonly string[];
};

type EventRow = {
  id: string;
  kind: FinanceEvent["kind"];
  occurredAt: number;
  sequence: number;
  amountMinor: number | null;
  expenseCurrency: Currency | null;
  splitMode: FinanceExpense["splitMode"] | null;
  allocationVersion: number | null;
  expenseId: string | null;
  recipientId: string | null;
  fromMemberId: string | null;
  toMemberId: string | null;
};

async function readActivity(connection: SQLiteReader, id: string): Promise<ActivityContext | null> {
  const activity = await connection.getFirstAsync<Omit<ActivityContext, "memberIds">>(
    "SELECT id, currency, status FROM activities WHERE id = ?", id,
  );
  if (!activity) return null;
  const members = await connection.getAllAsync<{ memberId: string }>(`
    SELECT member_id AS memberId FROM activity_members WHERE activity_id = ? ORDER BY position
  `, id);
  return { ...activity, memberIds: members.map(({ memberId }) => memberId) };
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

async function readEvents(connection: SQLiteReader, activity: ActivityContext): Promise<StoredFinanceEvent[]> {
  const { id: activityId, currency } = activity;
  const rows = await connection.getAllAsync<EventRow>(`
    SELECT f.id, f.kind, f.occurred_at AS occurredAt, f.sequence,
           COALESCE(e.amount_minor, r.amount_minor, t.amount_minor) AS amountMinor,
           e.currency AS expenseCurrency, e.split_mode AS splitMode, e.allocation_version AS allocationVersion,
           r.expense_id AS expenseId, r.recipient_id AS recipientId,
           t.from_member_id AS fromMemberId, t.to_member_id AS toMemberId
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
          recipientId: row.recipientId, reductions: refundReductions };
      }
    }
    if (kind === "memberTransfer" && amountMinor !== null && row.fromMemberId && row.toMemberId) {
      return { ...order, kind, id, currency, amountMinor, fromMemberId: row.fromMemberId, toMemberId: row.toMemberId };
    }
    throw new Error(`Invalid stored financial event ${id}`);
  });
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
      && sameAllocations(saved.reductions, requested.reductions ?? []);
  }
  if (saved.kind === "memberTransfer" && requested.kind === "memberTransfer") {
    return saved.fromMemberId === requested.fromMemberId && saved.toMemberId === requested.toMemberId
      && saved.currency === requested.currency && saved.amountMinor === requested.amountMinor;
  }
  return false;
}

function sameExpense(original: FinanceExpense, input: FinanceExpense): boolean {
  return original.id === input.id
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
  };
}

function validateSplitSnapshot(expense: FinanceExpense) {
  if (!splitModes.includes(expense.splitMode)
    || !Number.isSafeInteger(expense.allocationVersion) || expense.allocationVersion < 1) {
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
    const { split, merchantPayment, splitMode, allocationVersion } = event.expense;
    const { currency, amountMinor } = split.total;
    await transaction.runAsync(`
      INSERT INTO expenses (id, activity_id, currency, amount_minor, split_mode, allocation_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `, id, activityId, currency, amountMinor, splitMode, allocationVersion);

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
        id, splitMode, allocationVersion, split: { total: { currency, amountMinor }, allocations },
        merchantPayment: { memberId: merchantPayment.memberId, currency, amountMinor: merchantPayment.amountMinor },
      },
    };
  }

  if (event.kind === "merchantRefund") {
    const { expenseId, recipientId, amountMinor, currency } = event;
    await transaction.runAsync(`
      INSERT INTO merchant_refunds (id, activity_id, expense_id, recipient_id, amount_minor) VALUES (?, ?, ?, ?, ?)
    `, id, activityId, expenseId, recipientId, amountMinor);
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
    return { ...order, kind: event.kind, id, expenseId, recipientId, amountMinor, currency, reductions };
  }

  const { fromMemberId, toMemberId, amountMinor, currency } = event;
  await transaction.runAsync(`
    INSERT INTO member_transfers (id, activity_id, from_member_id, to_member_id, amount_minor) VALUES (?, ?, ?, ?, ?)
  `, id, activityId, fromMemberId, toMemberId, amountMinor);
  return { ...order, kind: event.kind, id, fromMemberId, toMemberId, amountMinor, currency };
}

async function withStorage<T>(task: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await task();
  } catch {
    return failure("FINANCE_STORAGE_ERROR", "storage");
  }
}

async function recordInTransaction(
  transaction: SQLiteConnection, activityId: string, occurredAt: number, event: FinanceEvent, allowRetry = true,
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
  if (event.kind === "expense") {
    const invalid = validateSplitSnapshot(event.expense);
    if (invalid) return invalid;
  }

  const ordered = orderedTimeline(history, await readExpenseRevisions(transaction, activityId));
  const next = ordered.findIndex((entry) => entry.occurredAt > occurredAt);
  const index = next === -1 ? ordered.length : next;
  const timeline = [...ordered.slice(0, index), event, ...ordered.slice(index)];
  const balances = calculateBalances(activity.currency, activity.memberIds, [], timeline);
  if (!balances.ok) return balances;

  const saved = await insertEvent(transaction, activity, occurredAt, event);
  return { ok: true, value: saved };
}

/** Requires an existing write transaction. A caller-owned receipt handles retries. */
export async function insertNewExpenseInTransaction(
  transaction: SQLiteConnection, activityId: string, occurredAt: number, expense: FinanceExpense,
): Promise<Result<StoredExpense>> {
  const result = await recordInTransaction(transaction, activityId, occurredAt, { kind: "expense", expense }, false);
  if (!result.ok) return result;
  if (result.value.kind !== "expense") throw new Error("Expected a stored expense");
  return { ok: true, value: result.value };
}

export function createFinanceRepository(database: LocalDatabase) {
  function readLedger<T>(
    activityId: string,
    project: (activity: ActivityContext, events: StoredFinanceEvent[], revisions: StoredExpenseRevision[]) => Result<T>,
  ): Promise<Result<T>> {
    return withStorage(() => database.read(async (connection) => {
      const activity = await readActivity(connection, activityId);
      if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
      return project(activity, await readEvents(connection, activity), await readExpenseRevisions(connection, activityId));
    }));
  }

  function record(activityId: string, occurredAt: number, event: FinanceEvent): Promise<Result<StoredFinanceEvent>> {
    return withStorage(() => database.write((transaction) => recordInTransaction(transaction, activityId, occurredAt, event)));
  }

  function previewCorrection(
    activity: ActivityContext, events: StoredFinanceEvent[], revisions: StoredExpenseRevision[],
    expenseId: string, proposed: FinanceExpense,
  ): Result<FinanceCorrectionPreview> {
    if (activity.status === "completed") return failure("ACTIVITY_COMPLETED", "activityId");
    const original = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
    if (original?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
    const invalid = validateSplitSnapshot(proposed);
    if (invalid) return invalid;

    const latest = latestRevision(revisions, expenseId);
    const current = currentExpense(original, latest);
    const preview = previewExpenseCorrection({
      currency: activity.currency, memberIds: activity.memberIds, expenses: [],
      events: orderedTimeline(events, revisions), original: current.expense, proposed,
    });
    if (!preview.ok) return preview;
    return { ok: true, value: { ...preview.value, currentVersion: current.currentVersion } };
  }

  function commitExpenseCorrection(activityId: string, request: ExpenseCorrectionRequest): Promise<Result<StoredExpenseRevision>> {
    const { expenseId, revisionId, expectedVersion, occurredAt } = request;
    if (typeof revisionId !== "string" || revisionId.trim() === "") {
      return Promise.resolve(failure("INVALID_REVISION_ID", "revisionId"));
    }
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      return Promise.resolve(failure("INVALID_EVENT_TIME", "occurredAt"));
    }
    const proposed = copyExpense(request.proposed);
    const reviewedRefundIds = new Set(request.reviewedRefundIds);
    const refundReview = JSON.stringify([...reviewedRefundIds].sort());

    return withStorage(() => database.write(async (transaction) => {
      const existing = await transaction.getFirstAsync<{ activityId: string; refundReview: string }>(
        "SELECT activity_id AS activityId, reviewed_refund_ids AS refundReview FROM expense_revisions WHERE id = ?", revisionId,
      );
      if (revisionId === expenseId || (existing && existing.activityId !== activityId)) {
        return failure("REVISION_ID_CONFLICT", "revisionId");
      }
      const revisions = await readExpenseRevisions(transaction, activityId);
      if (existing) {
        const saved = revisions.find(({ id }) => id === revisionId);
        if (!saved || saved.expense.id !== expenseId || saved.version - 1 !== expectedVersion
          || saved.occurredAt !== occurredAt || existing.refundReview !== refundReview || !sameExpense(saved.expense, proposed)) {
          return failure("REVISION_ID_CONFLICT", "revisionId");
        }
        return { ok: true, value: saved };
      }

      const activity = await readActivity(transaction, activityId);
      if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
      const events = await readEvents(transaction, activity);
      const original = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
      if (!original) return failure("EXPENSE_NOT_FOUND", "expenseId");
      const latest = latestRevision(revisions, expenseId);
      const currentVersion = latest?.version ?? 1;
      if (currentVersion !== expectedVersion) return failure("EXPENSE_VERSION_CONFLICT", "expectedVersion");
      if (currentVersion === Number.MAX_SAFE_INTEGER) return failure("AMOUNT_OVERFLOW", "expectedVersion");

      // A correction is applied to the current ledger, after the facts reviewed in the preview.
      if (events.some((event) => event.occurredAt > occurredAt) || revisions.some((revision) => revision.occurredAt > occurredAt)) {
        return failure("REVISION_OUT_OF_ORDER", "occurredAt");
      }
      const preview = previewCorrection(activity, events, revisions, expenseId, proposed);
      if (!preview.ok) return preview;
      const { before, after, refunds } = preview.value.expense;
      if (refunds.length > 0 && !sameAllocations(before.split.allocations, after.split.allocations)
        && (reviewedRefundIds.size !== refunds.length || refunds.some(({ id }) => !reviewedRefundIds.has(id)))) {
        return failure("REFUND_REVIEW_REQUIRED", "reviewedRefundIds");
      }

      const saved = await insertExpenseRevision(transaction, activityId, activity.memberIds, {
        id: revisionId, version: currentVersion + 1, occurredAt, expense: proposed, refundReview,
      });
      return { ok: true, value: saved };
    }));
  }

  return {
    createExpense: (activityId: string, occurredAt: number, expense: FinanceExpense) => record(activityId, occurredAt, {
      kind: "expense", expense: copyExpense(expense),
    }),
    recordMerchantRefund: (activityId: string, occurredAt: number, refund: Omit<MerchantRefund, "kind">) =>
      record(activityId, occurredAt, {
        ...refund, kind: "merchantRefund", reductions: refund.reductions?.map((row) => ({ ...row })) ?? [],
      }),
    recordMemberTransfer: (activityId: string, occurredAt: number, transfer: Omit<MemberTransfer, "kind">) =>
      record(activityId, occurredAt, { ...transfer, kind: "memberTransfer" }),
    listExpenses: (activityId: string) => readLedger(activityId, (_activity, events, revisions) => {
      const latest = new Map(revisions.map((revision) => [revision.expense.id, revision]));
      const expenses = events.filter((event) => event.kind === "expense")
        .map((event) => currentExpense(event, latest.get(event.expense.id)));
      return { ok: true, value: expenses };
    }),
    getExpense: (activityId: string, expenseId: string) => readLedger<ExpenseDetail>(activityId, (_activity, events, revisions) => {
      const expense = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
      if (expense?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
      const refunds = events.filter((event): event is StoredFinanceEvent<MerchantRefund> =>
        event.kind === "merchantRefund" && event.expenseId === expenseId);
      const latest = latestRevision(revisions, expenseId);
      return { ok: true, value: { ...currentExpense(expense, latest), refunds } };
    }),
    previewExpenseCorrection: (activityId: string, expenseId: string, proposed: FinanceExpense) => {
      const candidate = copyExpense(proposed);
      return readLedger(activityId, (activity, events, revisions) => previewCorrection(activity, events, revisions, expenseId, candidate));
    },
    commitExpenseCorrection,
    listExpenseRevisions: (activityId: string, expenseId: string) => readLedger<readonly ExpenseVersion[]>(
      activityId, (_activity, events, revisions) => {
        const original = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
        if (original?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
        const baseline = { ...original, id: expenseId, version: 1 };
        return { ok: true, value: [baseline, ...revisions.filter((revision) => revision.expense.id === expenseId)] };
      },
    ),
    listEvents: (activityId: string) => readLedger(activityId, (_activity, events) => ({ ok: true, value: events })),
    getActivityLedger: (activityId: string) => readLedger<ActivityLedger>(activityId, (activity, events, revisions) => {
      const balances = calculateBalances(activity.currency, activity.memberIds, [], orderedTimeline(events, revisions));
      if (!balances.ok) return balances;
      const suggestions = suggestTransfers(balances.value);
      if (!suggestions.ok) return suggestions;
      return { ok: true, value: { events, revisions, balanceSnapshot: balances.value, suggestions: suggestions.value } };
    }),
  };
}
