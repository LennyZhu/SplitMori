import { uuid } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { Platform, type View } from "react-native";
import type { ComponentRef } from "react";
import { captureRef, releaseCapture } from "react-native-view-shot";

export type LocalSharePng = { uri: string; discard: () => void; keepForRecipient: () => void };

function remove(entry: File | Directory | undefined) {
  try {
    if (entry?.exists) entry.delete();
  } catch {
    // Cache cleanup is best effort.
  }
}

const activeCaches = new Set<string>();

function cleanOldShares(directory: Directory) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const entry of directory.list()) {
      if (activeCaches.has(entry.uri)) continue;
      const modified = entry instanceof Directory && entry.name.startsWith("settlement-") ? entry.info().modificationTime
        : entry instanceof File && entry.name.endsWith(".png") ? entry.modificationTime : undefined;
      if (modified && modified < cutoff) remove(entry);
    }
  } catch {
    // An unreadable cache entry should not prevent sharing.
  }
}

export async function captureLocalSharePng(view: ComponentRef<typeof View>, fileName?: string): Promise<LocalSharePng> {
  let capture: string | undefined;
  let destination: File | Directory | undefined;
  let ready = false;
  let retained = false;
  try {
    capture = await captureRef(view, { format: "png", result: "tmpfile", useRenderInContext: true });
    const directory = new Directory(Paths.cache, "splitmori-share");
    directory.create({ idempotent: true, intermediates: true });
    cleanOldShares(directory);
    const folder = fileName ? new Directory(directory, `settlement-${uuid.v4()}`) : directory;
    const file = new File(folder, fileName ?? `SplitMori-${uuid.v4()}.png`);
    destination = fileName ? folder : file;
    if (fileName) folder.create();
    const uri = capture.startsWith("/") ? `file://${capture.split("/").map(encodeURIComponent).join("/")}` : capture;
    await new File(uri).copy(file, { overwrite: false });
    if (!file.exists || file.size === 0) throw new Error("Empty PNG");
    const cacheUri = destination.uri;
    activeCaches.add(cacheUri);
    ready = true;
    return {
      uri: file.uri,
      discard: () => {
        activeCaches.delete(cacheUri);
        if (!retained) remove(destination);
      },
      keepForRecipient: () => { retained = Platform.OS === "android"; },
    };
  } finally {
    try {
      if (capture) releaseCapture(capture);
    } catch {
      // Do not mask the capture result.
    }
    if (!ready) remove(destination);
  }
}

export async function presentLocalSharePng(image: LocalSharePng, dialogTitle: string) {
  await shareAsync(image.uri, { mimeType: "image/png", UTI: "public.png", dialogTitle });
  image.keepForRecipient();
}

export const canShareLocalPng = isAvailableAsync;
