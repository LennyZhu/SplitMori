import type { SQLiteDatabase } from "expo-sqlite";
import { migrations } from "./migrations.ts";

type SQLiteReader = Pick<SQLiteDatabase, "getFirstAsync" | "getAllAsync">;
export type SQLiteConnection = SQLiteReader & Pick<SQLiteDatabase, "execAsync" | "runAsync">;

export type LocalDatabase = {
  read<T>(task: (connection: SQLiteReader) => Promise<T>): Promise<T>;
  /** Use the supplied transaction for all queries inside the task. */
  write<T>(task: (transaction: SQLiteConnection) => Promise<T>): Promise<T>;
};

type InitializationStage = "open" | "configure" | "migration";

export class DatabaseInitializationError extends Error {
  readonly stage: InitializationStage;

  constructor(stage: InitializationStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Local database ${stage} failed: ${detail}`, { cause });
    this.name = "DatabaseInitializationError";
    this.stage = stage;
  }
}

function createDatabase(connection: SQLiteConnection): LocalDatabase {
  let pending = Promise.resolve();
  let unusable: Error | undefined;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(() => {
      if (unusable) throw unusable;
      return task();
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    read: (task) => enqueue(() => task(connection)),
    // All callers use this queue so unrelated reads or writes cannot join an open transaction.
    write: (task) => enqueue(async () => {
      await connection.execAsync("BEGIN IMMEDIATE");
      try {
        const value = await task(connection);
        await connection.execAsync("COMMIT");
        return value;
      } catch (error) {
        try {
          await connection.execAsync("ROLLBACK");
        } catch (rollbackError) {
          unusable = new AggregateError([error, rollbackError], "Local database transaction rollback failed");
          throw unusable;
        }
        throw error;
      }
    }),
  };
}

/** Initialize a dedicated file connection before exposing it to readers and writers. */
export async function initializeDatabase(connection: SQLiteConnection): Promise<LocalDatabase> {
  try {
    await connection.execAsync("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const journal = await connection.getFirstAsync<{ journal_mode: string }>("PRAGMA journal_mode = WAL");
    const foreignKeys = await connection.getFirstAsync<{ foreign_keys: number }>("PRAGMA foreign_keys");
    if (journal?.journal_mode !== "wal" || foreignKeys?.foreign_keys !== 1) {
      throw new Error("WAL and foreign key enforcement are required");
    }
  } catch (error) {
    throw new DatabaseInitializationError("configure", error);
  }

  const database = createDatabase(connection);
  try {
    await database.write(async (transaction) => {
      const metadata = await transaction.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
      const version = metadata?.user_version;
      if (version === undefined || !Number.isInteger(version) || version < 0 || version > migrations.length) {
        throw new Error(`Unsupported schema version ${String(version)} (latest ${migrations.length})`);
      }
      for (let next = version; next < migrations.length; next += 1) {
        await transaction.execAsync(migrations[next]);
        await transaction.execAsync(`PRAGMA user_version = ${next + 1}`);
      }
    });
  } catch (error) {
    throw new DatabaseInitializationError("migration", error);
  }
  return database;
}

async function openLocalDatabase(): Promise<LocalDatabase> {
  let connection: SQLiteDatabase;
  try {
    const { openDatabaseAsync } = await import("expo-sqlite");
    connection = await openDatabaseAsync("splitmori.db", { useNewConnection: true });
  } catch (error) {
    throw new DatabaseInitializationError("open", error);
  }

  try {
    return await initializeDatabase(connection);
  } catch (error) {
    // Retain the initialization error if the failing connection also cannot close.
    await connection.closeAsync().catch(() => undefined);
    throw error;
  }
}

let openingDatabase: Promise<LocalDatabase> | undefined;

export function getLocalDatabase(): Promise<LocalDatabase> {
  openingDatabase ??= openLocalDatabase().catch((error: unknown) => {
    openingDatabase = undefined;
    throw error;
  });
  return openingDatabase;
}
