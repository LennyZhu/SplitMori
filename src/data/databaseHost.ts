import {
  backupSnapshotName, DatabaseInitializationError, initializeDatabase,
  type LocalDatabase, type SQLiteConnection, type SQLiteReader,
} from "./database.ts";
import { migrations } from "./migrations.ts";

export const databaseName = "splitmori.db";

export const restoreFiles = {
  stage: "splitmori.restore-stage.sqlite",
  pending: "splitmori.restore-pending.sqlite",
  // This verified, standalone database also serves as the durable rollback marker.
  safety: "splitmori.restore-original.sqlite",
  displaced: "splitmori.restore-displaced.sqlite",
} as const;

type ManagedConnection = SQLiteConnection & { closeAsync(): Promise<void> };
type Snapshot = { readonly uri: string; readonly sha256: string; readonly schemaVersion: number };
type DatabaseFile = {
  readonly uri: string;
  readonly exists: boolean;
  sha256(): Promise<string>;
  remove(): void;
  rename(name: string): void;
};
type DatabaseHostPlatform<Connection extends ManagedConnection> = {
  readonly directoryUri: string;
  file(name: string, directoryUri?: string): DatabaseFile;
  copy(sourceUri: string, destinationName: string): Promise<void>;
  open(name: string): Promise<Connection>;
  backup(connection: Connection, directoryUri: string): Promise<void>;
  createWorkspace(): { directoryUri: string; remove(): void };
  checkStandalone(name: string, directoryUri: string): Promise<void>;
  checkInitialized(connection: ManagedConnection): Promise<void>;
};

type ReplacementStatus = "restored" | "stale" | "busy" | "failed" | "recovery-required";

async function checkpoint(connection: ManagedConnection) {
  const result = await connection.getFirstAsync<{ busy: number; log: number; checkpointed: number }>(
    "PRAGMA wal_checkpoint(TRUNCATE)",
  );
  if (!result || result.busy !== 0 || result.log !== result.checkpointed) throw new Error("SQLite checkpoint did not finish");
}

export function createDatabaseHost<Connection extends ManagedConnection>(platform: DatabaseHostPlatform<Connection>) {
  const file = (name: string) => platform.file(name);
  const marker = () => file(restoreFiles.safety);
  let connection: Connection | undefined;
  let database: LocalDatabase | undefined;
  let pending = Promise.resolve();
  let revision = 0;
  let restoring = false;
  let blocked: DatabaseInitializationError | undefined;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(task);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  function remove(name: string) {
    const target = file(name);
    if (target.exists) target.remove();
  }

  function removeSidecars(name: string) {
    for (const suffix of ["-wal", "-shm", "-journal"]) remove(name + suffix);
  }

  function cleanArtifacts() {
    // Once the marker is cleared these files are disposable, even if cleanup is interrupted.
    for (const name of [restoreFiles.stage, restoreFiles.pending, restoreFiles.displaced]) {
      try {
        remove(name);
        removeSidecars(name);
      } catch {
        // Leave remaining artifacts for the next startup or restore attempt.
      }
    }
  }

  async function closeLive() {
    database = undefined;
    if (!connection) return;
    try {
      await connection.closeAsync();
      connection = undefined;
    } catch (cause) {
      // The connection may still be open. Fail closed until a process restart.
      blocked = new DatabaseInitializationError("recovery", cause);
      throw blocked;
    }
  }

  async function openLive(allowCreate: boolean, verify: boolean) {
    if (!allowCreate && !file(databaseName).exists) throw new Error("Expected database file is missing");
    try {
      connection = await platform.open(databaseName);
      const live = connection;
      const initialized = await initializeDatabase(live, (directoryUri) => platform.backup(live, directoryUri));
      if (verify) await platform.checkInitialized(live);
      database = initialized;
      return initialized;
    } catch (cause) {
      await closeLive();
      if (cause instanceof DatabaseInitializationError) throw cause;
      throw new DatabaseInitializationError("open", cause);
    }
  }

  async function verifiedCopy(uri: string, digest: string, target: string) {
    remove(target);
    removeSidecars(target);
    await platform.copy(uri, target);
    if (await file(target).sha256() !== digest) throw new Error("Restoration copy differs from the validated SQLite snapshot");
  }

  function switchToStaged() {
    if (connection || !marker().exists || !file(restoreFiles.stage).exists) throw new Error("Unsafe SQLite switch");
    removeSidecars(databaseName);
    remove(restoreFiles.displaced);
    const current = file(databaseName);
    if (current.exists) current.rename(restoreFiles.displaced);
    file(restoreFiles.stage).rename(databaseName);
  }

  async function recoverMarked() {
    await platform.checkStandalone(restoreFiles.safety, platform.directoryUri);
    const safety = marker();
    await verifiedCopy(safety.uri, await safety.sha256(), restoreFiles.stage);
    switchToStaged();
    const restored = await openLive(false, true);
    safety.remove();
    cleanArtifacts();
    return restored;
  }

  async function ensureOpen() {
    if (blocked) throw blocked;
    if (database) return database;
    if (marker().exists) {
      try {
        return await recoverMarked();
      } catch (cause) {
        await closeLive();
        throw new DatabaseInitializationError("recovery", cause);
      }
    }
    if (!file(databaseName).exists
      && [restoreFiles.stage, restoreFiles.pending, restoreFiles.displaced, databaseName + "-wal",
        databaseName + "-shm", databaseName + "-journal"].some((name) => file(name).exists)) {
      throw new DatabaseInitializationError("recovery", new Error("Database missing with recovery artifacts present"));
    }
    const opened = await openLive(true, false);
    cleanArtifacts();
    return opened;
  }

  function access<T>(task: (db: LocalDatabase) => Promise<T>) {
    if (restoring) return Promise.reject(new Error("Database restore in progress"));
    return enqueue(async () => task(await ensureOpen()));
  }

  // Repositories retain this handle. Each queued operation resolves the current connection.
  const handle: LocalDatabase = {
    read: (task) => access((db) => db.read(task)),
    write: (task) => access(async (db) => {
      const value = await db.write(task);
      revision += 1;
      return value;
    }),
    backupSnapshot: (directoryUri) => access((db) => db.backupSnapshot(directoryUri)),
  };

  async function migrateStaged() {
    const stage = await platform.open(restoreFiles.stage);
    try {
      await initializeDatabase(stage);
      await platform.checkInitialized(stage);
      await checkpoint(stage);
      const mode = await stage.getFirstAsync<{ journal_mode: string }>("PRAGMA journal_mode = DELETE");
      if (mode?.journal_mode !== "delete") throw new Error("Staged database is not standalone");
    } finally {
      try {
        await stage.closeAsync();
      } catch (cause) {
        blocked = new DatabaseInitializationError("recovery", cause);
        throw blocked;
      }
    }
  }

  async function replace(snapshot: Snapshot, expectedRevision: number): Promise<ReplacementStatus> {
    if (restoring) return "busy";
    restoring = true;
    try {
      return await enqueue(async () => {
        let workspace: ReturnType<typeof platform.createWorkspace> | undefined;
        try {
          const live = await ensureOpen();
          if (revision !== expectedRevision) return "stale";
          const current = connection;
          if (!current) throw new Error("Current SQLite connection is unavailable");
          await verifiedCopy(snapshot.uri, snapshot.sha256, restoreFiles.stage);
          if (snapshot.schemaVersion < migrations.length) await migrateStaged();

          workspace = platform.createWorkspace();
          await live.backupSnapshot(workspace.directoryUri);
          await platform.checkStandalone(backupSnapshotName, workspace.directoryUri);
          const safety = platform.file(backupSnapshotName, workspace.directoryUri);
          await verifiedCopy(safety.uri, await safety.sha256(), restoreFiles.pending);

          await checkpoint(current);
          await closeLive();
          file(restoreFiles.pending).rename(restoreFiles.safety);
          switchToStaged();
          await openLive(false, true);
          // With no marker, the verified replacement is committed. Startup keeps the new database.
          marker().remove();
          revision += 1;
          cleanArtifacts();
          return "restored";
        } catch (cause) {
          if (blocked) return "recovery-required";
          try {
            if (marker().exists) {
              await closeLive();
              await recoverMarked();
            } else if (!database) {
              await openLive(false, true);
            }
            cleanArtifacts();
            return "failed";
          } catch (rollbackError) {
            try {
              await closeLive();
            } catch {
              // closeLive already blocked access to the uncertain connection.
            }
            blocked ??= new DatabaseInitializationError("recovery",
              new AggregateError([cause, rollbackError], "Restore could not recover the original database"));
            return "recovery-required";
          }
        } finally {
          try {
            workspace?.remove();
          } catch {
            // The persistent safety snapshot is stored outside the temporary workspace.
          }
        }
      });
    } finally {
      restoring = false;
    }
  }

  return {
    getDatabase: () => access(async () => handle),
    readVersioned: <T>(task: (reader: SQLiteReader) => Promise<T>) =>
      access(async (db) => ({ value: await db.read(task), revision })),
    replace,
  };
}

export type DatabaseHost = ReturnType<typeof createDatabaseHost>;
