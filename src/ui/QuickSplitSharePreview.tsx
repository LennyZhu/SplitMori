import { useLayoutEffect, useRef, type ComponentRef } from "react";
import { ActivityIndicator, PixelRatio, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import type { QuickSplitShareCard } from "../services/quickSplitShare.ts";
import { shareQuickSplitPng, type ShareOutcome } from "../services/shareQuickSplitPng.ts";
import { colors } from "./visuals.tsx";

function ShareLine({ label, amount }: { label: string; amount: string }) {
  return (
    <View style={styles.line}>
      <Text allowFontScaling={false} style={styles.label}>{label}</Text>
      <Text allowFontScaling={false} style={styles.amount}>{amount}</Text>
    </View>
  );
}

export function QuickSplitSharePreview({ card, onFinish }: {
  card: QuickSplitShareCard; onFinish: (outcome: ShareOutcome) => void;
}) {
  const target = useRef<ComponentRef<typeof View>>(null);
  const active = useRef(false);
  const started = useRef(false);
  const frame = useRef<number>(undefined);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, []);

  function onCardLayout({ nativeEvent: { layout } }: LayoutChangeEvent) {
    if (started.current || layout.width <= 0 || layout.height <= 0) return;
    started.current = true;
    const width = PixelRatio.getPixelSizeForLayoutSize(layout.width);
    const height = PixelRatio.getPixelSizeForLayoutSize(layout.height);
    if (height > 16_384 || width * height > 20_000_000) {
      onFinish("too-large");
      return;
    }

    frame.current = requestAnimationFrame(() => {
      if (!active.current) return;
      const view = target.current;
      if (!view) {
        onFinish("capture-failed");
        return;
      }
      void shareQuickSplitPng(view, () => active.current).then((outcome) => {
        if (active.current) onFinish(outcome);
      });
    });
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.preview]} accessibilityViewIsModal>
      <View style={styles.loading}>
        <ActivityIndicator color={colors.ink} />
        <Text accessibilityLiveRegion="polite" style={styles.caption}>正在準備分享圖片…</Text>
      </View>
      <ScrollView style={styles.scroll} removeClippedSubviews={false}>
        <View ref={target} onLayout={onCardLayout} collapsable={false} style={styles.card}>
          <View style={styles.summary}>
            <Text allowFontScaling={false} style={styles.brand}>SplitMori</Text>
            <Text allowFontScaling={false} style={styles.caption}>實際帳單總額</Text>
            <Text allowFontScaling={false} style={styles.total}>{card.total}</Text>
            <Text allowFontScaling={false} style={styles.caption}>{card.mode} · {card.memberCount} 位參與成員</Text>
          </View>

          <View style={styles.section}>
            <Text allowFontScaling={false} style={styles.heading}>每人應承擔</Text>
            {card.members.map(({ id, name, amount }) => <ShareLine key={id} label={name} amount={amount} />)}
          </View>

          {card.payment && (
            <View style={styles.section}>
              <Text allowFontScaling={false} style={styles.heading}>轉帳建議</Text>
              <Text allowFontScaling={false} style={styles.caption}>商家付款人 · {card.payment.payerName}</Text>
              {card.payment.transfers.length === 0 && (
                <Text allowFontScaling={false} style={styles.caption}>此試算沒有轉帳建議。</Text>
              )}
              {card.payment.transfers.map(({ fromMemberId, toMemberId, fromName, toName, amount }) => (
                <ShareLine key={`${fromMemberId}:${toMemberId}`} label={`${fromName} → ${toName}`} amount={amount} />
              ))}
              <Text allowFontScaling={false} style={styles.caption}>轉帳建議僅供參考，並不代表實際付款。</Text>
            </View>
          )}

          <View style={styles.section}>
            {card.roundingNote && <Text allowFontScaling={false} style={styles.caption}>{card.roundingNote}</Text>}
            <Text allowFontScaling={false} style={styles.caption}>圖片生成時間 · {card.generatedAt}</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { backgroundColor: colors.page, paddingHorizontal: 14, paddingBottom: 12 },
  loading: { minHeight: 48, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  scroll: { flex: 1, width: "100%", maxWidth: 420, alignSelf: "center" },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, padding: 20, gap: 16 },
  summary: { gap: 4 },
  brand: { color: colors.ink, fontSize: 23, fontWeight: "700", marginBottom: 9 },
  total: { color: colors.ink, fontSize: 26, fontWeight: "700", fontVariant: ["tabular-nums"] },
  heading: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  section: { borderTopColor: colors.line, borderTopWidth: 1, paddingTop: 12, gap: 6 },
  line: {
    flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline",
    columnGap: 10, rowGap: 3, minHeight: 31, paddingVertical: 6,
  },
  label: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  amount: { color: colors.ink, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"], flexShrink: 1 },
});
