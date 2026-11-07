import { Platform } from "react-native";

export async function saveSharePngToPhotos(uri: string) {
  if (Platform.OS !== "ios") return "unavailable";
  let mediaLibrary: typeof import("expo-media-library");
  try {
    mediaLibrary = await import("expo-media-library");
  } catch {
    return "unavailable";
  }
  try {
    let permission = await mediaLibrary.getPermissionsAsync(true);
    if (!permission.granted && permission.canAskAgain) permission = await mediaLibrary.requestPermissionsAsync(true);
    if (permission.status === "undetermined") return "cancelled";
    if (!permission.granted) return "denied";
    await mediaLibrary.Asset.create(uri);
    return "saved";
  } catch {
    return "failed";
  }
}
