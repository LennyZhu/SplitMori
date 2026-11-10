import type { Currency } from "../domain/money.ts";
import { merchantPaymentsOf, paymentFields } from "../domain/balance.ts";
import type { QuickSplitInput } from "../domain/quickSplit.ts";
import type { Allocation } from "../domain/split.ts";
import type { SQLiteConnection, SQLiteReader } from "./database.ts";
import type { FinanceExpense } from "./finance.ts";
import { migrations, multiPayerSchemaVersion } from "./migrations.ts";

export type ExpenseVersion = {
  readonly kind: "expense" | "expenseRevision";
  readonly id: string;
  readonly version: number;
  readonly occurredAt: number;
  readonly sequence: number;
  readonly expense: FinanceExpense;
};

export type StoredExpenseRevision = ExpenseVersion & { readonly kind: "expenseRevision" };

// Ledger entries share one insertion order. BEGIN IMMEDIATE serializes allocation of the next number.
export const nextFinanceSequence = `(
  SELECT MAX(COALESCE((SELECT MAX(sequence) FROM financial_events), 0),
             COALESCE((SELECT MAX(sequence) FROM expense_revisions), 0),
             COALESCE((SELECT MAX(sequence) FROM financial_voids), 0)) + 1
)`;

type RevisionRow = {
  id: string;
  version: number;
  occurredAt: number;
  sequence: number;
  expenseId: string;
  expenseName: string | null;
  expenseDate: number | null;
  splitInput: string | null;
  currency: Currency;
  amountMinor: number;
  splitMode: FinanceExpense["splitMode"];
  allocationVersion: number;
  payerId: string | null;
  paidMinor: number | null;
  memberId: string | null;
  shareMinor: number | null;
};

export async function readExpenseRevisions(
  connection: SQLiteReader, activityId: string, schemaVersion: number = migrations.length,
): Promise<StoredExpenseRevision[]> {
  const multiPayer = schemaVersion >= multiPayerSchemaVersion;
  const payments = new Map<string, Allocation[]>();
  if (multiPayer) {
    for (const { revisionId, memberId, amountMinor } of await connection.getAllAsync<Allocation & { revisionId: string }>(`
      SELECT p.revision_id AS revisionId, p.member_id AS memberId, p.amount_minor AS amountMinor
      FROM expense_revision_payments AS p
      JOIN activity_members AS a ON a.activity_id = p.activity_id AND a.member_id = p.member_id
      WHERE p.activity_id = ? ORDER BY p.revision_id, a.position
    `, activityId)) {
      const group = payments.get(revisionId) ?? [];
      group.push({ memberId, amountMinor });
      payments.set(revisionId, group);
    }
  }
  const rows = await connection.getAllAsync<RevisionRow>(`
    SELECT r.id, r.version, r.occurred_at AS occurredAt, r.sequence, r.expense_id AS expenseId,
           ${schemaVersion >= 9 ? "COALESCE(r.name, e.name)" : schemaVersion >= 7 ? "e.name" : "NULL"} AS expenseName,
           ${schemaVersion >= 9 ? "r.expense_date" : "NULL"} AS expenseDate,
           ${schemaVersion >= 9 ? "r.split_input" : "NULL"} AS splitInput,
           r.currency, r.amount_minor AS amountMinor, r.split_mode AS splitMode,
           r.allocation_version AS allocationVersion, ${multiPayer ? "NULL" : "r.payer_id"} AS payerId,
           ${multiPayer ? "NULL" : "r.paid_minor"} AS paidMinor,
           a.member_id AS memberId, a.amount_minor AS shareMinor
    FROM expense_revisions AS r
    LEFT JOIN expenses AS e ON e.id = r.expense_id AND e.activity_id = r.activity_id
    LEFT JOIN expense_revision_allocations AS a ON a.revision_id = r.id AND a.activity_id = r.activity_id
    WHERE r.activity_id = ? ORDER BY r.sequence, a.position
  `, activityId);
  const revisions: StoredExpenseRevision[] = [];
  let previousId: string | undefined;
  let allocations: Allocation[] = [];
  for (const row of rows) {
    const { id, version, occurredAt, sequence, expenseId, expenseName, expenseDate, splitInput, currency, amountMinor, splitMode, allocationVersion,
      payerId, paidMinor, memberId, shareMinor } = row;
    if (memberId === null || shareMinor === null) throw new Error(`Missing allocations for expense revision ${id}`);
    if (id !== previousId) {
      const recordedPayments = multiPayer ? payments.get(id)
        : payerId === null || paidMinor === null ? undefined : [{ memberId: payerId, amountMinor: paidMinor }];
      if (!recordedPayments?.length) throw new Error(`Missing payments for expense revision ${id}`);
      allocations = [];
      revisions.push({ kind: "expenseRevision", id, version, occurredAt, sequence, expense: {
        id: expenseId, splitMode, allocationVersion, ...(expenseName === null ? {} : { name: expenseName }),
        ...(expenseDate === null ? {} : { expenseDate }),
        ...(splitInput === null ? {} : { splitInput: JSON.parse(splitInput) as QuickSplitInput }),
        split: { total: { currency, amountMinor }, allocations },
        ...paymentFields(recordedPayments.map((payment) => ({ ...payment, currency }))),
      } });
      previousId = id;
    }
    allocations.push({ memberId, amountMinor: shareMinor });
  }
  return revisions;
}

export async function insertExpenseRevision(
  transaction: SQLiteConnection, activityId: string, memberIds: readonly string[],
  { id, version, occurredAt, expense, refundReview }: Omit<StoredExpenseRevision, "kind" | "sequence"> & {
    readonly refundReview: string;
  },
): Promise<StoredExpenseRevision> {
  const { split, splitMode, allocationVersion, name, expenseDate, splitInput } = expense;
  const { currency, amountMinor } = split.total;
  const row = await transaction.getFirstAsync<{ sequence: number }>(`
    INSERT INTO expense_revisions (sequence, id, activity_id, expense_id, version, occurred_at,
      currency, amount_minor, split_mode, allocation_version, reviewed_refund_ids, name, expense_date, split_input)
    VALUES (${nextFinanceSequence}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING sequence
  `, id, activityId, expense.id, version, occurredAt, currency, amountMinor, splitMode,
  allocationVersion, refundReview, name ?? null, expenseDate ?? null,
  splitInput === undefined ? null : JSON.stringify(splitInput));
  if (!row) throw new Error("Expense revision was not inserted");

  const shares = new Map(split.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  const allocations: Allocation[] = [];
  for (const [position, memberId] of memberIds.entries()) {
    const share = shares.get(memberId);
    if (share === undefined) continue;
    await transaction.runAsync(`
      INSERT INTO expense_revision_allocations (activity_id, revision_id, member_id, amount_minor, position)
      VALUES (?, ?, ?, ?, ?)
    `, activityId, id, memberId, share, position);
    allocations.push({ memberId, amountMinor: share });
  }
  const paymentsByMember = new Map(merchantPaymentsOf(expense).map((payment) => [payment.memberId, payment]));
  const payments = memberIds.flatMap((memberId) => paymentsByMember.get(memberId) ?? []);
  for (const { memberId, amountMinor } of payments) {
    await transaction.runAsync(`
      INSERT INTO expense_revision_payments (activity_id, revision_id, member_id, amount_minor) VALUES (?, ?, ?, ?)
    `, activityId, id, memberId, amountMinor);
  }
  const { merchantPayment: _single, merchantPayments: _multiple, ...details } = expense;
  return {
    kind: "expenseRevision", id, version, occurredAt, sequence: row.sequence,
    expense: { ...details, split: { total: { currency, amountMinor }, allocations }, ...paymentFields(payments) },
  };
}
