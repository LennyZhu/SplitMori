import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getLocalDatabase } from "../data/database.ts";
import { createFinanceRepository } from "../data/finance.ts";
import type { FinancialVoidRequest, StoredFinancialVoid } from "../data/financeVoids.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import { loadActivitySettlement, type ActivitySettlementData, type RepaymentHistoryEntry } from "../services/activitySettlement.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { ConversionButton, ConversionPage, ConversionReadError, memberLabels } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";

const dateFormat = new Intl.DateTimeFormat("zh-HK", { year: "numeric", month: "long", day: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("zh-HK", { dateStyle: "medium", timeStyle: "short" });
const voidNotice = "作廢只會更正 SplitMori 帳本，不會撤回或退回現實中的轉帳。";
type Repayment = RepaymentHistoryEntry["transfer"];
type Confirmation = {
  readonly request: FinancialVoidRequest;
  readonly submittedAt?: number;
  readonly expectedSequence: number;
  readonly direction: string;
  readonly transfer: Repayment;
  readonly repaymentMinor: bigint;
  readonly outstandingMinor: bigint;
};

function formatDate(timestamp: number, includeTime = false) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "日期未能讀取" : (includeTime ? dateTimeFormat : dateFormat).format(date);
}

function voidError(code: DomainErrorCode) {
  switch (code) {
    case "EVENT_ALREADY_VOIDED": return "這筆還款已作廢。";
    case "VOID_LEDGER_CHANGED":
    case "VOID_OUT_OF_ORDER": return "帳本已更新，請核對最新記錄後重新確認。";
    case "INVALID_VOID_TARGET": return "找不到這個活動的原始還款記錄，請重新讀取。";
    case "ACTIVITY_NOT_FOUND": return "找不到這個活動。";
    case "EVENT_ID_CONFLICT": return "作廢請求與既有事件衝突，請重新確認。";
    case "VOID_LEDGER_CONFLICT":
    case "AMOUNT_OVERFLOW": return "作廢會與其他帳務記錄衝突，未能更新帳本。";
    default: return "未能作廢還款，請核對記錄後重試。";
  }
}

function StatusBadge({ voided }: { voided: boolean }) {
  return <Text style={[styles.badge, voided && styles.voidedBadge]}>{voided ? "已作廢" : "有效"}</Text>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.caption}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function OutlineButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.outline, (disabled || pressed) && styles.pressed]}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

function HistoryList({ data, nameFor, onSelect }: {
  data: ActivitySettlementData; nameFor: (id: string) => string; onSelect: (id: string) => void;
}) {
  const { activity, repaymentHistory, repaymentMinor, repayments } = data;
  return (
    <>
      <View style={styles.activityHeading}>
        <Text accessibilityRole="header" style={styles.activityName}>{activity.name}</Text>
        <Text style={styles.caption}>{activity.members.length} 位成員 · 活動{activity.status === "active" ? "進行中" : "已完成"}</Text>
      </View>
      <View style={[styles.card, styles.stack]}>
        <Text style={styles.caption}>有效還款合計</Text>
        <Text style={styles.heroAmount}>{formatResultMoney(activity.currency, repaymentMinor)}</Text>
        <Text style={styles.caption}>有效 {repayments.length} 筆 · 已作廢 {repaymentHistory.length - repayments.length} 筆</Text>
      </View>
      <View style={styles.stack}>
        <View style={styles.row}>
          <Text accessibilityRole="header" style={styles.heading}>還款歷史</Text>
          <Text style={styles.caption}>共 {repaymentHistory.length} 筆</Text>
        </View>
        {repaymentHistory.length === 0 && <View style={[styles.card, styles.stack]}>
          <Text style={styles.heading}>尚無還款記錄</Text>
          <Text style={styles.caption}>透過「記錄還款」登記的成員轉帳會顯示在這裡。</Text>
        </View>}
        {repaymentHistory.map(({ transfer, voidEvent }) => (
          <Pressable key={transfer.id} accessibilityRole="button" onPress={() => onSelect(transfer.id)}
            style={({ pressed }) => [styles.card, styles.historyItem, pressed && styles.pressed]}>
            <View style={styles.row}>
              <Text style={styles.direction}>{nameFor(transfer.fromMemberId)} → {nameFor(transfer.toMemberId)}</Text>
              <Text style={styles.amount}>{formatResultMoney(activity.currency, transfer.amountMinor)}</Text>
            </View>
            <View style={styles.recordMeta}>
              <Text style={styles.caption}>{formatDate(transfer.occurredAt)}</Text>
              <StatusBadge voided={!!voidEvent} />
            </View>
            {transfer.note && <Text numberOfLines={2} style={styles.caption}>備註：{transfer.note}</Text>}
          </Pressable>
        ))}
        {repaymentHistory.length > 0 && <View style={styles.notice}>
          <Text style={styles.caption}>點選記錄可查看詳情。作廢後原始記錄仍會保留，並標示為「已作廢」。</Text>
        </View>}
      </View>
    </>
  );
}

function RepaymentDetail({ entry, nameFor, saved }: {
  entry: RepaymentHistoryEntry; nameFor: (id: string) => string; saved: boolean;
}) {
  const { transfer, voidEvent } = entry;
  const from = nameFor(transfer.fromMemberId);
  const to = nameFor(transfer.toMemberId);
  return (
    <>
      <View style={[styles.card, styles.stack]}>
        <Text style={styles.caption}>成員實際還款</Text>
        <Text accessibilityRole="header" style={styles.heading}>{from} → {to}</Text>
        <Text style={styles.heroAmount}>{formatResultMoney(transfer.currency, transfer.amountMinor)}</Text>
      </View>
      <View style={[styles.card, styles.details]}>
        <View style={styles.detailRow}><Text style={styles.caption}>記錄狀態</Text><StatusBadge voided={!!voidEvent} /></View>
        <DetailRow label="付款人" value={from} />
        <DetailRow label="收款人" value={to} />
        <DetailRow label="轉帳日期" value={formatDate(transfer.occurredAt)} />
        {transfer.note && <DetailRow label="原始備註" value={transfer.note} />}
        {voidEvent && <DetailRow label="作廢時間" value={formatDate(voidEvent.occurredAt, true)} />}
        {voidEvent?.reason && <DetailRow label="作廢原因" value={voidEvent.reason} />}
      </View>
      <View style={styles.notice}>
        <Text style={styles.heading} accessibilityLiveRegion="polite">
          {saved ? "還款已作廢" : voidEvent ? "此筆還款已作廢" : "關於作廢"}
        </Text>
        <Text style={styles.caption}>{voidEvent ? "原始記錄仍保留，此筆還款已不計入結算。"
          : "如有誤記，請作廢後重新登記正確的還款。原始記錄會保留。"}</Text>
      </View>
    </>
  );
}

function VoidConfirmation({ confirmation, busy, error, onClose, onConfirm }: {
  confirmation: Confirmation; busy: boolean; error?: string; onClose: () => void; onConfirm: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { direction, transfer, repaymentMinor, outstandingMinor } = confirmation;
  const money = (minor: number | bigint) => formatResultMoney(transfer.currency, minor);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, {
        paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12,
        paddingLeft: insets.left + 22, paddingRight: insets.right + 22,
      }]}>
        <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.card, styles.dialog]}>
          <ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogContent}>
            <Text accessibilityRole="header" style={styles.dialogTitle}>確認作廢還款？</Text>
            <Text style={[styles.caption, styles.center]}>{voidNotice} 原始記錄仍會保留，此筆還款將不再計入結算。</Text>
            <View style={[styles.card, styles.details]}>
              <DetailRow label="還款方向" value={direction} />
              <DetailRow label="原始金額" value={money(transfer.amountMinor)} />
              <DetailRow label="轉帳日期" value={formatDate(transfer.occurredAt)} />
              {transfer.note && <DetailRow label="原始備註" value={transfer.note} />}
              <DetailRow label="作廢後有效還款" value={money(repaymentMinor)} />
              <DetailRow label="作廢後尚待結算" value={money(outstandingMinor)} />
            </View>
            {error && <Text accessibilityRole="alert" style={styles.body}>{error}</Text>}
          </ScrollView>
          <View style={styles.actions}>
            <View style={styles.action}><OutlineButton label="取消" disabled={busy} onPress={onClose} /></View>
            <View style={styles.action}>
              <ConversionButton label={busy ? "正在作廢…" : error ? "重試作廢" : "確認作廢"} disabled={busy} onPress={onConfirm} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function ActivityRepaymentHistoryScreen({ activityId, onBack, onReturnToSettlement }: {
  activityId: string; onBack: () => void; onReturnToSettlement: () => void;
}) {
  const [data, setData] = useState<ActivitySettlementData | null>();
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [operation, setOperation] = useState<"preview" | "saving">();
  const [actionError, setActionError] = useState<string>();
  const [sheetError, setSheetError] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [savedVoid, setSavedVoid] = useState<StoredFinancialVoid>();
  const latest = useRef(0);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setReadError(false);
    try {
      const next = await loadActivitySettlement(activityId);
      if (latest.current === request) setData(next);
    } catch {
      if (latest.current === request) setReadError(true);
    } finally {
      if (latest.current === request) setLoading(false);
    }
  }, [activityId]);

  useEffect(() => {
    void reload();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") void reload();
      previous = state;
    });
    return () => { latest.current += 1; subscription.remove(); };
  }, [reload]);

  const entry = data?.repaymentHistory.find(({ transfer }) => transfer.id === selectedId);
  const saved = savedVoid !== undefined && savedVoid.targetEventId === selectedId;
  const detail = entry && saved ? { ...entry, voidEvent: savedVoid } : entry;
  const names = memberLabels(data?.activity.members ?? []);
  const nameFor = (id: string) => names.get(id) ?? "未知成員";

  function back() {
    if (busy.current) return;
    setActionError(undefined);
    if (selectedId) setSelectedId(undefined);
    else if (savedVoid) onReturnToSettlement();
    else onBack();
  }

  async function previewVoid() {
    if (!detail || detail.voidEvent || busy.current || loading || readError) return;
    busy.current = true;
    setOperation("preview");
    setActionError(undefined);
    setSheetError(undefined);
    const { transfer } = detail;
    const direction = `${nameFor(transfer.fromMemberId)} → ${nameFor(transfer.toMemberId)}`;
    try {
      const request = { id: uuid.v4(), targetEventId: transfer.id, occurredAt: Date.now() };
      const repository = createFinanceRepository(await getLocalDatabase());
      const result = await repository.previewMemberTransferVoid(activityId, request);
      if (!result.ok) {
        setActionError(voidError(result.error.code));
        void reload();
        return;
      }
      const { balanceSnapshot, expectedSequence } = result.value;
      let repaymentMinor = 0n;
      let outstandingMinor = 0n;
      for (const balance of balanceSnapshot.balances) {
        repaymentMinor += BigInt(balance.transferSentMinor);
        if (balance.netBalanceMinor > 0) outstandingMinor += BigInt(balance.netBalanceMinor);
      }
      setConfirmation({ request, expectedSequence, transfer, direction, repaymentMinor, outstandingMinor });
    } catch {
      setActionError("未能讀取作廢預覽，請重試。");
    } finally {
      busy.current = false;
      setOperation(undefined);
    }
  }

  function cancelVoid() {
    if (busy.current) return;
    setConfirmation(undefined);
    setSheetError(undefined);
  }

  async function confirmVoid() {
    if (!confirmation || busy.current) return;
    busy.current = true;
    setOperation("saving");
    setSheetError(undefined);
    const submittedAt = confirmation.submittedAt ?? Date.now();
    setConfirmation({ ...confirmation, submittedAt });
    try {
      const repository = createFinanceRepository(await getLocalDatabase());
      const request = { ...confirmation.request, occurredAt: submittedAt };
      const result = await repository.voidMemberTransfer(activityId, request, confirmation.expectedSequence);
      if (!result.ok && result.error.code === "FINANCE_STORAGE_ERROR") {
        setSheetError("未能寫入作廢記錄，請重試。");
        void reload();
        return;
      }
      setConfirmation(undefined);
      if (result.ok) setSavedVoid(result.value);
      else setActionError(voidError(result.error.code));
      void reload();
    } catch {
      setSheetError("未能確認作廢結果，請重試。");
      void reload();
    } finally {
      busy.current = false;
      setOperation(undefined);
    }
  }

  const canShowList = !selectedId && data && !readError && (!savedVoid || !loading);
  return (
    <>
      <ConversionPage key={selectedId ? "detail" : "history"} title={selectedId ? "還款詳情" : "還款記錄"}
        onBack={back} busy={operation !== undefined}
        footer={detail && (saved
          ? <ConversionButton label="返回活動結算" onPress={onReturnToSettlement} />
          : !detail.voidEvent && <OutlineButton label={operation === "preview" ? "正在讀取預覽…" : "作廢此筆還款"}
            disabled={loading || readError || operation !== undefined} onPress={() => { void previewVoid(); }} />)}>
        {loading && (!data || (!selectedId && !canShowList)) && <ActivityIndicator accessibilityLabel="正在讀取還款記錄" color={colors.ink} />}
        {readError && <ConversionReadError retry={() => { void reload(); }} />}
        {actionError && <Text accessibilityRole="alert" style={styles.body}>{actionError}</Text>}
        {canShowList && <HistoryList data={data} nameFor={nameFor} onSelect={setSelectedId} />}
        {detail && <RepaymentDetail entry={detail} nameFor={nameFor} saved={saved} />}
        {!loading && data === null && <Text style={styles.caption}>找不到這個活動。</Text>}
        {!loading && !readError && selectedId && data && !detail && <Text style={styles.caption}>找不到這筆還款記錄。</Text>}
      </ConversionPage>
      {confirmation && <VoidConfirmation confirmation={confirmation} busy={operation === "saving"} error={sheetError}
        onClose={cancelVoid} onConfirm={() => { void confirmVoid(); }} />}
    </>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 14 },
  stack: { gap: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: 10, rowGap: 5 },
  activityHeading: { gap: 5, paddingTop: 3, paddingBottom: 3 },
  activityName: { color: colors.ink, fontSize: 22, fontWeight: "700" },
  heading: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  body: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  heroAmount: { color: colors.ink, fontSize: 32, fontWeight: "700", fontVariant: ["tabular-nums"] },
  amount: { color: colors.ink, fontSize: 17, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1 },
  direction: { color: colors.ink, fontSize: 17, fontWeight: "700", flexShrink: 1 },
  badge: { color: colors.ink, backgroundColor: colors.tile, borderRadius: 15, paddingHorizontal: 9, paddingVertical: 4, fontSize: 12 },
  voidedBadge: { backgroundColor: colors.quiet, color: colors.muted },
  historyItem: { gap: 5 },
  recordMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  details: { paddingVertical: 0 },
  detailRow: { minHeight: 42, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  detailValue: { color: colors.ink, fontSize: 14, fontWeight: "600", textAlign: "right", flexShrink: 1, fontVariant: ["tabular-nums"] },
  notice: { backgroundColor: colors.quiet, borderRadius: 12, padding: 12, gap: 6 },
  outline: { minHeight: 52, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
    padding: 9, alignItems: "center", justifyContent: "center" },
  buttonLabel: { color: colors.ink, fontSize: 15, fontWeight: "700", textAlign: "center" },
  pressed: { opacity: 0.6 },
  overlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(40, 40, 40, 0.42)" },
  dialog: { width: "100%", maxWidth: 415, maxHeight: "100%", alignSelf: "center", gap: 13, padding: 16 },
  dialogScroll: { flexGrow: 0, flexShrink: 1 },
  dialogContent: { gap: 11 },
  center: { textAlign: "center" },
  dialogTitle: { color: colors.ink, fontSize: 19, fontWeight: "700", textAlign: "center" },
  actions: { flexDirection: "row", alignItems: "stretch", gap: 9 },
  action: { flex: 1, justifyContent: "center" },
});
