import { useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { QuickSplitPreview } from "../services/quickSplitEditor.ts";
import { describeQuickSplitResult, formatResultMoney, type QuickSplitResultView } from "../services/quickSplitResult.ts";
import { buildQuickSplitShareCard, type QuickSplitShareCard } from "../services/quickSplitShare.ts";
import type { ShareOutcome } from "../services/shareQuickSplitPng.ts";
import { QuickSplitSharePreview } from "./QuickSplitSharePreview.tsx";
import { useQuickHistorySave } from "./useQuickHistorySave.ts";
import { colors, Icon } from "./visuals.tsx";

const shareErrors: Record<Exclude<ShareOutcome, "closed">, string> = {
  unavailable: "這部裝置暫時無法開啟系統分享。",
  "capture-failed": "未能產生分帳圖片，請重試。",
  "share-failed": "未能開啟系統分享，請重試。",
  "too-large": "分帳明細過長，超出單張 PNG 的大小上限。",
};

function AmountLine({ label, amount, strong = false }: { label: string; amount: string; strong?: boolean }) {
  return (
    <View style={styles.amountLine}>
      <Text style={[styles.lineLabel, strong && styles.emphasis]}>{label}</Text>
      <Text style={styles.amount}>{amount}</Text>
    </View>
  );
}

function Conservation({ result }: { result: QuickSplitResultView }) {
  return (
    <View style={styles.conservation}>
      <AmountLine label="分攤合計" amount={formatResultMoney(result.currency, result.allocatedMinor)} />
      <Text style={[styles.caption, !result.balanced && styles.error]}>
        {result.balanced ? "與實際帳單總額一致" : "分攤合計與實際帳單總額不一致"}
      </Text>
    </View>
  );
}

function DetailsSheet({ result, onClose }: { result: QuickSplitResultView; onClose: () => void }) {
  const [expanded, setExpanded] = useState<string>();
  const { top, bottom, left, right } = useSafeAreaInsets();
  const money = (amountMinor: number) => formatResultMoney(result.currency, amountMinor);
  return (
    <Modal visible transparent presentationStyle="overFullScreen" animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: top + 12, paddingLeft: left, paddingRight: right }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={[styles.sheet, { paddingBottom: Math.max(bottom, 12) }]}
        >
          <View style={styles.sheetHeader}>
            <Text accessibilityRole="header" style={styles.title}>分攤明細</Text>
            <Text style={styles.caption}>{result.modeLabel} · {result.currency}</Text>
          </View>
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
            <View style={[styles.card, styles.summary]}>
              <AmountLine label="實際帳單總額" amount={money(result.totalMinor)} strong />
              {result.chargeBreakdown?.map(({ label, amountMinor, deduction }) => (
                <AmountLine key={label} label={label} amount={`${deduction ? "− " : ""}${money(amountMinor)}`} />
              ))}
              <Conservation result={result} />
            </View>
            <Text accessibilityRole="header" style={styles.sectionTitle}>各成員最終承擔</Text>
            <View style={styles.card}>
              {result.members.map((member, index) => {
                const open = expanded === member.id;
                return (
                  <View key={member.id} style={index > 0 && styles.divider}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      accessibilityLabel={`${member.name}，${money(member.amountMinor)}`}
                      onPress={() => setExpanded(open ? undefined : member.id)}
                      style={({ pressed }) => [styles.detailToggle, open && styles.detailOpen, pressed && styles.pressed]}
                    >
                      <Text style={[styles.memberName, styles.detailName]}>{member.name}</Text>
                      <Text style={styles.amount}>{money(member.amountMinor)}</Text>
                      <Icon name={open ? "down" : "next"} size={16} color={colors.accentText} />
                    </Pressable>
                    {open && (
                      <View style={styles.breakdown}>
                        {member.breakdown.map(({ label, amountMinor, deduction }) => (
                          <AmountLine key={label} label={label} amount={`${deduction ? "− " : ""}${money(amountMinor)}`} />
                        ))}
                        <View style={styles.conservation}>
                          <AmountLine label="最終應承擔" amount={money(member.amountMinor)} strong />
                        </View>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
            {result.roundingNote && <Text style={styles.caption}>{result.roundingNote}</Text>}
          </ScrollView>
          <View style={styles.sheetFooter}>
            <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>關閉明細</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function QuickSplitResultScreen({ preview, onBack, onAddPayer, onConvert }: {
  preview: QuickSplitPreview; onBack: () => void; onAddPayer: () => void; onConvert: (historyId: string) => void;
}) {
  const result = useMemo(() => describeQuickSplitResult(preview), [preview]);
  const { state, save } = useQuickHistorySave(preview.input);
  const [details, setDetails] = useState(false);
  const [shareCard, setShareCard] = useState<QuickSplitShareCard>();
  const [shareError, setShareError] = useState<string>();
  const shareInProgress = useRef(false);
  const money = (amountMinor: number) => formatResultMoney(result.currency, amountMinor);
  const saving = state.status === "saving";
  const saved = state.status === "saved";
  const canSave = result.balanced && !saving && !saved;

  function startShare() {
    if (shareInProgress.current || !result.balanced) return;
    const card = buildQuickSplitShareCard(result, new Date());
    shareInProgress.current = true;
    setShareError(undefined);
    setShareCard(card);
  }

  function finishShare(outcome: ShareOutcome) {
    shareInProgress.current = false;
    setShareCard(undefined);
    setShareError(outcome === "closed" ? undefined : shareErrors[outcome]);
  }

  return (
    <View style={styles.screen}>
      <View
        style={styles.screen}
        accessibilityElementsHidden={shareCard !== undefined}
        importantForAccessibility={shareCard ? "no-hide-descendants" : "auto"}
      >
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="返回編輯" onPress={onBack} style={styles.back}>
            <Icon name="back" size={23} />
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>分帳結果</Text>
          <View style={styles.headerSpace} />
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <View style={[styles.card, styles.summary]}>
            <View style={styles.summaryHeading}>
              <Text style={styles.sectionTitle}>實際帳單總額</Text>
              <Text style={styles.badge}>{result.modeLabel}</Text>
            </View>
            <Text style={styles.total}>{money(result.totalMinor)}</Text>
            <Text style={styles.caption}>{result.members.length} 位參與成員</Text>
            <Conservation result={result} />
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeading}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>每人應承擔</Text>
              <Pressable accessibilityRole="button" onPress={() => setDetails(true)} style={styles.textButton}>
                <Text style={styles.link}>查看分攤明細</Text>
                <Icon name="next" size={14} color={colors.accentText} />
              </Pressable>
            </View>
            <View style={[styles.card, styles.rows]}>
              {result.members.map((member, index) => (
                <View key={member.id} style={[styles.memberRow, index > 0 && styles.divider]}>
                  <View style={styles.memberLabel}>
                    <Text style={styles.memberName}>{member.name}</Text>
                    {member.id === preview.input.merchantPayerId && <Text style={styles.payerLabel}>商家付款人</Text>}
                  </View>
                  <Text style={styles.amount}>{money(member.amountMinor)}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>轉帳建議</Text>
            <View style={[styles.card, styles.summary]}>
              {result.payerName === undefined ? (
                <>
                  <Text style={styles.caption}>尚未指定付款人，暫時只顯示各人分攤金額。</Text>
                  <Pressable accessibilityRole="button" onPress={onAddPayer} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                    <Text style={styles.link}>補充付款人</Text>
                    <Icon name="next" size={14} color={colors.accentText} />
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.caption}>商家付款人 · {result.payerName}</Text>
                  {result.suggestions.length === 0
                    ? <Text style={styles.lineLabel}>此試算沒有轉帳建議。</Text>
                    : result.suggestions.map((suggestion, index) => (
                      <View key={`${suggestion.fromMemberId}:${suggestion.toMemberId}`} style={[styles.transfer, index > 0 && styles.divider]}>
                        <AmountLine label={`${suggestion.fromName} → ${suggestion.toName}`} amount={money(suggestion.amountMinor)} />
                      </View>
                    ))}
                  <Text style={styles.caption}>僅供參考，尚未記錄任何實際還款。</Text>
                </>
              )}
            </View>
          </View>
        </ScrollView>
        <View style={styles.footer}>
          <View style={styles.footerInner}>
            {shareError && <Text accessibilityRole="alert" style={styles.error}>{shareError}</Text>}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !result.balanced || !!shareCard, busy: !!shareCard }}
              disabled={!result.balanced || !!shareCard}
              onPress={startShare}
              style={({ pressed }) => [styles.primary, (pressed || !result.balanced) && styles.pressed]}
            >
              <Text style={styles.primaryText}>分享結算</Text>
            </Pressable>
            {saved && <Text accessibilityLiveRegion="polite" style={styles.caption}>已儲存至快速分帳記錄。</Text>}
            {state.status === "error" && (
              <Text accessibilityRole="alert" style={styles.error}>
                {state.code === "QUICK_STORAGE_ERROR" ? "未能寫入本機記錄，請重試。" : `未能儲存計算記錄（${state.code}）。`}
              </Text>
            )}
            <View style={styles.resultActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSave, busy: saving }}
                disabled={!canSave}
                onPress={save}
                style={({ pressed }) => [styles.saveButton, styles.actionCell, (pressed || !canSave) && styles.pressed]}
              >
                <Text style={styles.saveText}>{saving ? "正在儲存…" : saved ? "已儲存計算記錄" : "儲存計算記錄"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={saving || !!shareCard || !result.balanced}
                onPress={() => state.status === "saved" ? onConvert(state.historyId)
                  : Alert.alert("請先儲存計算記錄", "儲存後即可選擇活動，再確認成員及實際付款人。")}
                style={({ pressed }) => [styles.saveButton, styles.actionCell, (pressed || saving || !result.balanced) && styles.pressed]}>
                <Text style={styles.saveText}>加入活動</Text>
              </Pressable>
            </View>
          </View>
        </View>
        {details && <DetailsSheet result={result} onClose={() => setDetails(false)} />}
      </View>
      {shareCard && <QuickSplitSharePreview card={shareCard} onFinish={finishShare} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  header: {
    width: "100%", maxWidth: 620, minHeight: 55, alignSelf: "center", flexDirection: "row",
    alignItems: "center", paddingHorizontal: 12, gap: 8,
  },
  back: { flex: 1, minHeight: 44, alignItems: "flex-start", justifyContent: "center", paddingLeft: 4 },
  headerSpace: { flex: 1 },
  title: { color: colors.ink, fontSize: 19, fontWeight: "700", textAlign: "center" },
  scroll: { flex: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 8, paddingBottom: 20, gap: 17 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 15 },
  summary: { padding: 15, gap: 8 },
  summaryHeading: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: "700", flexShrink: 1 },
  badge: { color: colors.accentText, backgroundColor: colors.quiet, borderRadius: 12, paddingVertical: 4, paddingHorizontal: 9, fontSize: 13 },
  total: { color: colors.ink, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
  caption: { color: colors.muted, fontSize: 14 },
  conservation: { gap: 3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: 8 },
  section: { gap: 8 },
  sectionHeading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" },
  textButton: { minHeight: 44, alignItems: "center", flexDirection: "row", gap: 3 },
  link: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  rows: { paddingHorizontal: 14 },
  memberRow: { minHeight: 49, paddingVertical: 9, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 },
  memberLabel: { flexShrink: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  memberName: { color: colors.ink, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  payerLabel: { color: colors.accentText, fontSize: 12 },
  amountLine: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: 12, rowGap: 4 },
  lineLabel: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  emphasis: { fontWeight: "700" },
  amount: { color: colors.ink, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"], flexShrink: 1 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  transfer: { paddingVertical: 7 },
  secondary: {
    minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10,
    borderWidth: 1, borderColor: colors.line, borderRadius: 10,
  },
  footer: { paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.line },
  footerInner: { width: "100%", maxWidth: 584, alignSelf: "center", gap: 6 },
  primary: {
    minHeight: 51, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.primary,
  },
  primaryText: { color: colors.onPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
  saveButton: {
    minHeight: 45, borderRadius: 12, borderWidth: 1, borderColor: colors.line,
    paddingHorizontal: 12, paddingVertical: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface,
  },
  saveText: { color: colors.ink, fontSize: 15, fontWeight: "600", textAlign: "center" },
  resultActions: { flexDirection: "row", gap: 6 },
  actionCell: { flex: 1 },
  pressed: { opacity: 0.65 },
  error: { color: "#9A372B", fontSize: 14 },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(40, 40, 40, 0.35)" },
  sheet: {
    width: "100%", height: "87%", maxWidth: 620, alignSelf: "center",
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderBottomWidth: 0,
    borderColor: colors.line, backgroundColor: colors.page,
  },
  sheetHeader: { paddingHorizontal: 18, paddingTop: 17, paddingBottom: 12, gap: 4, alignItems: "flex-start" },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingHorizontal: 18, paddingBottom: 18, gap: 12 },
  sheetFooter: { paddingTop: 10, paddingHorizontal: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  detailToggle: {
    flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 9, paddingHorizontal: 12, paddingVertical: 9, minHeight: 48,
  },
  detailOpen: { backgroundColor: colors.quiet },
  detailName: { flexGrow: 1 },
  breakdown: { padding: 12, gap: 8 },
});
