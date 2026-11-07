import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from "react";
import {
  ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createActivityRepository, type ActivityMember } from "../data/activities.ts";
import { getLocalDatabase } from "../data/database.ts";
import type { QuickHistoryRecord } from "../data/quickSplits.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import {
  canSelectConversionTarget, createQuickSplitConversionService, projectQuickConversion, type ConversionDestination,
  type ConversionTarget, type MemberMapping,
} from "../services/quickSplitConversion.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { colors, Icon } from "./visuals.tsx";

const modeLabels = { equal: "平均分攤", treat: "請客", individual: "各自消費", custom: "自訂分攤" } as const;

export function useConversionRead<T>(read: () => Promise<T>) {
  const [state, setState] = useState<{ status: "loading" | "error" } | { status: "loaded"; value: T }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void read().then(
      (value) => { if (current) setState({ status: "loaded", value }); },
      () => { if (current) setState({ status: "error" }); },
    );
    return () => { current = false; };
  }, [read, attempt]);
  return { state, retry: () => setAttempt((value) => value + 1) };
}

export function QuickRecordSummary({ history, target, destination }: {
  history: QuickHistoryRecord; target?: Pick<ConversionTarget, "name" | "currency">; destination?: ConversionDestination | null;
}) {
  const { total } = history.snapshot.split;
  const mode = modeLabels[history.input.method.kind];
  const count = history.input.members.length;
  return (
    <View style={[styles.card, styles.summary]}>
      <Text style={styles.caption}>{target ? "來源快速記錄" : "來源 · 已儲存的快速分帳記錄"}</Text>
      <View style={styles.amountRow}>
        <Text style={[styles.summaryAmount, target && styles.confirmAmount]}>{formatResultMoney(total.currency, total.amountMinor)}</Text>
        {target && <Text style={styles.caption}>{mode} · {count} 人</Text>}
      </View>
      <Text style={styles.caption}>{target ? `目標活動：${target.name} · ${target.currency}`
        : `${mode} · ${count} 位成員 · ${destination ? `已加入活動「${destination.activityName}」` : "尚未加入活動"}`}</Text>
    </View>
  );
}

export function ConversionPage({ title, endLabel, endAction, onBack, children, footer, scrollRef, busy = false }: {
  title: string; endLabel?: string; onBack: () => void; children: ReactNode; footer?: ReactNode;
  endAction?: { label: string; onPress: () => void };
  scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>; busy?: boolean;
}) {
  const { top } = useSafeAreaInsets();
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={top}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" disabled={busy} onPress={onBack} style={styles.headerSide}>
          <Icon name="back" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        {endAction ? (
          <Pressable accessibilityRole="button" accessibilityLabel={endAction.label} disabled={busy}
            onPress={endAction.onPress} style={[styles.headerSide, styles.headerEnd]}>
            <Icon name="more" size={23} />
          </Pressable>
        ) : endLabel ? (
          <Pressable accessibilityRole="button" disabled={busy} onPress={onBack} style={[styles.headerSide, styles.headerEnd]}>
            <Text style={styles.body}>{endLabel}</Text>
          </Pressable>
        ) : <View style={styles.headerSide} />}
      </View>
      <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" pointerEvents={busy ? "none" : "auto"}>
        {children}
      </ScrollView>
      {footer && <View style={styles.footer}><View style={styles.footerInner}>{footer}</View></View>}
    </KeyboardAvoidingView>
  );
}

export function ConversionButton({ label, onPress, disabled = false }: {
  label: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.primary, (pressed || disabled) && styles.dimmed]}>
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

export function ConversionReadError({ retry }: { retry: () => void }) {
  return <View style={styles.card}>
    <Text accessibilityRole="alert" style={styles.body}>未能讀取本機資料，請重試。</Text>
    <Pressable accessibilityRole="button" onPress={retry} style={styles.retry}><Text style={styles.label}>重新讀取</Text></Pressable>
  </View>;
}

function ActivityOption({ item, history, selected, onPress }: {
  item: ConversionTarget; history: QuickHistoryRecord; selected: boolean; onPress: () => void;
}) {
  const enabled = canSelectConversionTarget(item, history);
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: !enabled }}
      disabled={!enabled} onPress={onPress}
      style={({ pressed }) => [styles.card, styles.activityOption, selected && styles.selected, (!enabled || pressed) && styles.dimmed]}>
      <View style={styles.fill}>
        <View style={styles.activityTitle}>
          <Text style={styles.heading}>{item.name}</Text>
          <Text style={[styles.caption, styles.badge]}>{item.status === "active" ? "進行中" : "已完成"}</Text>
        </View>
        <Text style={styles.caption}>{item.currency} · {item.status === "completed" ? "需重新開啟才能加入"
          : !enabled ? `目前 ${item.memberCount} 位成員，未足夠一對一對應`
            : `${item.memberCount} 位成員 · 目前 ${item.expenseCount} 筆費用`}</Text>
      </View>
      <View style={[styles.radio, selected && styles.checked]}>
        {selected && <Icon name="check" size={14} color={colors.onPrimary} />}
      </View>
    </Pressable>
  );
}

export function QuickSplitConversionScreen({ historyId, onBack, onJoined }: {
  historyId: string; onBack: () => void; onJoined: (activityId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [confirmId, setConfirmId] = useState<string>();
  const read = useCallback(async () => {
    const service = createQuickSplitConversionService(await getLocalDatabase());
    const source = await service.getSource(historyId);
    const targets = source && !source.destination ? await service.listTargets(source.history.snapshot.split.total.currency) : [];
    return { source, targets };
  }, [historyId]);
  const { state, retry } = useConversionRead(read);
  const source = state.status === "loaded" ? state.value.source : undefined;
  const targets = state.status === "loaded" ? state.value.targets : [];
  const eligible = source ? targets.filter((row) => canSelectConversionTarget(row, source.history)) : [];
  const selected = eligible.find(({ id }) => id === selectedId) ?? (eligible.length === 1 ? eligible[0] : undefined);
  const destination = source?.destination;

  if (confirmId && source && !destination) {
    return <ConfirmConversion key={confirmId} history={source.history} activityId={confirmId} onJoined={onJoined}
      onBack={() => { setConfirmId(undefined); retry(); }} />;
  }

  return (
    <ConversionPage title="選擇活動" endLabel="取消" onBack={onBack}
      footer={source && (destination
        ? <ConversionButton label="查看活動" onPress={() => onJoined(destination.activityId)} />
        : <ConversionButton label="下一步 · 確認加入" disabled={!selected} onPress={() => selected && setConfirmId(selected.id)} />)}>
      {state.status === "loading" && <ActivityIndicator accessibilityLabel="正在讀取活動" color={colors.ink} />}
      {state.status === "error" && <ConversionReadError retry={retry} />}
      {source === null && <Text style={styles.body}>找不到這筆已儲存的快速記錄。</Text>}
      {source && <QuickRecordSummary history={source.history} destination={destination} />}
      {source && !destination && (
        <>
          <View style={styles.intro}>
            <Text accessibilityRole="header" style={styles.heading}>加入哪個活動？</Text>
            <Text style={styles.caption}>只可加入同幣種、進行中的活動。</Text>
          </View>
          {eligible.length === 0 && <View style={styles.card}>
            <Text style={styles.label}>暫無可加入的活動</Text>
            <Text style={styles.caption}>請先在「活動」開啟同幣種且有足夠成員的活動，再返回這筆記錄。</Text>
          </View>}
          <View accessibilityRole="radiogroup" style={styles.options}>
            {targets.map((item) => <ActivityOption key={item.id} item={item} history={source.history}
              selected={item.id === selected?.id} onPress={() => setSelectedId(item.id)} />)}
          </View>
          <View style={styles.createNotice}>
            <Icon name="plus" size={15} color={colors.muted} />
            <Text style={[styles.body, styles.fill]}>建立新活動</Text>
            <Text style={styles.caption}>此流程僅支援已有活動</Text>
          </View>
          <Text style={styles.caption}>其他幣種的活動不會出現在清單。此流程會新增一筆正式費用，原分攤結果會保留。</Text>
        </>
      )}
    </ConversionPage>
  );
}

function PickerField({ label, value, onPress, compact = false }: {
  label: string; value: string; onPress: () => void; compact?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}，${value}`} onPress={onPress}
      style={[styles.input, styles.picker, compact && styles.compactField]}>
      <Text style={[styles.body, styles.fill]}>{value}</Text>
      <Icon name="down" size={15} color={colors.muted} />
    </Pressable>
  );
}

export function MemberPicker({ title, members, labels, selected, onSelect, onClose, onClear,
  emptyText = "目前沒有可選成員，請先清除其他對應。" }: {
  title: string; members: readonly ActivityMember[]; selected?: string; onSelect: (id: string) => void;
  labels: ReadonlyMap<string, string>;
  onClose: () => void; onClear?: () => void; emptyText?: string;
}) {
  const { top, bottom, left, right } = useSafeAreaInsets();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: top + 12, paddingLeft: left, paddingRight: right }]}>
        <Pressable onPress={onClose} style={StyleSheet.absoluteFill} accessible={false} />
        <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.sheet, { paddingBottom: Math.max(14, bottom) }]}>
          <View style={styles.amountRow}>
            <Text accessibilityRole="header" style={[styles.heading, styles.fill]}>{title}</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.retry}><Text style={styles.body}>取消</Text></Pressable>
          </View>
          <ScrollView style={styles.pickerScroll}>
            {members.map(({ id, displayName }) => (
              <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: id === selected }}
                onPress={() => onSelect(id)} style={styles.memberChoice}>
                <Text style={[styles.body, styles.fill]}>{labels.get(id) ?? displayName}</Text>
                {id === selected && <Icon name="check" size={17} />}
              </Pressable>
            ))}
            {members.length === 0 && <Text style={styles.caption}>{emptyText}</Text>}
            {onClear && <Pressable accessibilityRole="button" onPress={onClear} style={styles.retry}><Text style={styles.label}>清除對應</Text></Pressable>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function conversionError(code: DomainErrorCode): string {
  switch (code) {
    case "ACTIVITY_COMPLETED": return "活動已完成，請返回選擇其他活動。";
    case "ACTIVITY_NOT_FOUND": return "找不到目標活動，請返回重新選擇。";
    case "CURRENCY_MISMATCH": return "幣種不一致，請返回重新選擇活動。";
    case "QUICK_HISTORY_NOT_FOUND": return "找不到來源記錄，請返回重新讀取。";
    case "QUICK_HISTORY_ALREADY_CONVERTED": return "這筆記錄已加入活動，請返回查看。";
    case "CONVERSION_REQUEST_CONFLICT": return "此請求已有不同的入帳資料，請返回核對記錄狀態。";
    case "INVALID_MEMBER_MAPPING": return "請確認每位來源成員各自對應一位不同的活動成員。";
    case "MISSING_MERCHANT_PAYMENT":
    case "MEMBER_NOT_PARTICIPATING": return "請選擇一位有效的活動成員作為實際付款人。";
    case "INVALID_EXPENSE_NAME": return "請輸入費用名稱。";
    case "TOTAL_MISMATCH":
    case "INVALID_SPLIT_SNAPSHOT": return "來源快照的分攤金額無法核對，未能加入活動。";
    case "AMOUNT_OVERFLOW": return "入帳後的金額超出上限。";
    default: return "未能加入活動，請核對資料後再試。";
  }
}

type Picker = { kind: "payer" } | { kind: "mapping"; sourceId: string };

export function memberLabels(members: readonly { id: string; displayName: string }[]) {
  const counts = new Map<string, number>();
  for (const { displayName } of members) counts.set(displayName, (counts.get(displayName) ?? 0) + 1);
  return new Map(members.map(({ id, displayName }, index) => [
    id, counts.get(displayName) === 1 ? displayName : `${displayName}（成員 ${index + 1}）`,
  ]));
}

function ConfirmConversion({ history, activityId, onBack, onJoined }: {
  history: QuickHistoryRecord; activityId: string; onBack: () => void; onJoined: (id: string) => void;
}) {
  const read = useCallback(async () => createActivityRepository(await getLocalDatabase()).getActivity(activityId), [activityId]);
  const { state, retry } = useConversionRead(read);
  const activity = state.status === "loaded" ? state.value : undefined;
  const [name, setName] = useState("");
  const [payerId, setPayerId] = useState<string>();
  const [mapping, setMapping] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [picker, setPicker] = useState<Picker>();
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<DomainErrorCode>();
  const pending = useRef(false);
  const attempt = useRef<{ requestId: string; occurredAt: number } | undefined>(undefined);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsets = useRef({ name: 0, payer: 0, mapping: 0 });
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const back = useCallback(() => {
    if (pending.current) return;
    Keyboard.dismiss();
    onBack();
  }, [onBack]);
  const revealInput = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput();
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, 74, true);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const sub = Keyboard.addListener("keyboardDidShow", revealInput);
    return () => sub.remove();
  }, [revealInput]);

  const { total, allocations } = history.snapshot.split;
  const members = activity?.members ?? [];
  const names = memberLabels(members);
  const sourceNames = memberLabels(history.input.members);
  const memberMapping: MemberMapping[] = Array.from(mapping, ([quickMemberId, activityMemberId]) => ({ quickMemberId, activityMemberId }));
  const preview = activity && projectQuickConversion(history, activity, memberMapping);
  const available = activity?.status === "active" && activity.currency === total.currency
    && members.length >= history.input.members.length;
  const originShares = new Map(allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  const targetShares = new Map(preview?.ok ? preview.value.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]) : []);
  const money = (minor: number) => formatResultMoney(total.currency, minor);
  const assignedId = picker?.kind === "mapping" ? mapping.get(picker.sourceId) : payerId;
  const otherAssignments = new Set(mapping.values());
  const options = picker?.kind === "mapping"
    ? members.filter(({ id }) => id === assignedId || !otherAssignments.has(id)) : members;

  function changeMapping(sourceId: string, targetId?: string) {
    setMapping((previous) => {
      const next = new Map(previous);
      if (targetId === undefined) next.delete(sourceId);
      else next.set(sourceId, targetId);
      return next;
    });
    setError(undefined);
    setPicker(undefined);
  }

  function openPicker(next: Picker) {
    Keyboard.dismiss();
    setPicker(next);
  }

  async function submit() {
    if (!available || pending.current) return;
    Keyboard.dismiss();
    setAttempted(true);
    setError(undefined);
    if (!name.trim() || !payerId || !names.has(payerId) || !preview?.ok) {
      const section = !name.trim() ? "name" : !payerId || !names.has(payerId) ? "payer" : "mapping";
      scroll.current?.scrollTo({ y: Math.max(0, offsets.current[section] - 8), animated: true });
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      attempt.current ??= { requestId: uuid.v4(), occurredAt: Date.now() };
      const service = createQuickSplitConversionService(await getLocalDatabase());
      const result = await service.convertQuickHistory({
        ...attempt.current, historyId: history.id, activityId, expenseName: name, memberMapping,
        merchantPayment: { memberId: payerId, ...preview.value.total },
      });
      if (!mounted.current) return;
      if (result.ok) onJoined(result.value.activityId);
      else setError(result.error.code);
    } catch {
      if (mounted.current) setError("QUICK_CONVERSION_STORAGE_ERROR");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <>
      <ConversionPage title="確認加入活動" endLabel="返回" onBack={back} busy={saving} scrollRef={scroll}
        footer={<>
          {error && <Text accessibilityRole="alert" style={styles.error}>{conversionError(error)}</Text>}
          <ConversionButton label={saving ? "正在加入…" : "確認加入活動"} disabled={!available || saving} onPress={() => { void submit(); }} />
        </>}>
        {state.status === "loading" && <ActivityIndicator accessibilityLabel="正在讀取活動" color={colors.ink} />}
        {state.status === "error" && <ConversionReadError retry={retry} />}
        {activity === null && <Text style={styles.body}>{conversionError("ACTIVITY_NOT_FOUND")}</Text>}
        {activity && <QuickRecordSummary history={history} target={activity} />}
        {activity && !available && <Text style={styles.body}>{activity.status !== "active" ? conversionError("ACTIVITY_COMPLETED")
          : activity.currency !== total.currency ? conversionError("CURRENCY_MISMATCH") : "活動成員不足，無法完成一對一對應。"}</Text>}
        {available && (
          <>
            <View style={styles.field} onLayout={({ nativeEvent }) => { offsets.current.name = nativeEvent.layout.y; }}>
              <Text style={styles.label}>費用名稱 *</Text>
              <TextInput accessibilityLabel="費用名稱" placeholder="輸入費用名稱" placeholderTextColor={colors.muted}
                value={name} onChangeText={(value) => { setName(value); setError(undefined); }} editable={!saving}
                onFocus={() => { if (Platform.OS === "ios" && Keyboard.isVisible()) requestAnimationFrame(revealInput); }} style={styles.input} />
              {attempted && !name.trim() && <Text accessibilityRole="alert" style={styles.error}>請輸入費用名稱。</Text>}
            </View>
            <View style={styles.field} onLayout={({ nativeEvent }) => { offsets.current.payer = nativeEvent.layout.y; }}>
              <Text style={styles.label}>實際商家付款人 *</Text>
              <PickerField label="實際商家付款人" value={names.get(payerId ?? "") ?? "選擇實際付款人"} onPress={() => openPicker({ kind: "payer" })} />
              {attempted && !names.has(payerId ?? "") && <Text accessibilityRole="alert" style={styles.error}>請選擇實際付款人。</Text>}
            </View>
            <View style={styles.card} onLayout={({ nativeEvent }) => { offsets.current.mapping = nativeEvent.layout.y; }}>
              <Text accessibilityRole="header" style={styles.label}>成員對應</Text>
              <Text style={styles.caption}>將快速記錄的成員對應至活動成員，原分攤金額及尾差會保留。</Text>
              {history.input.members.map(({ id }) => (
                <View key={id} style={styles.mappingRow}>
                  <View style={[styles.input, styles.compactField, styles.originalMember]}>
                    <Text style={styles.body}>{sourceNames.get(id)}</Text>
                  </View>
                  <Text accessible={false} style={styles.arrow}>→</Text>
                  <PickerField compact label={`${sourceNames.get(id)}對應的活動成員`}
                    value={names.get(mapping.get(id) ?? "") ?? "選擇成員"} onPress={() => openPicker({ kind: "mapping", sourceId: id })} />
                </View>
              ))}
              {attempted && preview?.ok === false && <Text accessibilityRole="alert" style={styles.error}>{conversionError(preview.error.code)}</Text>}
            </View>
            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.label}>轉入後的分攤</Text>
              {history.input.members.map(({ id }) => {
                const targetId = mapping.get(id);
                const label = names.get(targetId ?? "") ?? "待對應";
                const share = targetShares.get(targetId ?? "") ?? originShares.get(id) ?? 0;
                return <View key={id} style={[styles.amountRow, styles.previewRow]}>
                  <Text style={[styles.body, styles.fill]}>{label} · 原 {sourceNames.get(id)}</Text>
                  <Text style={styles.amount}>{money(share)}</Text>
                </View>;
              })}
              <View style={[styles.amountRow, styles.previewRow]}>
                <Text style={styles.label}>合計</Text><Text style={styles.amount}>{money(total.amountMinor)}</Text>
              </View>
            </View>
            <Text style={styles.caption}>確認後會新增一筆正式費用。付款人記錄的是向商家實付的人，分攤金額則依照原快照入帳。</Text>
          </>
        )}
      </ConversionPage>
      {picker && <MemberPicker title={picker.kind === "payer" ? "選擇實際付款人" : "對應活動成員"}
        members={options} labels={names} selected={assignedId} onClose={() => setPicker(undefined)}
        onClear={picker.kind === "mapping" && assignedId ? () => changeMapping(picker.sourceId) : undefined}
        onSelect={(id) => {
          if (picker.kind === "mapping") changeMapping(picker.sourceId, id);
          else { setPayerId(id); setError(undefined); setPicker(undefined); }
        }} />}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  header: {
    width: "100%", maxWidth: 620, alignSelf: "center", minHeight: 54, paddingHorizontal: 18,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  headerSide: { flex: 1, minHeight: 44, alignItems: "flex-start", justifyContent: "center" },
  headerEnd: { alignItems: "flex-end" },
  title: { color: colors.ink, fontSize: 19, fontWeight: "700", textAlign: "center", flexShrink: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 6, paddingBottom: 16, gap: 11 },
  footer: { paddingHorizontal: 18, paddingVertical: 8, backgroundColor: colors.page },
  footerInner: { width: "100%", maxWidth: 584, alignSelf: "center", gap: 5 },
  primary: { minHeight: 52, padding: 10, borderRadius: 14, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  primaryText: { color: colors.onPrimary, fontSize: 16, fontWeight: "700", textAlign: "center" },
  card: { padding: 13, gap: 7, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 16 },
  summary: { padding: 15, gap: 6 },
  summaryAmount: { color: colors.ink, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1 },
  confirmAmount: { fontSize: 23 },
  amountRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 4 },
  intro: { gap: 5, paddingTop: 4 },
  heading: { color: colors.ink, fontSize: 16, fontWeight: "700", flexShrink: 1 },
  label: { color: colors.ink, fontSize: 14, fontWeight: "700", flexShrink: 1 },
  body: { color: colors.ink, fontSize: 14, flexShrink: 1 },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 17, flexShrink: 1 },
  options: { gap: 10 },
  activityOption: { flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 12 },
  activityTitle: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 4 },
  badge: { backgroundColor: colors.tile, borderRadius: 10, paddingHorizontal: 6, fontWeight: "600" },
  selected: { borderColor: colors.ink },
  dimmed: { opacity: 0.55 },
  radio: { width: 21, height: 21, borderRadius: 11, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checked: { backgroundColor: colors.ink, borderColor: colors.ink },
  createNotice: { padding: 10, flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: colors.line, borderStyle: "dashed", borderRadius: 12 },
  field: { gap: 5 },
  input: { minHeight: 44, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 8, color: colors.ink, fontSize: 15 },
  fill: { flex: 1 },
  picker: { flexDirection: "row", alignItems: "center", gap: 5 },
  compactField: { flex: 1, minHeight: 44, backgroundColor: colors.quiet, justifyContent: "center" },
  originalMember: { paddingVertical: 8 },
  mappingRow: { flexDirection: "row", alignItems: "stretch", gap: 7 },
  arrow: { color: colors.muted, fontSize: 18, alignSelf: "center" },
  previewRow: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, minHeight: 36, paddingVertical: 6 },
  amount: { color: colors.ink, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right", marginLeft: "auto" },
  error: { color: "#9A372B", fontSize: 13 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(40, 40, 40, 0.32)" },
  sheet: { width: "100%", maxWidth: 620, maxHeight: "90%", alignSelf: "center", borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 8, backgroundColor: colors.surface },
  pickerScroll: { flexShrink: 1 },
  memberChoice: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
});
