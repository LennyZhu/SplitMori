import { Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { QuickSplitEditorState } from "../services/quickSplitEditor.ts";
import { colors, Icon } from "./visuals.tsx";

type Mode = QuickSplitEditorState["mode"];

const modes = [
  { kind: "equal", label: "平均分攤", icon: "equalSplit" },
  { kind: "treat", label: "請客", icon: "treatSplit" },
  { kind: "individual", label: "各自消費", icon: "individualSplit" },
  { kind: "custom", label: "自訂分攤", icon: "customSplit" },
] as const;

export function SplitModeSelector({ mode, onSelect }: { mode: Mode; onSelect: (mode: Mode) => void }) {
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 370 || fontScale > 1.2;

  return (
    <View accessibilityRole="radiogroup" style={styles.choices}>
      {modes.map(({ kind, label, icon }) => {
        const selected = mode === kind;
        return (
          <Pressable
            key={kind}
            accessibilityRole="radio"
            accessibilityLabel={kind === "custom" ? `${label}，Pro` : label}
            accessibilityState={{ checked: selected }}
            onPress={() => kind === "custom"
              ? Alert.alert("自訂分攤 · Pro", "此功能需要 Pro。購買及解鎖尚未開放，你仍可繼續編輯目前的分帳。")
              : onSelect(kind)}
            style={({ pressed }) => [
              styles.mode, compact && styles.compactMode, selected && styles.activeMode, pressed && styles.pressed,
            ]}
          >
            <Icon name={icon} size={22} color={selected ? colors.onPrimary : colors.accentText} />
            <Text style={[styles.modeLabel, selected && styles.inverse]}>{label}</Text>
            <Text style={[styles.modeTier, selected && styles.inverse]}>{kind === "custom" ? "Pro" : "Free"}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  mode: {
    flexBasis: "22%", flexGrow: 1, minHeight: 76, borderWidth: 1, borderColor: colors.line, borderRadius: 11,
    paddingVertical: 8, paddingHorizontal: 3, justifyContent: "center", alignItems: "center", gap: 4,
  },
  compactMode: { flexBasis: "45%" },
  activeMode: { borderColor: colors.primary, backgroundColor: colors.primary },
  modeLabel: { color: colors.ink, fontSize: 13, fontWeight: "600", textAlign: "center" },
  modeTier: { color: colors.muted, fontSize: 12, textAlign: "center" },
  inverse: { color: colors.onPrimary },
  pressed: { opacity: 0.65 },
});
