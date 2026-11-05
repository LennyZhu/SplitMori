import { Directory, File, FileMode, Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";
import type { BackupFile, BackupPlatform } from "./backup.ts";

function wrapFile(file: File): BackupFile {
  return {
    get uri() { return file.uri; },
    get exists() { return file.exists; },
    get size() { return file.size; },
    get modificationTime() {
      try {
        // Some document providers return zero when the modification time is unavailable.
        return file.modificationTime || null;
      } catch {
        return null;
      }
    },
    create: () => file.create(),
    open: (mode) => file.open(mode === "read" ? FileMode.ReadOnly : FileMode.WriteOnly),
    sha256: () => file.digest("SHA-256"),
  };
}

export const expoBackupPlatform: BackupPlatform = {
  createWorkspace() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const directory = new Directory(Paths.cache, `splitmori-backup-${token}`);
    directory.create();
    return {
      directoryUri: directory.uri, token,
      file: (name) => wrapFile(new File(directory, name)),
      remove: () => directory.delete(),
    };
  },
  file: (uri) => wrapFile(new File(uri)),
  openDatabase: (name, directoryUri) => openDatabaseAsync(name, { useNewConnection: true }, directoryUri),
  async publish(sourceUri, destinationDirectoryUri) {
    const directory = destinationDirectoryUri
      ? new Directory(destinationDirectoryUri)
      : new Directory(Paths.document, "SplitMori Backups");
    if (!destinationDirectoryUri) directory.create({ idempotent: true, intermediates: true });
    const output = new File(sourceUri);
    // Move the finished file without overwriting an existing export, and use the URI returned by the provider.
    await output.move(directory, { overwrite: false });
    return output.uri;
  },
};
