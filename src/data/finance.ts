import {
  calculateBalances, type ActivityEventBalances, type Expense, type MemberTransfer, type MerchantRefund,
} from "../domain/balance.ts";
import type { Currency } from "../domain/money.ts";
import { failure, type Result } from "../domain/result.ts";
import { suggestTransfers, type TransferSuggestion } from "../domain/settlement.ts";
import type { Allocation } from "../domain/split.ts";
import type { ActivityStatus } from "./activities.ts";
import type { LocalDatabase, SQLiteConnection, SQLiteReader } from "./database.ts";

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

export type ExpenseDetail = StoredFinanceEvent<ExpenseEvent> & {
  readonly refunds: readonly StoredFinanceEvent<MerchantRefund>[];
};

export type ActivityLedger = {
  readonly events: readonly StoredFinanceEvent[];
  readonly balanceSnapshot: ActivityEventBalances;
  readonly suggestions: readonly TransferSuggestion[];
};

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
    JOIN expense_allocations AS a ON a.expense_id = r.expense_id AND a.member_id = r.member_id
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
    const original = saved.expense;
    const input = requested.expense;
    return original.splitMode === input.splitMode && original.allocationVersion === input.allocationVersion
      && original.split.total.currency === input.split.total.currency
      && original.split.total.amountMinor === input.split.total.amountMinor
      && original.merchantPayment.memberId === input.merchantPayment?.memberId
      && original.merchantPayment.currency === input.merchantPayment.currency
      && original.merchantPayment.amountMinor === input.merchantPayment.amountMinor
      && sameAllocations(original.split.allocations, input.split.allocations);
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

async function insertEvent(
  transaction: SQLiteConnection, activity: ActivityContext, occurredAt: number, event: FinanceEvent,
  history: readonly StoredFinanceEvent[],
): Promise<StoredFinanceEvent> {
  const id = eventId(event);
  const { id: activityId } = activity;
  const inserted = await transaction.getFirstAsync<{ sequence: number }>(`
    INSERT INTO financial_events (id, activity_id, kind, occurred_at) VALUES (?, ?, ?, ?)
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
    const expense = history.find((entry) => entry.kind === "expense" && entry.expense.id === expenseId);
    if (expense?.kind !== "expense") throw new Error("Refund expense snapshot was not found");
    const amounts = new Map(event.reductions.map((reduction) => [reduction.memberId, reduction.amountMinor]));
    const reductions: Allocation[] = [];
    for (const { memberId } of expense.expense.split.allocations) {
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

export function createFinanceRepository(database: LocalDatabase) {
  function readLedger<T>(
    activityId: string, project: (activity: ActivityContext, events: StoredFinanceEvent[]) => Result<T>,
  ): Promise<Result<T>> {
    return withStorage(() => database.read(async (connection) => {
      const activity = await readActivity(connection, activityId);
      if (!activity) return failure("ACTIVITY_NOT_FOUND", "activityId");
      return project(activity, await readEvents(connection, activity));
    }));
  }

  function record(activityId: string, occurredAt: number, event: FinanceEvent): Promise<Result<StoredFinanceEvent>> {
    const id = eventId(event);
    if (typeof id !== "string" || id.trim() === "") {
      return Promise.resolve(event.kind === "expense"
        ? failure("INVALID_EXPENSE_ID", "expenseId") : failure("INVALID_EVENT_ID", "eventId"));
    }
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      return Promise.resolve(failure("INVALID_EVENT_TIME", "occurredAt"));
    }

    return withStorage(() => database.write(async (transaction) => {
      const existing = await transaction.getFirstAsync<{ activityId: string }>(
        "SELECT activity_id AS activityId FROM financial_events WHERE id = ?", id,
      );
      if (existing && existing.activityId !== activityId) return failure("EVENT_ID_CONFLICT", "eventId");

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
      if (event.kind === "expense" && (!splitModes.includes(event.expense.splitMode)
        || !Number.isSafeInteger(event.expense.allocationVersion) || event.expense.allocationVersion < 1)) {
        return failure("INVALID_SPLIT_SNAPSHOT", "allocations");
      }

      const next = history.findIndex((entry) => entry.occurredAt > occurredAt);
      const index = next === -1 ? history.length : next;
      const timeline = [...history.slice(0, index), event, ...history.slice(index)];
      const balances = calculateBalances(activity.currency, activity.memberIds, [], timeline);
      if (!balances.ok) return balances;

      const saved = await insertEvent(transaction, activity, occurredAt, event, history);
      return { ok: true, value: saved };
    }));
  }

  return {
    createExpense: (activityId: string, occurredAt: number, expense: FinanceExpense) => record(activityId, occurredAt, {
      kind: "expense",
      expense: {
        ...expense,
        split: { total: { ...expense.split.total }, allocations: expense.split.allocations.map((row) => ({ ...row })) },
        merchantPayment: expense.merchantPayment && { ...expense.merchantPayment },
      },
    }),
    recordMerchantRefund: (activityId: string, occurredAt: number, refund: Omit<MerchantRefund, "kind">) =>
      record(activityId, occurredAt, {
        ...refund, kind: "merchantRefund", reductions: refund.reductions?.map((row) => ({ ...row })) ?? [],
      }),
    recordMemberTransfer: (activityId: string, occurredAt: number, transfer: Omit<MemberTransfer, "kind">) =>
      record(activityId, occurredAt, { ...transfer, kind: "memberTransfer" }),
    listExpenses: (activityId: string) => readLedger(activityId, (_activity, events) => ({
      ok: true, value: events.filter((event) => event.kind === "expense"),
    })),
    getExpense: (activityId: string, expenseId: string) => readLedger<ExpenseDetail>(activityId, (_activity, events) => {
      const expense = events.find((event) => event.kind === "expense" && event.expense.id === expenseId);
      if (expense?.kind !== "expense") return failure("EXPENSE_NOT_FOUND", "expenseId");
      const refunds = events.filter((event): event is StoredFinanceEvent<MerchantRefund> =>
        event.kind === "merchantRefund" && event.expenseId === expenseId);
      return { ok: true, value: { ...expense, refunds } };
    }),
    listEvents: (activityId: string) => readLedger(activityId, (_activity, events) => ({ ok: true, value: events })),
    getActivityLedger: (activityId: string) => readLedger<ActivityLedger>(activityId, (activity, events) => {
      const balances = calculateBalances(activity.currency, activity.memberIds, [], events);
      if (!balances.ok) return balances;
      const suggestions = suggestTransfers(balances.value);
      if (!suggestions.ok) return suggestions;
      return { ok: true, value: { events, balanceSnapshot: balances.value, suggestions: suggestions.value } };
    }),
  };
}
