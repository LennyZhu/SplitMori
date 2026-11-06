import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ActivityCreationBlocker } from "../data/activities.ts";
import { colors } from "./visuals.tsx";

export function ActivityQuotaSheet({ blocker, onView, onClose, purpose = "create" }: {
  blocker: ActivityCreationBlocker; onView: () => void; onClose: () => void; purpose?: "create" | "reopen";
}) {
  const { top, bottom, left, right } = useSafeAreaInsets();
  return (
    <Modal visible transparent presentationStyle="overFullScreen" animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: top + 12, paddingLeft: left, paddingRight: right }]}>
        <Pressable onPress={onClose} style={StyleSheet.absoluteFill} accessible={false} />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={[styles.sheet, { paddingBottom: Math.max(bottom, 16) }]}
        >
          <View style={styles.handle} />
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.mark}><Text style={styles.markText}>!</Text></View>
            <Text accessibilityRole="header" style={styles.title}>
              {purpose === "reopen" ? "暫時無法重新開啟" : "已有進行中的活動"}
            </Text>
            <Text style={styles.copy}>
              免費版同時只可有 <Text style={styles.strong}>1 個進行中的活動</Text>。
              {purpose === "reopen"
                ? `請先完成「${blocker.name}」，再重新開啟這個活動。記錄還款毋須重新開啟。`
                : `你可以繼續使用「${blocker.name}」，或先將現有活動標記完成後再建立新活動。`}
            </Text>
            <Pressable accessibilityRole="button" onPress={onView} style={({ pressed }) => [styles.button, styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>查看現有活動</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>稍後再說</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(40, 40, 40, 0.32)" },
  sheet: {
    width: "100%", maxWidth: 620, maxHeight: "100%", flexShrink: 1, alignSelf: "center", backgroundColor: colors.surface,
    borderTopLeftRadius: 27, borderTopRightRadius: 27, paddingTop: 10,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { paddingHorizontal: 21, paddingVertical: 10, gap: 11 },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 4, backgroundColor: colors.line, marginBottom: 9 },
  mark: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
  markText: { color: colors.ink, fontSize: 24 },
  title: { color: colors.ink, fontSize: 21, fontWeight: "700" },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 23, marginBottom: 8 },
  strong: { color: colors.ink, fontWeight: "700" },
  button: { minHeight: 48, borderRadius: 13, padding: 10, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  primaryText: { color: colors.onPrimary, fontSize: 16, fontWeight: "700" },
  secondaryText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  pressed: { opacity: 0.65 },
});
