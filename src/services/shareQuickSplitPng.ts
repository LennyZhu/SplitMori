import type { View } from "react-native";
import type { ComponentRef } from "react";
import { canShareLocalPng, captureLocalSharePng, presentLocalSharePng, type LocalSharePng } from "./localSharePng.ts";

export type ShareOutcome = "closed" | "unavailable" | "capture-failed" | "share-failed" | "too-large";

export async function shareQuickSplitPng(
  view: ComponentRef<typeof View>,
  isCurrent: () => boolean,
  beforePresent: () => Promise<void>,
): Promise<ShareOutcome> {
  let image: LocalSharePng | undefined;
  let presenting = false;
  try {
    if (!await canShareLocalPng()) return "unavailable";
    if (!isCurrent()) return "closed";
    image = await captureLocalSharePng(view);
    if (!isCurrent()) return "closed";
    await beforePresent();
    if (!isCurrent()) return "closed";

    presenting = true;
    await presentLocalSharePng(image, "分享結算");
    return "closed";
  } catch {
    return presenting ? "share-failed" : "capture-failed";
  } finally {
    image?.discard();
  }
}
