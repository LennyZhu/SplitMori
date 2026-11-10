import { backupSnapshotName, getLocalDatabase, type LocalDatabase, type SQLiteConnection } from "../data/database.ts";
import { validateStoredLedgers } from "../data/finance.ts";
import { applyMigration, migrations, multiPayerSchemaVersion } from "../data/migrations.ts";
import { failure, type DomainErrorCode, type Failure, type Result } from "../domain/result.ts";
import { backupDiagnosticsEnabled, logBackupFailure, logBackupSchemaDifference } from "./backupDiagnostics.ts";

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
export type BackupExportStage = "open-ledger" | "workspace" | "snapshot" | "snapshot-read" | "validate"
  | "checksum" | "write" | "verify-output" | "publish";
type BackupExportResult = { readonly ok: true; readonly value: BackupExport }
  | (Failure & { readonly stage: BackupExportStage });

type InspectionFailureReporter = (step: string, code: DomainErrorCode, cause?: unknown, detailCode?: DomainErrorCode) => void;

export type BackupCounts = {
  readonly activityCount: number;
  readonly memberCount: number;
  readonly expenseCount: number;
  /** Includes expense creations, refunds, repayments, expense revisions, and voids. */
  readonly financialEventCount: number;
  readonly repaymentCount: number;
  readonly refundCount: number;
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

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };

function readSchema(db: BackupDatabase) {
  return db.getAllAsync<SchemaObject>(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type, name
  `);
}

async function withReferenceSchema<T>(
  platform: BackupPlatform, version: number, earlyRevisionTable: boolean, read: (db: BackupDatabase) => Promise<T>,
) {
  const expected = await platform.openDatabase(":memory:");
  try {
    for (let index = 0; index < version; index++) {
      if (index === 2 && earlyRevisionTable) {
        await expected.execAsync(migrations[2].replace("    reviewed_refund_ids TEXT NOT NULL,\n", ""));
      } else {
        await applyMigration(expected, index);
      }
    }
    return await read(expected);
  } finally {
    await expected.closeAsync();
  }
}

function sameSchemaObject(actual: SchemaObject, expected: SchemaObject) {
  return actual.type === expected.type && actual.name === expected.name
    && actual.tbl_name === expected.tbl_name && actual.sql === expected.sql;
}

function schemaDifferences(actual: readonly SchemaObject[], expected: readonly SchemaObject[]) {
  const key = (row: SchemaObject) => `${row.type}:${row.name}`;
  const remaining = new Map(actual.map((row) => [key(row), row]));
  const differences: { actual?: SchemaObject; expected?: SchemaObject }[] = [];
  for (const row of expected) {
    const found = remaining.get(key(row));
    remaining.delete(key(row));
    if (!found || !sameSchemaObject(found, row)) differences.push({ actual: found, expected: row });
  }
  for (const row of remaining.values()) differences.push({ actual: row });
  return differences;
}

function schemaIdentifier(name: string) {
  return /^[a-z_][a-z0-9_]{0,79}$/i.test(name) ? name : "<redacted>";
}

function readSchemaColumns(db: BackupDatabase, table: string) {
  return db.getAllAsync<{ name: string; type: string; required: number; dflt_value: string | null; pk: number; hidden: number }>(`
    SELECT name, type, "notnull" AS required, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid
  `, table);
}

async function reportSchemaDifferences(
  platform: BackupPlatform, db: BackupDatabase, version: number, actual: SchemaObject[],
  standard: SchemaObject[], early?: SchemaObject[],
) {
  try {
    const standardDiff = schemaDifferences(actual, standard);
    const earlyDiff = early && schemaDifferences(actual, early);
    const useEarly = earlyDiff !== undefined && earlyDiff.length < standardDiff.length;
    const differences = useEarly ? earlyDiff : standardDiff;
    for (const difference of differences.slice(0, 8)) {
      const { actual: found, expected } = difference;
      const row = expected ?? found;
      if (!row) continue;
      const table = row.tbl_name;
      let columnInfo;
      if (row.type === "table") {
        const actualColumns = found ? await readSchemaColumns(db, table) : [];
        const expectedColumns = expected ? await withReferenceSchema(platform, version, useEarly, (reference) =>
          readSchemaColumns(reference, table)) : [];
        const byName = new Map(actualColumns.map((column) => [column.name, column]));
        const expectedNames = new Set(expectedColumns.map(({ name }) => name));
        columnInfo = {
          missingColumns: expectedColumns.filter(({ name }) => !byName.has(name)).map(({ name }) => schemaIdentifier(name)),
          unexpectedColumns: actualColumns.filter(({ name }) => !expectedNames.has(name)).map(({ name }) => schemaIdentifier(name)),
          changedColumns: expectedColumns.filter((column) => {
            const existing = byName.get(column.name);
            return existing && (existing.type !== column.type || existing.required !== column.required || existing.pk !== column.pk
              || existing.hidden !== column.hidden || existing.dflt_value !== column.dflt_value);
          }).map(({ name }) => schemaIdentifier(name)),
          columnOrderChanged: actualColumns.filter(({ name }) => expectedNames.has(name)).map(({ name }) => name).join("\0")
            !== expectedColumns.filter(({ name }) => byName.has(name)).map(({ name }) => name).join("\0"),
        };
      }
      logBackupSchemaDifference({
        schemaVersion: version, expectedSchemaVersion: version, reference: useEarly ? "early-v3" : "standard",
        table: schemaIdentifier(table), object: schemaIdentifier(row.name),
        mismatchKind: !found ? `missing-${row.type}` : !expected ? `unexpected-${row.type}` : `${row.type}-definition`,
        ...(row.type === "index" ? {
          missingIndexes: found ? [] : [schemaIdentifier(row.name)],
          unexpectedIndexes: expected ? [] : [schemaIdentifier(row.name)],
          changedIndexes: found && expected ? [schemaIdentifier(row.name)] : [],
        } : columnInfo),
      });
    }
  } catch (cause) {
    // Diagnostics must not change the validation result.
    logBackupFailure("validate-schema-diagnostics", "BACKUP_SCHEMA_MISMATCH", cause);
  }
}

async function schemaMatches(platform: BackupPlatform, db: BackupDatabase, version: number) {
  const actual = await readSchema(db);
  function matches(reference: Awaited<ReturnType<typeof readSchema>>) {
    return actual.length === reference.length && actual.every((row, index) => sameSchemaObject(row, reference[index]));
  }
  const standard = await withReferenceSchema(platform, version, false, readSchema);
  if (matches(standard)) return true;
  // v13 rebuilds the revision table, so both pre-v13 layouts converge on one exact schema.
  const early = version >= 3 && version < multiPayerSchemaVersion
    ? await withReferenceSchema(platform, version, true, readSchema) : undefined;
  if (early && matches(early)) return true;
  if (backupDiagnosticsEnabled()) await reportSchemaDifferences(platform, db, version, actual, standard, early);
  return false;
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
    refundCount: await count("merchant_refunds", 2),
    quickHistoryCount: await count("quick_history", 4),
  };
}

export async function inspectBackupDatabase(
  platform: BackupPlatform, db: BackupDatabase, expectedVersion?: number, onFailure?: InspectionFailureReporter,
): Promise<Result<BackupCounts>> {
  let step = "version";
  function reject(code: DomainErrorCode, cause?: unknown, detailCode?: DomainErrorCode) {
    onFailure?.(step, code, cause, detailCode);
    return failure(code, "backup");
  }
  try {
    const version = await readVersion(db);
    if (!supportedSchema(version)) return reject("UNSUPPORTED_BACKUP_VERSION");
    if (expectedVersion !== undefined && version !== expectedVersion) {
      logBackupSchemaDifference({ schemaVersion: version, expectedSchemaVersion: expectedVersion, mismatchKind: "version" });
      return reject("BACKUP_SCHEMA_MISMATCH");
    }
    step = "integrity";
    const integrity = await db.getAllAsync<{ integrity_check: string }>("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") return reject("BACKUP_INTEGRITY_FAILED");
    step = "schema";
    if (!await schemaMatches(platform, db, version)) return reject("BACKUP_SCHEMA_MISMATCH");
    step = "foreign-keys";
    if (await db.getFirstAsync("PRAGMA foreign_key_check")) return reject("BACKUP_FOREIGN_KEYS_FAILED");
    step = "ledger";
    try {
      const ledger = await validateStoredLedgers(db, version);
      if (!ledger.ok) return reject("BACKUP_LEDGER_INVALID", undefined, ledger.error.code);
    } catch (cause) {
      return reject("BACKUP_LEDGER_INVALID", cause);
    }
    step = "counts";
    return { ok: true, value: await readBackupCounts(db, version) };
  } catch (cause) {
    return reject("BACKUP_INTEGRITY_FAILED", cause);
  }
}

export async function inspectStandaloneBackup(
  platform: BackupPlatform, name: string, directoryUri: string, expectedVersion?: number, onFailure?: InspectionFailureReporter,
): Promise<Result<BackupCounts>> {
  let db: BackupDatabase | undefined;
  let step = "open";
  try {
    // Expo has no read-only open flag. Open only app-owned snapshots and disable writes.
    db = await platform.openDatabase(name, directoryUri);
    step = "journal";
    await db.execAsync("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const journal = await db.getFirstAsync<{ journal_mode: string }>("PRAGMA journal_mode");
    if (journal?.journal_mode !== "delete") {
      onFailure?.(step, "BACKUP_INTEGRITY_FAILED");
      return failure("BACKUP_INTEGRITY_FAILED", "backup");
    }
    return await inspectBackupDatabase(platform, db, expectedVersion, onFailure);
  } catch (cause) {
    onFailure?.(step, "BACKUP_INTEGRITY_FAILED", cause);
    return failure("BACKUP_INTEGRITY_FAILED", "backup");
  } finally {
    try {
      await db?.closeAsync();
    } catch (cause) {
      onFailure?.("close", "BACKUP_INTEGRITY_FAILED", cause);
      throw cause;
    }
  }
}

export function createBackupService(platform: BackupPlatform) {
  async function exportBackup(database: LocalDatabase, options: BackupExportOptions = {}): Promise<BackupExportResult> {
    let workspace: BackupWorkspace | undefined;
    let stage: BackupExportStage = "workspace";
    try {
      workspace = platform.createWorkspace();
      stage = "snapshot";
      await database.backupSnapshot(workspace.directoryUri);
      stage = "snapshot-read";
      const snapshot = workspace.file(backupSnapshotName);
      if (!snapshot.exists) throw new Error("SQLite snapshot is missing");
      const byteLength = snapshot.size;
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new Error("Invalid SQLite snapshot size");
      stage = "validate";
      const schemaVersion = migrations.length;
      const checked = await inspectStandaloneBackup(platform, backupSnapshotName, workspace.directoryUri, schemaVersion,
        (step, code, cause, detailCode) => logBackupFailure(`validate-${step}`, code, cause, detailCode));
      if (!checked.ok) return { ...checked, stage };
      stage = "checksum";
      const sha256 = await snapshot.sha256();
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        logBackupFailure(stage, "BACKUP_CHECKSUM_MISMATCH");
        return { ...failure("BACKUP_CHECKSUM_MISMATCH", "backup"), stage };
      }
      const manifest: BackupManifest = {
        formatVersion: 1, schemaVersion, createdAt: Date.now(), byteLength, sha256, assets: [],
      };
      stage = "write";
      const filename = `SplitMori-${workspace.token}${extension}`;
      const output = workspace.file(filename);
      const header = new TextEncoder().encode(`${magic}\n${JSON.stringify(manifest)}\n`);
      output.create();
      await withFile(output, "write", async (destination) => {
        await destination.writeBytes(header);
        const complete = await withFile(snapshot, "read", (source) => copyPayload(source, destination, manifest.byteLength));
        if (!complete) throw new Error("Incomplete backup snapshot");
      });
      stage = "verify-output";
      const expectedSize = header.length + manifest.byteLength;
      if (!output.exists || output.size !== expectedSize) throw new Error("Incomplete backup output");
      stage = "publish";
      const uri = await platform.publish(output.uri, options.destinationDirectoryUri);
      const published = platform.file(uri);
      if (!published.exists || published.size !== expectedSize) throw new Error("Published backup is incomplete");
      return { ok: true, value: { uri, manifest } };
    } catch (cause) {
      logBackupFailure(stage, "BACKUP_EXPORT_FAILED", cause);
      return { ...failure("BACKUP_EXPORT_FAILED", "backup"), stage };
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

export async function exportBackup(options?: BackupExportOptions): Promise<BackupExportResult> {
  try {
    const { expoBackupPlatform } = await import("./backupExpo.ts");
    return await createBackupService(expoBackupPlatform).exportBackup(await getLocalDatabase(), options);
  } catch (cause) {
    logBackupFailure("open-ledger", "BACKUP_EXPORT_FAILED", cause);
    return { ...failure("BACKUP_EXPORT_FAILED", "backup"), stage: "open-ledger" };
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
