import type { ComponentProps } from "react";
import { StyleSheet, Text, View } from "react-native";
import { settlementPngCopy, type SettlementPngCard } from "../services/activitySettlementPng.ts";
import { colors } from "./visuals.tsx";

export const settlementReceiptWidth = 360;

function PrintText({ style, ...props }: ComponentProps<typeof Text>) {
  return <Text {...props} allowFontScaling={false} style={[styles.text, style]} />;
}

export function ActivitySettlementPngReceipt({ card }: { card: SettlementPngCard }) {
  const copy = settlementPngCopy[card.language];
  return (
    <View style={styles.paper}>
      <View style={styles.brandRow}>
        <View style={styles.wordmark}><View style={styles.dot} /><PrintText style={styles.brand}>SplitMori</PrintText></View>
        <PrintText style={styles.caption}>{copy.imageLabel} · {card.currency}</PrintText>
      </View>
      <View style={styles.activity}>
        <PrintText style={styles.kicker}>{copy.kicker}</PrintText>
        <PrintText style={styles.activityName}>{card.name}</PrintText>
        <PrintText style={styles.caption}>{card.activityDate} · {card.currencyLabel}</PrintText>
        <View style={styles.badges}>
          <PrintText style={styles.badge}>{card.activityStatus}</PrintText>
          <PrintText style={[styles.badge, card.settled && styles.darkBadge]}>{card.settlementStatus}</PrintText>
        </View>
      </View>
      <View style={styles.metrics}>
        <View style={[styles.metric, styles.hero]}>
          <PrintText style={[styles.caption, styles.onHero]}>{copy.outstanding}</PrintText>
          <PrintText style={[styles.money, styles.heroMoney, styles.onHero]}>{card.outstanding}</PrintText>
        </View>
        <View style={styles.metric}>
          <PrintText style={styles.caption}>{copy.effective}</PrintText>
          <PrintText style={[styles.money, styles.effectiveMoney]}>{card.effective}</PrintText>
        </View>
      </View>
      <View style={styles.summary}>
        <View style={styles.summaryLine}>
          <PrintText style={styles.small}>{copy.refund}</PrintText><PrintText style={styles.money}>{card.refund}</PrintText>
        </View>
        <View style={styles.summaryLine}>
          <PrintText style={styles.small}>{copy.repayment}</PrintText><PrintText style={styles.money}>{card.repayment}</PrintText>
        </View>
      </View>
      <View style={styles.section}>
        <View style={styles.headingRow}>
          <PrintText style={styles.heading}>{copy.members}</PrintText>
          <PrintText style={styles.small}>{copy.memberCount(card.members.length)}</PrintText>
        </View>
        {card.members.length === 0 && <PrintText style={styles.caption}>{copy.noMembers}</PrintText>}
        {card.members.map((member) => (
          <View key={member.id} style={[styles.listRow, styles.memberRow]}>
            <View style={styles.initial}><PrintText style={styles.small}>{member.initial}</PrintText></View>
            <PrintText style={styles.memberName}>{member.name}</PrintText>
            <View style={styles.memberAmounts}>
              <PrintText style={styles.small}>{member.direction}</PrintText>
              <PrintText style={[styles.money, styles.listMoney]}>{member.amount}</PrintText>
            </View>
          </View>
        ))}
      </View>
      <View style={styles.section}>
        <View style={styles.headingRow}>
          <PrintText style={styles.heading}>{copy.transfers}</PrintText>
          <PrintText style={styles.small}>{copy.transferCount(card.transfers.length)}</PrintText>
        </View>
        <View style={styles.transferBox}>
          {card.transfers.length === 0 && <PrintText style={styles.emptyTransfers}>{card.emptyTransfers}</PrintText>}
          {card.transfers.map((transfer, index) => (
            <View key={transfer.id} style={[styles.listRow, index > 0 && styles.memberRow]}>
              <View style={styles.transferNames}>
                <PrintText style={styles.transferName}>{transfer.from}</PrintText>
                <PrintText style={styles.caption}>→</PrintText>
                <PrintText style={styles.transferName}>{transfer.to}</PrintText>
              </View>
              <PrintText style={[styles.money, styles.listMoney]}>{transfer.amount}</PrintText>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.foot}>
        <PrintText style={styles.small}>{copy.disclaimer}</PrintText>
        <PrintText style={styles.small}>{copy.source}</PrintText>
        <View style={styles.headingRow}>
          <PrintText style={styles.small}>{copy.generated} · {card.generatedAt}</PrintText>
          <PrintText style={styles.money}>SplitMori</PrintText>
        </View>
      </View>
    </View>
  );
}

const rule = { borderColor: colors.line, borderWidth: 1 };
const between = { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 } as const;

const styles = StyleSheet.create({
  paper: { width: settlementReceiptWidth, padding: 27, backgroundColor: colors.surface },
  text: { color: colors.ink, fontSize: 10, flexShrink: 1 },
  brandRow: { ...between, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  wordmark: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.ink },
  brand: { fontSize: 14, fontWeight: "800" },
  caption: { color: colors.muted, fontSize: 8.5 },
  small: { color: colors.muted, fontSize: 7 },
  activity: { gap: 4, paddingTop: 13, paddingBottom: 13 },
  kicker: { color: colors.muted, fontSize: 7, fontWeight: "700", letterSpacing: 0.5 },
  activityName: { fontSize: 26, fontWeight: "800" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  badge: { ...rule, fontSize: 7, fontWeight: "700", paddingVertical: 3, paddingHorizontal: 6, borderRadius: 20, overflow: "hidden" },
  darkBadge: { backgroundColor: colors.ink, color: colors.surface, borderColor: colors.ink },
  metrics: { flexDirection: "row", gap: 6 },
  metric: { ...rule, flex: 1, justifyContent: "center", gap: 6, padding: 8, minHeight: 60, borderRadius: 9 },
  hero: { flex: 1.25, backgroundColor: colors.ink, borderColor: colors.ink, padding: 10 },
  onHero: { color: colors.surface },
  money: { fontSize: 8, fontWeight: "700", fontVariant: ["tabular-nums"] },
  heroMoney: { fontSize: 19 },
  effectiveMoney: { fontSize: 13 },
  summary: { flexDirection: "row", paddingVertical: 9, gap: 16, borderBottomWidth: 1, borderBottomColor: colors.line },
  summaryLine: { ...between, flex: 1, flexWrap: "wrap", gap: 3 },
  section: { paddingTop: 14 },
  headingRow: { ...between, marginBottom: 5 },
  heading: { fontWeight: "800", fontSize: 11 },
  listRow: { ...between, minHeight: 26, paddingVertical: 5 },
  memberRow: { borderTopWidth: 1, borderTopColor: colors.line },
  initial: { width: 15, height: 15, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.tile },
  memberName: { flex: 1, fontSize: 9.5, fontWeight: "700" },
  memberAmounts: { flexDirection: "row", flexWrap: "wrap", gap: 5, justifyContent: "flex-end", alignItems: "center", flexShrink: 1, maxWidth: "56%" },
  listMoney: { textAlign: "right", fontSize: 9 },
  transferBox: { ...rule, paddingHorizontal: 8, borderRadius: 8 },
  transferNames: { flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 },
  transferName: { fontSize: 9.5, fontWeight: "700", maxWidth: "100%" },
  emptyTransfers: { color: colors.muted, fontSize: 8.5, paddingVertical: 8 },
  foot: { borderTopColor: colors.line, borderTopWidth: 1, marginTop: 13, paddingTop: 9, gap: 2 },
});
