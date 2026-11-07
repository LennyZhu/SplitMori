import { getDocumentAsync } from "expo-document-picker";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { logBackupFailure, logRestoreFile, type RestoreFileStage } from "./backupDiagnostics.ts";

const selectionFailureCodes = {
  picker: "RESTORE_PICKER_FAILED",
  "picker-result": "RESTORE_PICKER_ASSET_INVALID",
  "source-file": "RESTORE_SOURCE_UNREADABLE",
  "cache-copy": "RESTORE_CACHE_COPY_FAILED",
  "cache-read": "RESTORE_CACHE_READ_FAILED",
} as const satisfies Partial<Record<RestoreFileStage, string>>;

export class RestoreFileSelectionError extends Error {
  readonly stage: keyof typeof selectionFailureCodes;

  constructor(stage: keyof typeof selectionFailureCodes) {
    super(selectionFailureCodes[stage]);
    this.stage = stage;
  }
}

export async function selectBackupFile() {
  let stage: keyof typeof selectionFailureCodes = "picker";
  let name: string | undefined;
  let size: number | undefined;
  let workspace: Directory | undefined;
  const discard = () => {
    try { workspace?.delete(); } catch { /* The OS can reclaim the cache. */ }
  };

  try {
    logRestoreFile(stage, "RESTORE_PICKER_OPEN");
    // Custom backup extensions may arrive as generic data. The restore service validates the format.
    const result = await getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: "*/*" });
    stage = "picker-result";
    if (result.canceled) {
      logRestoreFile(stage, "RESTORE_PICKER_CANCELLED");
      return null;
    }
    const [asset] = result.assets;
    name = asset?.name;
    size = asset?.size;
    if (!asset || !name || !/^file:\/\/\/[^/]/i.test(asset.uri)) throw new RestoreFileSelectionError(stage);
    logRestoreFile(stage, "RESTORE_PICKER_SELECTED", { name, size });

    stage = "source-file";
    const source = new File(asset.uri);
    if (!source.exists) throw new RestoreFileSelectionError(stage);
    size = source.size;
    logRestoreFile(stage, "RESTORE_SOURCE_FOUND", { name, size });

    // The iOS picker can return a copy in the host container cache, outside Expo Go's scoped Paths.cache.
    // Stage it in a private workspace and only ever delete files created in that workspace.
    stage = "cache-copy";
    const directory = new Directory(Paths.cache, `splitmori-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directory.create();
    workspace = directory;
    const file = new File(directory, "selected.splitmori-backup");
    await source.copy(file, { overwrite: false });
    if (!file.exists || file.size !== size) throw new RestoreFileSelectionError(stage);
    logRestoreFile(stage, "RESTORE_CACHE_COPIED", { name, size });

    stage = "cache-read";
    const handle = file.open(FileMode.ReadOnly);
    try {
      const length = Math.min(size, 1);
      if ((await handle.readBytes(1)).length !== length) throw new RestoreFileSelectionError(stage);
    } finally {
      handle.close();
    }
    logRestoreFile(stage, "RESTORE_CACHE_READABLE", { name, size });
    return { name, uri: file.uri, size, discard };
  } catch (cause) {
    discard();
    logRestoreFile(stage, selectionFailureCodes[stage], { name, size, failed: true, cause });
    throw cause instanceof RestoreFileSelectionError ? cause : new RestoreFileSelectionError(stage);
  }
}

export function describeExportFile(uri: string) {
  try {
    const file = new File(uri);
    if (!file.exists || file.size <= 0) throw new Error("Backup export is missing or empty");
    return { uri: file.uri, name: file.name, size: file.size };
  } catch (cause) {
    logBackupFailure("file-info", "BACKUP_FILE_NOT_FOUND", cause);
    throw cause;
  }
}

export async function shareBackupFile(uri: string, dialogTitle: string) {
  try {
    if (!await isAvailableAsync()) {
      logBackupFailure("share-availability", "BACKUP_SHARE_UNAVAILABLE");
      return "unavailable";
    }
  } catch (cause) {
    logBackupFailure("share-availability", "BACKUP_SHARE_FAILED", cause);
    return "failed";
  }
  try {
    await shareAsync(uri, { mimeType: "application/octet-stream", UTI: "public.data", dialogTitle });
  } catch (cause) {
    logBackupFailure("share", "BACKUP_SHARE_FAILED", cause);
    return "failed";
  }
  // Native sharing does not report whether the recipient saved the file.
  return "closed";
}
