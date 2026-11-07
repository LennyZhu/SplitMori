import { DatabaseInitializationError } from "../data/database.ts";
import type { DatabaseHost } from "../data/databaseHost.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import { createBackupService, readBackupCounts, type BackupCounts, type BackupPreview } from "./backup.ts";

type RestoreConfirmation = object;

export type RestorePreview = {
  readonly confirmation: RestoreConfirmation;
  readonly effect: "replace-all-local-data";
  readonly current: BackupCounts;
  readonly backup: BackupPreview;
  /** Backup counts minus current counts. */
  readonly difference: BackupCounts;
};

export type RestoreRequest = { readonly confirmation: RestoreConfirmation; readonly confirmed: boolean };

type ValidationFailure = {
  readonly status: "validation-failed";
  readonly code: DomainErrorCode | "INVALID_BACKUP_URI" | "INVALID_CONFIRMATION" | "BACKUP_CHANGED" | "CURRENT_DATA_CHANGED";
};

export type RestoreOutcome = ValidationFailure
  | { readonly status: "restored" | "cancelled" | "busy" | "failed" | "recovery-required" };

export type PrepareRestoreOutcome = ValidationFailure
  | { readonly status: "ready"; readonly preview: RestorePreview }
  | { readonly status: "failed" | "recovery-required" };

function allowedBackupUri(uri: string): boolean {
  // Accept only local files or document-provider URIs. Native read permissions still apply.
  if (typeof uri !== "string" || /[?#\\\u0000-\u001f\u007f]/.test(uri)) return false;
  const path = /^(?:file:\/\/|content:\/\/[a-z0-9_.-]+)(\/[^/].*)$/i.exec(uri)?.[1];
  if (!path) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !/[\\\u0000-\u001f\u007f]/.test(decoded) && !decoded.split("/").some((part) => part === "." || part === "..");
  } catch {
    return false;
  }
}

function difference(current: BackupCounts, backup: BackupCounts): BackupCounts {
  return {
    activityCount: backup.activityCount - current.activityCount,
    memberCount: backup.memberCount - current.memberCount,
    expenseCount: backup.expenseCount - current.expenseCount,
    financialEventCount: backup.financialEventCount - current.financialEventCount,
    repaymentCount: backup.repaymentCount - current.repaymentCount,
    refundCount: backup.refundCount - current.refundCount,
    quickHistoryCount: backup.quickHistoryCount - current.quickHistoryCount,
  };
}

export function createRestoreService(
  backups: Pick<ReturnType<typeof createBackupService>, "validateBackup" | "withValidatedSnapshot">,
  host: Pick<DatabaseHost, "readVersioned" | "replace">,
) {
  const confirmations = new WeakMap<RestoreConfirmation, { uri: string; identity: string; revision: number }>();

  async function prepareRestore(uri: string): Promise<PrepareRestoreOutcome> {
    if (!allowedBackupUri(uri)) return { status: "validation-failed", code: "INVALID_BACKUP_URI" };
    try {
      const result = await backups.validateBackup(uri);
      if (!result.ok) return { status: "validation-failed", code: result.error.code };
      const { value: current, revision } = await host.readVersioned(readBackupCounts);
      const confirmation = Object.freeze({});
      const backup = result.value;
      confirmations.set(confirmation, { uri, identity: JSON.stringify(backup.manifest), revision });
      return { status: "ready", preview: {
        confirmation, effect: "replace-all-local-data", current, backup, difference: difference(current, backup),
      } };
    } catch (error) {
      return { status: error instanceof DatabaseInitializationError && error.stage === "recovery" ? "recovery-required" : "failed" };
    }
  }

  async function restoreBackup(request: RestoreRequest): Promise<RestoreOutcome> {
    const prepared = confirmations.get(request.confirmation);
    if (!prepared || (request.confirmed !== true && request.confirmed !== false)) {
      return { status: "validation-failed", code: "INVALID_CONFIRMATION" };
    }
    confirmations.delete(request.confirmation);
    if (!request.confirmed) return { status: "cancelled" };

    try {
      const validated = await backups.withValidatedSnapshot(prepared.uri, async (snapshot, preview): Promise<RestoreOutcome> => {
        const { manifest } = preview;
        if (JSON.stringify(manifest) !== prepared.identity) return { status: "validation-failed", code: "BACKUP_CHANGED" };
        const status = await host.replace({
          uri: snapshot.uri, sha256: manifest.sha256, schemaVersion: manifest.schemaVersion,
        }, prepared.revision);
        return status === "stale" ? { status: "validation-failed", code: "CURRENT_DATA_CHANGED" } : { status };
      });
      return validated.ok ? validated.value : { status: "validation-failed", code: validated.error.code };
    } catch {
      return { status: "failed" };
    }
  }

  return { prepareRestore, restoreBackup };
}

let expoRestoreService: ReturnType<typeof createRestoreService> | undefined;

async function nativeRestoreService() {
  const [{ expoDatabaseHost }, { expoBackupPlatform }] = await Promise.all([
    import("../data/databaseExpo.ts"), import("./backupExpo.ts"),
  ]);
  return expoRestoreService ??= createRestoreService(createBackupService(expoBackupPlatform), expoDatabaseHost);
}

export async function prepareRestore(uri: string): Promise<PrepareRestoreOutcome> {
  try {
    return await (await nativeRestoreService()).prepareRestore(uri);
  } catch {
    return { status: "failed" };
  }
}

export async function restoreBackup(request: RestoreRequest): Promise<RestoreOutcome> {
  try {
    return await (await nativeRestoreService()).restoreBackup(request);
  } catch {
    return { status: "failed" };
  }
}
