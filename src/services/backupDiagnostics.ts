export function backupDiagnosticsEnabled() {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

function safeNativeCode(cause: unknown) {
  const code = cause instanceof Error ? (cause as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(?:ERR_[A-Z0-9_]{1,64}|E[A-Z]{2,12})$/.test(code) ? code : undefined;
}

export type RestoreFileStage = "picker" | "picker-result" | "source-file" | "cache-copy" | "cache-read" | "prepare-restore";

export function logRestoreFile(stage: RestoreFileStage, code: string, details: {
  name?: string;
  size?: number;
  failed?: boolean;
  cause?: unknown;
} = {}) {
  if (!backupDiagnosticsEnabled()) return;
  const suffix = /\.([^.]+)$/.exec(details.name ?? "")?.[1]?.toLowerCase();
  const extension = !suffix ? undefined : ["splitmori-backup", "zip", "db", "sqlite", "sqlite3"].includes(suffix) ? suffix : "other";
  const size = typeof details.size === "number" && Number.isSafeInteger(details.size) && details.size >= 0 ? details.size : undefined;
  const metadata = { stage, code, size, extension, nativeCode: safeNativeCode(details.cause) };
  if (details.failed) console.warn("[SplitMori restore-file]", metadata);
  else console.info("[SplitMori restore-file]", metadata);
}

export function logBackupSchemaDifference(details: {
  schemaVersion: number;
  expectedSchemaVersion: number;
  mismatchKind: string;
  reference?: "standard" | "early-v3";
  table?: string;
  object?: string;
  missingColumns?: string[];
  unexpectedColumns?: string[];
  changedColumns?: string[];
  columnOrderChanged?: boolean;
  missingIndexes?: string[];
  unexpectedIndexes?: string[];
  changedIndexes?: string[];
}) {
  if (!backupDiagnosticsEnabled()) return;
  console.warn("[SplitMori backup]", { stage: "validate-schema", code: "BACKUP_SCHEMA_MISMATCH", ...details });
}

export function logBackupFailure(stage: string, code: string, cause?: unknown, detailCode?: string) {
  if (!backupDiagnosticsEnabled()) return;

  // Native messages and stack traces can contain paths, SQL, or identifiers.
  const native = cause instanceof Error ? cause as Error & { code?: unknown } : undefined;
  const nativeCode = safeNativeCode(native);
  const sqliteCode = native?.message.match(/\bError code (\d{1,5})(?=[:\s]|$)/i)?.[1];
  const errorKind = native instanceof TypeError ? "TypeError" : native instanceof ReferenceError ? "ReferenceError"
    : native instanceof RangeError ? "RangeError" : native ? "Error" : undefined;
  console.warn("[SplitMori backup]", { stage, code, detailCode, nativeCode, sqliteCode, errorKind });
}
