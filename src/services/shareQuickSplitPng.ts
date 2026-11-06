import { uuid } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { Platform, type View } from "react-native";
import type { ComponentRef } from "react";
import { captureRef, releaseCapture } from "react-native-view-shot";

export type ShareOutcome = "closed" | "unavailable" | "capture-failed" | "share-failed" | "too-large";

function remove(file: File | undefined) {
  try {
    if (file?.exists) file.delete();
  } catch {
    // Cache cleanup is best effort.
  }
}

function cleanOldShares(directory: Directory) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const entry of directory.list()) {
      if (entry instanceof File && entry.name.endsWith(".png")) {
        const modified = entry.modificationTime;
        if (modified && modified < cutoff) remove(entry);
      }
    }
  } catch {
    // An unreadable cache entry should not prevent sharing.
  }
}

export async function shareQuickSplitPng(view: ComponentRef<typeof View>, isCurrent: () => boolean): Promise<ShareOutcome> {
  let capture: string | undefined;
  let file: File | undefined;
  let presenting = false;
  let keepForRecipient = false;
  try {
    if (!await isAvailableAsync()) return "unavailable";
    if (!isCurrent()) return "closed";

    // The view is the complete card inside a non-clipping ScrollView. Render its own layer on iOS.
    capture = await captureRef(view, { format: "png", result: "tmpfile", useRenderInContext: true });
    if (!isCurrent()) return "closed";

    const directory = new Directory(Paths.cache, "splitmori-share");
    directory.create({ idempotent: true, intermediates: true });
    cleanOldShares(directory);
    const uri = capture.startsWith("/") ? `file://${capture.split("/").map(encodeURIComponent).join("/")}` : capture;
    file = new File(directory, `SplitMori-${uuid.v4()}.png`);
    await new File(uri).copy(file, { overwrite: false });
    if (!file.exists || file.size === 0) return "capture-failed";
    if (!isCurrent()) return "closed";

    presenting = true;
    await shareAsync(file.uri, { mimeType: "image/png", UTI: "public.png", dialogTitle: "分享結算" });
    // Android targets can read the granted URI after the chooser has returned.
    keepForRecipient = Platform.OS === "android";
    return "closed";
  } catch {
    return presenting ? "share-failed" : "capture-failed";
  } finally {
    try {
      if (capture) releaseCapture(capture);
    } catch {
      // Do not mask the share result.
    }
    if (!keepForRecipient) remove(file);
  }
}
