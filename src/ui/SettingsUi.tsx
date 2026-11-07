import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ConversionPage } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon, type IconName } from "./visuals.tsx";

export function SettingsPage({ title, backLabel, onBack, busy = false, busyLabel, footer, children }: {
  title: string; backLabel: string; onBack: () => void; busy?: boolean; busyLabel?: string; footer?: ReactNode; children: ReactNode;
}) {
  const progress = busy && <View style={styles.progress} accessibilityLiveRegion="polite">
    <ActivityIndicator color={colors.ink} /><Text style={styles.caption}>{busyLabel}</Text>
  </View>;
  return (
    <ConversionPage title={title} backLabel={backLabel} onBack={onBack} busy={busy}
      footer={footer && <View style={styles.controls}>{progress}{footer}</View>}>
      <View style={styles.stack}>
        {children}
        {!footer && progress}
      </View>
    </ConversionPage>
  );
}

export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return <View style={styles.group}>
    {title && <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>}
    <View style={styles.card}>{children}</View>
  </View>;
}

export function SettingsRow({ title, detail, icon, onPress, divider, selected, disabled, compact = false, horizontal = false }: {
  title: string; detail?: string; icon?: IconName; onPress?: () => void; divider?: boolean;
  selected?: boolean; disabled?: boolean; compact?: boolean; horizontal?: boolean;
}) {
  const children = <>
    {icon && <View style={styles.icon}><Icon name={icon} size={20} color={disabled ? colors.muted : colors.ink} /></View>}
    <View style={[styles.copy, horizontal && styles.inline]}>
      <Text style={[styles.rowTitle, disabled && styles.caption]}>{title}</Text>
      {detail && <Text style={[styles.caption, horizontal && styles.horizontalDetail]}>{detail}</Text>}
    </View>
    {selected !== undefined ? <View style={[styles.radio, selected && styles.checked]}>
      {selected && <Icon name="check" size={15} color={colors.onPrimary} />}
    </View> : (onPress || disabled) ? <Icon name="next" size={15} color={colors.muted} /> : null}
  </>;
  const frame = [styles.row, divider && styles.divider, compact && styles.compact];
  return onPress || disabled
    ? <Pressable accessibilityRole={selected === undefined ? "button" : "radio"} accessibilityState={{ disabled, checked: selected }}
      disabled={disabled} onPress={onPress} style={({ pressed }) => [...frame, pressed && styles.pressed]}>{children}</Pressable>
    : <View style={frame}>{children}</View>;
}

export function SettingsValue({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return <View style={[styles.valueRow, divider && styles.divider]}>
    <Text style={styles.caption}>{label}</Text><Text style={styles.value}>{value}</Text>
  </View>;
}

export function SettingsNote({ children, title, alert = false }: { children: ReactNode; title?: string; alert?: boolean }) {
  return <View style={[styles.note, title && styles.warning]} accessibilityRole={alert ? "alert" : undefined}>
    {title && <View style={styles.inline}><Icon name="warning" size={21} /><Text style={styles.rowTitle}>{title}</Text></View>}
    <Text style={styles.body}>{children}</Text>
  </View>;
}

export const settingsStyles = StyleSheet.create({
  stack: { gap: 16, paddingTop: 14 },
  group: { gap: 10 },
  groupTitle: { color: colors.muted, fontSize: 13, fontWeight: "700", paddingHorizontal: 4 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 18, paddingHorizontal: 15 },
  padded: { padding: 17, gap: 9 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 68, gap: 12, paddingVertical: 11 },
  compact: { minHeight: 56 },
  copy: { flex: 1, gap: 4 },
  rowTitle: { color: colors.ink, fontSize: 16, fontWeight: "700", flexShrink: 1 },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 21, flexShrink: 1 },
  horizontalDetail: { paddingLeft: 6 },
  icon: { width: 35, height: 35, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.quiet },
  divider: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: 0.6 },
  radio: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", borderColor: colors.muted, borderWidth: 1 },
  checked: { backgroundColor: colors.primary, borderColor: colors.primary },
  valueRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 45, paddingVertical: 9 },
  value: { color: colors.ink, fontSize: 14, fontWeight: "700", flexShrink: 1, textAlign: "right" },
  note: { backgroundColor: colors.quiet, borderRadius: 14, padding: 14, gap: 8 },
  warning: { borderColor: colors.line, borderWidth: 1, backgroundColor: colors.surface },
  controls: { gap: 8 },
  progress: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  inline: { flexDirection: "row", alignItems: "center", gap: 8 },
  headline: { color: colors.ink, fontSize: 21, fontWeight: "800" },
  brandMark: { width: 48, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  brandLetter: { color: colors.onPrimary, fontSize: 27, fontWeight: "800" },
});
const styles = settingsStyles;
