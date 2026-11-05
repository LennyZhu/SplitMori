import type { Currency } from "../domain/money.ts";
import type { Allocation } from "../domain/split.ts";
import type { SQLiteConnection, SQLiteReader } from "./database.ts";
import type { FinanceExpense } from "./finance.ts";

export type ExpenseVersion = {
  readonly kind: "expense" | "expenseRevision";
  readonly id: string;
  readonly version: number;
  readonly occurredAt: number;
  readonly sequence: number;
  readonly expense: FinanceExpense;
};

export type StoredExpenseRevision = ExpenseVersion & { readonly kind: "expenseRevision" };

// Both tables share one insertion order. BEGIN IMMEDIATE serializes allocation of the next number.
export const nextFinanceSequence = `(
  SELECT MAX(COALESCE((SELECT MAX(sequence) FROM financial_events), 0),
             COALESCE((SELECT MAX(sequence) FROM expense_revisions), 0)) + 1
)`;

type RevisionRow = {
  id: string;
  version: number;
  occurredAt: number;
  sequence: number;
  expenseId: string;
  currency: Currency;
  amountMinor: number;
  splitMode: FinanceExpense["splitMode"];
  allocationVersion: number;
  payerId: string;
  paidMinor: number;
  memberId: string | null;
  shareMinor: number | null;
};

export async function readExpenseRevisions(connection: SQLiteReader, activityId: string): Promise<StoredExpenseRevision[]> {
  const rows = await connection.getAllAsync<RevisionRow>(`
    SELECT r.id, r.version, r.occurred_at AS occurredAt, r.sequence, r.expense_id AS expenseId,
           r.currency, r.amount_minor AS amountMinor, r.split_mode AS splitMode,
           r.allocation_version AS allocationVersion, r.payer_id AS payerId, r.paid_minor AS paidMinor,
           a.member_id AS memberId, a.amount_minor AS shareMinor
    FROM expense_revisions AS r
    LEFT JOIN expense_revision_allocations AS a ON a.revision_id = r.id AND a.activity_id = r.activity_id
    WHERE r.activity_id = ? ORDER BY r.sequence, a.position
  `, activityId);
  const revisions: StoredExpenseRevision[] = [];
  let previousId: string | undefined;
  let allocations: Allocation[] = [];
  for (const row of rows) {
    const { id, version, occurredAt, sequence, expenseId, currency, amountMinor, splitMode, allocationVersion,
      payerId, paidMinor, memberId, shareMinor } = row;
    if (memberId === null || shareMinor === null) throw new Error(`Missing allocations for expense revision ${id}`);
    if (id !== previousId) {
      allocations = [];
      revisions.push({ kind: "expenseRevision", id, version, occurredAt, sequence, expense: {
        id: expenseId, splitMode, allocationVersion, split: { total: { currency, amountMinor }, allocations },
        merchantPayment: { memberId: payerId, currency, amountMinor: paidMinor },
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
  const { split, merchantPayment, splitMode, allocationVersion } = expense;
  const { currency, amountMinor } = split.total;
  const row = await transaction.getFirstAsync<{ sequence: number }>(`
    INSERT INTO expense_revisions (sequence, id, activity_id, expense_id, version, occurred_at,
      currency, amount_minor, split_mode, allocation_version, payer_id, paid_minor, reviewed_refund_ids)
    VALUES (${nextFinanceSequence}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING sequence
  `, id, activityId, expense.id, version, occurredAt, currency, amountMinor, splitMode,
  allocationVersion, merchantPayment.memberId, merchantPayment.amountMinor, refundReview);
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
  return {
    kind: "expenseRevision", id, version, occurredAt, sequence: row.sequence,
    expense: { id: expense.id, splitMode, allocationVersion, split: { total: { currency, amountMinor }, allocations },
      merchantPayment: { memberId: merchantPayment.memberId, currency, amountMinor: merchantPayment.amountMinor } },
  };
}
