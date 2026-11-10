import type { Currency } from "../domain/money.ts";
import { calculateQuickSplit, usesAdvancedSplit, type QuickSplitInput, type QuickSplitSnapshot } from "../domain/quickSplit.ts";
import { failure, type Result } from "../domain/result.ts";
import type { LocalDatabase, SQLiteReader } from "./database.ts";
import { freeAccess, type ProAccess } from "../services/proEntitlement.ts";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type QuickDraftInput = {
  readonly currency?: Currency;
  readonly mode?: QuickSplitInput["method"]["kind"];
  readonly members?: readonly { readonly id: string; readonly displayName?: string }[];
  /** Editor values may be incomplete strings or omitted fields. */
  readonly parameters?: { readonly [key: string]: JsonValue };
  readonly merchantPayerId?: string;
};

type QuickRecord<T> = {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly schemaVersion: number;
  readonly input: T;
};

export type QuickDraft = QuickRecord<QuickDraftInput>;
/** The stable id is the source key for a future conversion to a formal expense. */
export type QuickHistoryRecord = QuickRecord<QuickSplitInput> & { readonly snapshot: QuickSplitSnapshot };

type QuickRow = Omit<QuickRecord<never>, "input"> & { inputJson: string };
type HistoryRow = QuickRow & { resultJson: string };

const schemaVersion = 1;
const columns = "id, created_at AS createdAt, updated_at AS updatedAt, schema_version AS schemaVersion, input_json AS inputJson";
const historyColumns = `${columns}, result_json AS resultJson`;

function validId(id: string): boolean {
  return typeof id === "string" && id.trim() !== "";
}

function encodeInput<T extends object>(input: T): Result<{ json: string; input: T }> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return failure("INVALID_QUICK_INPUT", "quickInput");
    }
    const json = JSON.stringify(input, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite JSON value");
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const object = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
      }
      return value;
    });
    // Capture the same input that will be persisted, before waiting on the database queue.
    return { ok: true, value: { json, input: JSON.parse(json) as T } };
  } catch {
    return failure("INVALID_QUICK_INPUT", "quickInput");
  }
}

function decodeRecord<T>({ id, createdAt, updatedAt, schemaVersion: version, inputJson }: QuickRow): QuickRecord<T> {
  if (version !== schemaVersion) throw new Error(`Unsupported quick split schema ${version}`);
  return { id, createdAt, updatedAt, schemaVersion: version, input: JSON.parse(inputJson) as T };
}

function decodeHistory(row: HistoryRow): QuickHistoryRecord {
  return { ...decodeRecord<QuickSplitInput>(row), snapshot: JSON.parse(row.resultJson) as QuickSplitSnapshot };
}

export async function readQuickHistory(connection: SQLiteReader, id: string): Promise<QuickHistoryRecord | null> {
  const row = await connection.getFirstAsync<HistoryRow>(`SELECT ${historyColumns} FROM quick_history WHERE id = ?`, id);
  return row ? decodeHistory(row) : null;
}

async function withStorage<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await operation();
  } catch {
    return failure("QUICK_STORAGE_ERROR", "storage");
  }
}

export function createQuickSplitRepository(database: LocalDatabase, hasProAccess: ProAccess = freeAccess) {
  return {
    /** Each new editor snapshot uses a new id and a strictly later capture time. */
    async saveQuickDraft(id: string, input: QuickDraftInput, capturedAt: number): Promise<Result<QuickDraft>> {
      if (!validId(id)) return failure("INVALID_QUICK_RECORD_ID", "quickRecordId");
      if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) return failure("INVALID_EVENT_TIME", "occurredAt");
      const encoded = encodeInput(input);
      if (!encoded.ok) return encoded;

      return withStorage(() => database.write(async (transaction) => {
        const existing = await transaction.getFirstAsync<QuickRow>(`SELECT ${columns} FROM quick_draft WHERE slot = 1`);
        if (existing) {
          const draft = decodeRecord<QuickDraftInput>(existing);
          if (draft.id === id) {
            return existing.inputJson === encoded.value.json && draft.updatedAt === capturedAt
              ? { ok: true, value: draft } : failure("QUICK_RECORD_ID_CONFLICT", "quickRecordId");
          }
          if (capturedAt <= draft.updatedAt) return failure("STALE_QUICK_DRAFT", "occurredAt");
        }

        const createdAt = existing?.createdAt ?? capturedAt;
        await transaction.runAsync(`
          INSERT INTO quick_draft (slot, id, created_at, updated_at, schema_version, input_json)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(slot) DO UPDATE SET id = excluded.id, updated_at = excluded.updated_at,
            schema_version = excluded.schema_version, input_json = excluded.input_json
        `, id, createdAt, capturedAt, schemaVersion, encoded.value.json);
        return { ok: true, value: { id, createdAt, updatedAt: capturedAt, schemaVersion, input: encoded.value.input } };
      }));
    },

    getQuickDraft(): Promise<Result<QuickDraft | null>> {
      return withStorage(() => database.read(async (connection) => {
        const row = await connection.getFirstAsync<QuickRow>(`SELECT ${columns} FROM quick_draft WHERE slot = 1`);
        return { ok: true, value: row ? decodeRecord<QuickDraftInput>(row) : null };
      }));
    },

    clearQuickDraft(): Promise<Result<boolean>> {
      return withStorage(() => database.write(async (transaction) => {
        const result = await transaction.runAsync("DELETE FROM quick_draft WHERE slot = 1");
        return { ok: true, value: result.changes > 0 };
      }));
    },

    async saveQuickHistory(id: string, input: QuickSplitInput): Promise<Result<QuickHistoryRecord>> {
      if (!validId(id)) return failure("INVALID_QUICK_RECORD_ID", "quickRecordId");
      const encoded = encodeInput(input);
      if (!encoded.ok) return encoded;

      return withStorage(() => database.write(async (transaction) => {
        const existing = await transaction.getFirstAsync<HistoryRow>(
          `SELECT ${historyColumns} FROM quick_history WHERE id = ?`, id,
        );
        if (existing) {
          return existing.inputJson === encoded.value.json
            ? { ok: true, value: decodeHistory(existing) } : failure("QUICK_RECORD_ID_CONFLICT", "quickRecordId");
        }

        let calculated: Result<QuickSplitSnapshot>;
        try {
          calculated = calculateQuickSplit(encoded.value.input);
        } catch {
          return failure("INVALID_QUICK_INPUT", "quickInput");
        }
        if (!calculated.ok) return calculated;
        if (!hasProAccess() && usesAdvancedSplit(encoded.value.input)) return failure("PRO_REQUIRED", "quickInput");
        const now = Date.now();
        await transaction.runAsync(`
          INSERT INTO quick_history (id, created_at, updated_at, schema_version, input_json, result_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `, id, now, now, schemaVersion, encoded.value.json, JSON.stringify(calculated.value));
        return { ok: true, value: {
          id, createdAt: now, updatedAt: now, schemaVersion, input: encoded.value.input, snapshot: calculated.value,
        } };
      }));
    },

    listQuickHistory(): Promise<Result<readonly QuickHistoryRecord[]>> {
      return withStorage(() => database.read(async (connection) => {
        const rows = await connection.getAllAsync<HistoryRow>(`
          SELECT ${historyColumns} FROM quick_history ORDER BY created_at DESC, id
        `);
        return { ok: true, value: rows.map(decodeHistory) };
      }));
    },

    async getQuickHistory(id: string): Promise<Result<QuickHistoryRecord | null>> {
      if (!validId(id)) return failure("INVALID_QUICK_RECORD_ID", "quickRecordId");
      return withStorage(() => database.read(async (connection) => ({
        ok: true, value: await readQuickHistory(connection, id),
      })));
    },

    async deleteQuickHistory(id: string): Promise<Result<boolean>> {
      if (!validId(id)) return failure("INVALID_QUICK_RECORD_ID", "quickRecordId");
      return withStorage(() => database.write(async (transaction) => {
        const result = await transaction.runAsync("DELETE FROM quick_history WHERE id = ?", id);
        return { ok: true, value: result.changes > 0 };
      }));
    },
  };
}
