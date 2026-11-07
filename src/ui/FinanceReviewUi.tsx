import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ConversionButton } from "./QuickSplitConversionScreen.tsx";
import { colors } from "./visuals.tsx";

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" style={styles.heading}>{children}</Text>;
}

export function Notice({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return <View style={styles.notice}><Text accessibilityRole={alert ? "alert" : undefined} style={styles.caption}>{children}</Text></View>;
}

export function Row({ title, value, divider = true }: { title: string; value: string; divider?: boolean }) {
  return (
    <View style={[styles.row, styles.line, divider && styles.divider]}>
      <Text style={styles.caption}>{title}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

export function Compare({ title, before, after, inline = false }: { title: string; before: string; after: string; inline?: boolean }) {
  return (
    <View style={[styles.line, styles.divider, inline && styles.inline]}>
      <Text style={[styles.compareLabel, inline && styles.inlineLabel]}>{title}</Text>
      <View style={[styles.compareValues, inline && styles.inlineValues]}>
        <Text style={styles.oldValue}>{before}</Text><Text style={styles.caption}>→</Text><Text style={styles.value}>{after}</Text>
      </View>
    </View>
  );
}

export function ButtonPair({ secondary, primary }: {
  secondary: { label: string; action: () => void; disabled?: boolean };
  primary: { label: string; action: () => void; disabled?: boolean };
}) {
  return (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: secondary.disabled }}
        disabled={secondary.disabled} onPress={secondary.action}
        style={({ pressed }) => [styles.secondary, (pressed || secondary.disabled) && styles.dimmed]}>
        <Text style={styles.buttonText}>{secondary.label}</Text>
      </Pressable>
      <View style={styles.primary}>
        <ConversionButton label={primary.label} onPress={primary.action} disabled={primary.disabled} />
      </View>
    </View>
  );
}

export const financeReviewStyles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 11, gap: 4 },
  notice: { backgroundColor: colors.quiet, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700", marginTop: 4 },
  total: { color: colors.ink, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"], marginVertical: 3 },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  badge: { color: colors.muted, backgroundColor: colors.quiet, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: 10, rowGap: 3 },
  line: { paddingVertical: 8, gap: 4 },
  divider: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  value: { color: colors.ink, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" },
  compareLabel: { color: colors.ink, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  inline: { flexDirection: "row", alignItems: "center", gap: 7 },
  inlineLabel: { flexBasis: "25%" },
  inlineValues: { flex: 1 },
  compareValues: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  oldValue: { color: colors.muted, fontSize: 14, fontVariant: ["tabular-nums"], flex: 1 },
  compareHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 6 },
  compareBox: { flex: 1, gap: 4, backgroundColor: colors.quiet, borderRadius: 12, padding: 10 },
  boxAmount: { color: colors.ink, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", gap: 8 },
  primary: { flex: 1 },
  secondary: { flex: 0.82, minHeight: 52, padding: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.ink, fontSize: 16, fontWeight: "700", textAlign: "center" },
  dimmed: { opacity: 0.65 },
});

const styles = financeReviewStyles;
