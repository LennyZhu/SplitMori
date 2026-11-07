import { backupSnapshotName, getLocalDatabase, type LocalDatabase, type SQLiteConnection } from "../data/database.ts";
import { validateStoredLedgers } from "../data/finance.ts";
import { applyMigration, migrations } from "../data/migrations.ts";
import { failure, type Result } from "../domain/result.ts";

const magic = "SplitMori Backup";
// Magic line, one bounded JSON manifest line, then exactly byteLength raw SQLite bytes.
const extension = ".splitmori-backup";
const headerLimit = 4096;
const chunkSize = 256 * 1024;

export type BackupManifest = {
  readonly formatVersion: 1;
  readonly schemaVersion: number;
  readonly createdAt: number | null;
  readonly byteLength: number;
  readonly sha256: string;
  readonly assets: readonly [];
};

export type BackupExport = { readonly uri: string; readonly manifest: BackupManifest };
export type BackupExportOptions = { readonly destinationDirectoryUri?: string };

export type BackupCounts = {
  readonly activityCount: number;
  readonly memberCount: number;
  readonly expenseCount: number;
  /** Includes expense creations, refunds, repayments, expense revisions, and voids. */
  readonly financialEventCount: number;
  readonly repaymentCount: number;
  readonly quickHistoryCount: number;
};

export type BackupPreview = BackupCounts & {
  readonly validationStatus: "valid";
  readonly manifest: BackupManifest;
  readonly fileModifiedAt: number | null;
};

export type BackupFileHandle = {
  readBytes(length: number): Promise<Uint8Array<ArrayBuffer>>;
  writeBytes(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): void;
};

export type BackupFile = {
  readonly uri: string;
  readonly exists: boolean;
  readonly size: number;
  readonly modificationTime: number | null;
  create(): void;
  open(mode: "read" | "write"): BackupFileHandle;
  sha256(): Promise<string>;
};

export type BackupWorkspace = {
  readonly directoryUri: string;
  readonly token: string;
  file(name: string): BackupFile;
  remove(): void;
};

export type BackupDatabase = Pick<SQLiteConnection, "getFirstAsync" | "getAllAsync" | "execAsync"> & {
  closeAsync(): Promise<void>;
};

export type BackupPlatform = {
  createWorkspace(): BackupWorkspace;
  file(uri: string): BackupFile;
  openDatabase(name: string, directoryUri?: string): Promise<BackupDatabase>;
  publish(sourceUri: string, destinationDirectoryUri?: string): Promise<string>;
};

async function withFile<T>(file: BackupFile, mode: "read" | "write", task: (handle: BackupFileHandle) => Promise<T>) {
  const handle = file.open(mode);
  try {
    return await task(handle);
  } finally {
    handle.close();
  }
}

function discardWorkspace(workspace: BackupWorkspace | undefined) {
  try {
    workspace?.remove();
  } catch {
    // Temporary cache cleanup must not mask the backup result.
  }
}

async function copyPayload(source: BackupFileHandle, destination: BackupFileHandle, length: number, initial?: Uint8Array<ArrayBuffer>) {
  let remaining = length;
  let bytes = initial ?? await source.readBytes(chunkSize);
  while (bytes.length > 0) {
    if (bytes.length > remaining) return false;
    await destination.writeBytes(bytes);
    remaining -= bytes.length;
    bytes = await source.readBytes(chunkSize);
  }
  return remaining === 0;
}

function supportedSchema(version: unknown): version is number {
  return typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= migrations.length;
}

function fileTime(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readHeader(input: BackupFileHandle) {
  const prefix = new Uint8Array(headerLimit);
  let size = 0;
  let first = -1;
  let second = -1;
  while (size < prefix.length && second < 0) {
    const bytes = await input.readBytes(prefix.length - size);
    if (!bytes.length) break;
    prefix.set(bytes, size);
    size += bytes.length;
    const received = prefix.subarray(0, size);
    first = received.indexOf(10);
    if (first >= 0) second = received.indexOf(10, first + 1);
  }
  const decoder = new TextDecoder();
  if (second < 0 || decoder.decode(prefix.subarray(0, first)) !== magic) {
    return failure("INVALID_BACKUP_FORMAT", "backup");
  }
  let raw: Partial<BackupManifest>;
  try {
    raw = JSON.parse(decoder.decode(prefix.subarray(first + 1, second)));
  } catch {
    return failure("INVALID_BACKUP_FORMAT", "backup");
  }
  if (!raw || !Number.isInteger(raw.formatVersion) || !Number.isInteger(raw.schemaVersion)) {
    return failure("INVALID_BACKUP_FORMAT", "backup");
  }
  if (raw.formatVersion !== 1 || !supportedSchema(raw.schemaVersion)) {
    return failure("UNSUPPORTED_BACKUP_VERSION", "backup");
  }
  const { schemaVersion, byteLength, sha256, assets } = raw;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1
    || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !Array.isArray(assets) || assets.length !== 0) {
    return failure("INVALID_BACKUP_FORMAT", "backup");
  }
  const manifest: BackupManifest = { formatVersion: 1, schemaVersion, createdAt: fileTime(raw.createdAt), byteLength, sha256, assets: [] };
  return { ok: true, value: { manifest, initial: prefix.subarray(second + 1, size) } } as const;
}

async function readVersion(db: BackupDatabase) {
  return (await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version"))?.user_version;
}

function readSchema(db: BackupDatabase) {
  return db.getAllAsync<{ type: string; name: string; tbl_name: string; sql: string }>(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type, name
  `);
}

async function referenceSchema(platform: BackupPlatform, version: number, earlyRevisionTable = false) {
  const expected = await platform.openDatabase(":memory:");
  try {
    for (let index = 0; index < version; index++) {
      if (index === 2 && earlyRevisionTable) {
        await expected.execAsync(migrations[2].replace("    reviewed_refund_ids TEXT NOT NULL,\n", ""));
      } else {
        await applyMigration(expected, index);
      }
    }
    return await readSchema(expected);
  } finally {
    await expected.closeAsync();
  }
}

async function schemaMatches(platform: BackupPlatform, db: BackupDatabase, version: number) {
  const actual = await readSchema(db);
  function matches(reference: Awaited<ReturnType<typeof readSchema>>) {
    return actual.length === reference.length && actual.every((row, index) => {
      const other = reference[index];
      return row.type === other.type && row.name === other.name && row.tbl_name === other.tbl_name && row.sql === other.sql;
    });
  }
  if (matches(await referenceSchema(platform, version))) return true;
  // Match the complete known early schema, including the appended v10 column after repair.
  return version >= 3 && matches(await referenceSchema(platform, version, true));
}

export async function readBackupCounts(
  db: Pick<BackupDatabase, "getFirstAsync">, version: number = migrations.length,
): Promise<BackupCounts> {
  async function count(table: string, introduced = 1) {
    if (version < introduced) return 0;
    const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error("Invalid backup row count");
    return row.count;
  }
  return {
    activityCount: await count("activities"),
    memberCount: await count("members"),
    expenseCount: await count("expenses", 2),
    financialEventCount: await count("financial_events", 2) + await count("expense_revisions", 3)
      + await count("financial_voids", 6),
    repaymentCount: await count("member_transfers", 2),
    quickHistoryCount: await count("quick_history", 4),
  };
}

export async function inspectBackupDatabase(
  platform: BackupPlatform, db: BackupDatabase, expectedVersion?: number,
): Promise<Result<BackupCounts>> {
  try {
    const version = await readVersion(db);
    if (!supportedSchema(version)) return failure("UNSUPPORTED_BACKUP_VERSION", "backup");
    if (expectedVersion !== undefined && version !== expectedVersion) return failure("BACKUP_SCHEMA_MISMATCH", "backup");
    const integrity = await db.getAllAsync<{ integrity_check: string }>("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") return failure("BACKUP_INTEGRITY_FAILED", "backup");
    if (!await schemaMatches(platform, db, version)) return failure("BACKUP_SCHEMA_MISMATCH", "backup");
    if (await db.getFirstAsync("PRAGMA foreign_key_check")) return failure("BACKUP_FOREIGN_KEYS_FAILED", "backup");
    try {
      if (!(await validateStoredLedgers(db, version)).ok) return failure("BACKUP_LEDGER_INVALID", "backup");
    } catch {
      return failure("BACKUP_LEDGER_INVALID", "backup");
    }
    return { ok: true, value: await readBackupCounts(db, version) };
  } catch {
    return failure("BACKUP_INTEGRITY_FAILED", "backup");
  }
}

export async function inspectStandaloneBackup(
  platform: BackupPlatform, name: string, directoryUri: string, expectedVersion?: number,
): Promise<Result<BackupCounts>> {
  let db: BackupDatabase | undefined;
  try {
    // Expo has no read-only open flag. Open only app-owned snapshots and disable writes.
    db = await platform.openDatabase(name, directoryUri);
    await db.execAsync("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const journal = await db.getFirstAsync<{ journal_mode: string }>("PRAGMA journal_mode");
    if (journal?.journal_mode !== "delete") return failure("BACKUP_INTEGRITY_FAILED", "backup");
    return await inspectBackupDatabase(platform, db, expectedVersion);
  } catch {
    return failure("BACKUP_INTEGRITY_FAILED", "backup");
  } finally {
    await db?.closeAsync();
  }
}

export function createBackupService(platform: BackupPlatform) {
  async function exportBackup(database: LocalDatabase, options: BackupExportOptions = {}): Promise<Result<BackupExport>> {
    let workspace: BackupWorkspace | undefined;
    try {
      workspace = platform.createWorkspace();
      await database.backupSnapshot(workspace.directoryUri);
      const snapshot = workspace.file(backupSnapshotName);
      if (!snapshot.exists) throw new Error("SQLite snapshot is missing");
      const byteLength = snapshot.size;
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new Error("Invalid SQLite snapshot size");
      const db = await platform.openDatabase(backupSnapshotName, workspace.directoryUri);
      let schemaVersion: number | undefined;
      try {
        schemaVersion = await readVersion(db);
      } finally {
        await db.closeAsync();
      }
      if (!supportedSchema(schemaVersion)) return failure("UNSUPPORTED_BACKUP_VERSION", "backup");
      const manifest: BackupManifest = {
        formatVersion: 1, schemaVersion, createdAt: Date.now(), byteLength,
        sha256: await snapshot.sha256(), assets: [],
      };
      const filename = `SplitMori-${workspace.token}${extension}`;
      const output = workspace.file(filename);
      output.create();
      await withFile(output, "write", async (destination) => {
        await destination.writeBytes(new TextEncoder().encode(`${magic}\n${JSON.stringify(manifest)}\n`));
        const complete = await withFile(snapshot, "read", (source) => copyPayload(source, destination, manifest.byteLength));
        if (!complete) throw new Error("Incomplete backup snapshot");
      });
      const uri = await platform.publish(output.uri, options.destinationDirectoryUri);
      return { ok: true, value: { uri, manifest } };
    } catch {
      return failure("BACKUP_EXPORT_FAILED", "backup");
    } finally {
      discardWorkspace(workspace);
    }
  }

  // The callback can use the same private snapshot that was extracted, hashed and inspected.
  async function withValidatedSnapshot<T>(
    uri: string, task: (snapshot: BackupFile, preview: BackupPreview) => Promise<T>,
  ): Promise<Result<T>> {
    let workspace: BackupWorkspace | undefined;
    try {
      const file = platform.file(uri);
      if (!file.exists) return failure("BACKUP_FILE_NOT_FOUND", "backup");
      const fileModifiedAt = fileTime(file.modificationTime);
      workspace = platform.createWorkspace();
      const snapshot = workspace.file(backupSnapshotName);
      const extracted = await withFile(file, "read", async (source) => {
        const header = await readHeader(source);
        if (!header.ok) return header;
        const { manifest, initial } = header.value;
        snapshot.create();
        const complete = await withFile(snapshot, "write", (destination) => copyPayload(
          source, destination, manifest.byteLength, initial.length ? initial : undefined,
        ));
        if (!complete || await snapshot.sha256() !== manifest.sha256) return failure("BACKUP_CHECKSUM_MISMATCH", "backup");
        return { ok: true, value: manifest } as const;
      });
      if (!extracted.ok) return extracted;
      const manifest = extracted.value;
      const inspected = await inspectStandaloneBackup(platform, backupSnapshotName, workspace.directoryUri, manifest.schemaVersion);
      if (!inspected.ok) return inspected;
      const preview: BackupPreview = { validationStatus: "valid", manifest, fileModifiedAt, ...inspected.value };
      return { ok: true, value: await task(snapshot, preview) };
    } catch {
      return failure("BACKUP_READ_FAILED", "backup");
    } finally {
      discardWorkspace(workspace);
    }
  }

  const validateBackup = (uri: string) => withValidatedSnapshot(uri, async (_snapshot, preview) => preview);
  return { exportBackup, validateBackup, previewBackup: validateBackup, withValidatedSnapshot };
}

export async function exportBackup(options?: BackupExportOptions): Promise<Result<BackupExport>> {
  try {
    const { expoBackupPlatform } = await import("./backupExpo.ts");
    return await createBackupService(expoBackupPlatform).exportBackup(await getLocalDatabase(), options);
  } catch {
    return failure("BACKUP_EXPORT_FAILED", "backup");
  }
}

export async function validateBackup(uri: string): Promise<Result<BackupPreview>> {
  try {
    const { expoBackupPlatform } = await import("./backupExpo.ts");
    return await createBackupService(expoBackupPlatform).validateBackup(uri);
  } catch {
    return failure("BACKUP_READ_FAILED", "backup");
  }
}

export const previewBackup = validateBackup;
