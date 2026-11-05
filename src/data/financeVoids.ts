import type { FinancialVoid } from "../domain/balance.ts";
import type { SQLiteConnection, SQLiteReader } from "./database.ts";
import { nextFinanceSequence } from "./financeRevisions.ts";

export type FinancialVoidRequest = {
  readonly id: string;
  readonly targetEventId: string;
  readonly occurredAt: number;
  readonly reason?: string;
};

export type StoredFinancialVoid = FinancialVoid & {
  readonly activityId: string;
  readonly occurredAt: number;
  readonly sequence: number;
  readonly reason: string | null;
};

const columns = `'financialVoid' AS kind, id, activity_id AS activityId, target_event_id AS targetEventId,
  target_kind AS targetKind, occurred_at AS occurredAt, sequence, reason`;

export function readFinancialVoids(connection: SQLiteReader, activityId: string): Promise<StoredFinancialVoid[]> {
  return connection.getAllAsync<StoredFinancialVoid>(`
    SELECT ${columns} FROM financial_voids WHERE activity_id = ? ORDER BY occurred_at, sequence
  `, activityId);
}

export function findFinancialVoid(connection: SQLiteReader, id: string): Promise<StoredFinancialVoid | null> {
  return connection.getFirstAsync<StoredFinancialVoid>(`SELECT ${columns} FROM financial_voids WHERE id = ?`, id);
}

export async function insertFinancialVoid(
  transaction: SQLiteConnection, event: Omit<StoredFinancialVoid, "sequence">,
): Promise<StoredFinancialVoid> {
  const { id, activityId, targetEventId, targetKind, occurredAt, reason } = event;
  const saved = await transaction.getFirstAsync<{ sequence: number }>(`
    INSERT INTO financial_voids (sequence, id, activity_id, target_event_id, target_kind, occurred_at, reason)
    VALUES (${nextFinanceSequence}, ?, ?, ?, ?, ?, ?) RETURNING sequence
  `, id, activityId, targetEventId, targetKind, occurredAt, reason);
  if (!saved) throw new Error("Financial void was not inserted");
  return { ...event, sequence: saved.sequence };
}
