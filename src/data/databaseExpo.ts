import { Directory, File } from "expo-file-system";
import { backupDatabaseAsync, defaultDatabaseDirectory, openDatabaseAsync } from "expo-sqlite";
import { inspectBackupDatabase, inspectStandaloneBackup } from "../services/backup.ts";
import { expoBackupPlatform } from "../services/backupExpo.ts";
import { logBackupFailure } from "../services/backupDiagnostics.ts";
import { backupSnapshotName } from "./database.ts";
import { createDatabaseHost } from "./databaseHost.ts";
import { migrations } from "./migrations.ts";

const directoryUri = defaultDatabaseDirectory.startsWith("/")
  ? `file://${defaultDatabaseDirectory.split("/").map(encodeURIComponent).join("/")}`
  : defaultDatabaseDirectory;

function file(name: string, directory = directoryUri) {
  return new File(new Directory(directory), name);
}

async function snapshotStep<T>(step: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (cause) {
    logBackupFailure(step, "BACKUP_EXPORT_FAILED", cause);
    throw cause;
  }
}

export const expoDatabaseHost = createDatabaseHost({
  directoryUri,
  file(name, directory) {
    const target = file(name, directory);
    return {
      get uri() { return target.uri; },
      get exists() { return target.exists; },
      sha256: () => target.digest("SHA-256"),
      remove: () => target.delete(),
      rename: (newName) => target.rename(newName),
    };
  },
  copy: (sourceUri, destinationName) => new File(sourceUri).copy(file(destinationName), { overwrite: false }),
  open: (name) => openDatabaseAsync(name, { useNewConnection: true }),
  async backup(source, destinationDirectoryUri) {
    const destination = await snapshotStep("snapshot-open", () =>
      openDatabaseAsync(backupSnapshotName, { useNewConnection: true }, destinationDirectoryUri));
    try {
      await snapshotStep("snapshot-copy", () => backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination }));
      await snapshotStep("snapshot-journal", async () => {
        const mode = await destination.getFirstAsync<{ journal_mode: string }>("PRAGMA journal_mode = DELETE");
        if (mode?.journal_mode !== "delete") throw new Error("Backup snapshot requires a standalone journal mode");
      });
    } finally {
      await snapshotStep("snapshot-close", () => destination.closeAsync());
    }
  },
  createWorkspace: expoBackupPlatform.createWorkspace,
  async checkStandalone(name, directory) {
    if (!file(name, directory).exists) throw new Error("Safety snapshot is missing");
    const checked = await inspectStandaloneBackup(expoBackupPlatform, name, directory);
    if (!checked.ok) throw new Error(checked.error.code);
  },
  async checkInitialized(connection) {
    const checked = await inspectBackupDatabase(expoBackupPlatform, connection, migrations.length);
    if (!checked.ok) throw new Error(checked.error.code);
  },
});
