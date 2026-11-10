import { useContext } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { QuickSplitEditorState } from "../services/quickSplitEditor.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";
import { useAdvancedSplitAction } from "./AdvancedSplitFields.tsx";
import { advancedSplitCopy } from "./advancedSplitCopy.ts";
import { colors, Icon } from "./visuals.tsx";

type Mode = QuickSplitEditorState["mode"];

const modes = [
  { kind: "equal", label: "平均分攤", icon: "equalSplit" },
  { kind: "treat", label: "請客", icon: "treatSplit" },
  { kind: "individual", label: "各自消費", icon: "individualSplit" },
  { kind: "custom", label: "自訂分攤", icon: "customSplit" },
] as const;

export function SplitModeSelector({ mode, onSelect }: { mode: Mode; onSelect: (mode: Mode) => void }) {
  const language = useContext(AppLanguageContext);
  const copy = advancedSplitCopy(language);
  const authorize = useAdvancedSplitAction();
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 370 || fontScale > 1.2;

  return (
    <View accessibilityRole="radiogroup" style={styles.choices}>
      {modes.map(({ kind, label: defaultLabel, icon }) => {
        const label = kind === "custom" ? copy.custom : defaultLabel;
        const selected = mode === kind;
        return (
          <Pressable
            key={kind}
            accessibilityRole="radio"
            accessibilityLabel={kind === "custom" ? `${label}，Pro` : label}
            accessibilityState={{ checked: selected }}
            onPress={() => {
              if (kind !== "custom") { onSelect(kind); return; }
              authorize(copy.custom, () => onSelect(kind));
            }}
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
