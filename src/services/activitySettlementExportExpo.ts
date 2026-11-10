import { requireOptionalNativeModule, uuid } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { SettlementDocumentPlatform } from "./activitySettlementExport.ts";

const native = Platform.OS === "ios" ? requireOptionalNativeModule<{
  share(uri: string, title: string): Promise<"completed" | "cancelled">;
}>("SplitMoriDocumentShare") : null;

function remove(entry?: Directory | File) {
  try {
    if (entry?.exists) entry.delete();
  } catch {
    // Cache cleanup is best effort. The existing S11 share cache also expires old files.
  }
}

export const settlementDocumentPlatform: SettlementDocumentPlatform = {
  supports: (format) => !!native && (format !== "pdf" || !!requireOptionalNativeModule("ExpoPrint")),
  async prepare({ format, name, content }) {
    const directory = new Directory(Paths.cache, "splitmori-share", `settlement-${uuid.v4()}`);
    let source: File | undefined;
    try {
      directory.create({ intermediates: true });
      const file = new File(directory, name);
      if (format === "pdf") {
        const { printToFileAsync } = await import("expo-print");
        const pdf = await printToFileAsync({
          html: content, width: 595, height: 842, margins: { top: 32, bottom: 32, left: 34, right: 34 },
        });
        source = new File(pdf.uri);
        if (pdf.numberOfPages < 1) throw new Error("Empty PDF");
        await source.copy(file, { overwrite: false });
      } else {
        await file.write(content);
      }
      if (!file.exists || !file.size) throw new Error("Empty settlement export");
      return { uri: file.uri, discard: () => remove(directory) };
    } catch (error) {
      remove(directory);
      throw error;
    } finally {
      remove(source);
    }
  },
  async present(uri, title) {
    if (!native) throw new Error("System sharing is unavailable");
    return native.share(uri, title);
  },
};
