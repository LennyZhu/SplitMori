import { formatUiDate } from "../services/localizedCopy.ts";
import type { Copy } from "../services/localizedCopy.ts";
import { useCopy } from "./useCopy.ts";
import { uuid } from "expo";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import {
  ActivityIndicator, AppState, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getLocalDatabase } from "../data/database.ts";
import { createFinanceRepository, type FinanceMemberTransfer, type StoredFinanceEvent } from "../data/finance.ts";
import { formatAmount } from "../domain/money.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import type { TransferSuggestion } from "../domain/settlement.ts";
import { loadActivitySettlement, type ActivitySettlementData } from "../services/activitySettlement.ts";
import { expenseDateInput } from "../services/expenseEditor.ts";
import { inspectRepaymentDraft, type PreparedRepayment, type RepaymentDraft } from "../services/memberRepayment.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { ConversionButton, ConversionPage, ConversionReadError, memberLabels, MemberPicker } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";

type MemberField = "fromMemberId" | "toMemberId";
type Confirmation = PreparedRepayment & { id: string };
type SavedRepayment = { event: StoredFinanceEvent<FinanceMemberTransfer>; fromName: string; toName: string };

function formMessage(t: Copy, field: keyof RepaymentDraft, code?: DomainErrorCode): string | undefined {
  if (!code) return;
  if (field === "fromMemberId") return t("請選擇目前有應付金額的活動成員。");
  if (field === "toMemberId") return code === "SELF_TRANSFER" ? t("付款人與收款人必須是不同成員。") : t("請選擇目前有應收金額的活動成員。");
  if (field === "date") {
    return code === "TRANSFER_DATE_CONFLICT" ? t("所選日期與還款當時或之後的帳本紀錄不符，請核對實際轉帳日期。")
      : t("請輸入有效的 YYYY-MM-DD 日期，日期須為今天或更早。");
  }
  if (field === "amount") {
    if (code === "TRANSFER_EXCEEDS_BALANCE") return t("金額不可超過付款人的應付額或收款人的應收額。");
    if (code === "INVALID_AMOUNT_PRECISION") return t("金額的小數位數超出此幣種的上限。");
    if (code === "AMOUNT_OVERFLOW") return t("金額超出上限。");
    return t("請輸入大於零的有效還款金額。");
  }
}

function submissionMessage(t: Copy, code: DomainErrorCode): string {
  switch (code) {
    case "TRANSFER_BALANCES_CHANGED":
    case "TRANSFER_EXCEEDS_BALANCE":
    case "MEMBER_NOT_PARTICIPATING":
      return t("帳本已更新，請核對最新餘額和還款資料後重新確認。");
    case "EVENT_ID_CONFLICT": return t("這筆記錄與已有事件衝突，請返回活動結算核對。");
    case "ACTIVITY_NOT_FOUND": return t("找不到這個活動，請返回活動結算。");
    default: return t("未能記錄還款，請核對後重試。");
  }
}

function FieldError({ text }: { text?: string }) {
  return text ? <Text accessibilityRole="alert" style={styles.error}>{text}</Text> : null;
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      <FieldError text={error} />
    </View>
  );
}

function SelectMember({ label, name, onPress }: { label: string; name?: string; onPress: () => void }) {
  const t = useCopy();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}，${name ?? t("尚未選擇")}`}
      onPress={onPress} style={[styles.control, styles.picker]}>
      <Text style={[name ? styles.value : styles.caption, styles.fill]}>{name ?? t("選擇成員")}</Text>
      <Icon name="down" size={18} />
    </Pressable>
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.confirmRow}><Text style={styles.caption}>{label}</Text><Text style={styles.confirmValue}>{value}</Text></View>;
}

function ConfirmationSheet({ repayment, busy, error, onClose, onConfirm }: {
  repayment: Confirmation; busy: boolean; error?: string; onClose: () => void; onConfirm: () => void;
}) {
  const t = useCopy();
  const insets = useSafeAreaInsets();
  const { transfer } = repayment;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, {
        paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12, paddingLeft: insets.left + 22, paddingRight: insets.right + 22,
      }]}>
        <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.card, styles.dialog]}>
          <ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled">
            <Text accessibilityRole="header" style={styles.dialogTitle}>{t("確認記錄還款")}</Text>
            <ConfirmRow label={t("付款人")} value={repayment.fromName} />
            <ConfirmRow label={t("收款人")} value={repayment.toName} />
            <ConfirmRow label={t("還款金額")} value={formatResultMoney(transfer.currency, transfer.amountMinor)} />
            <ConfirmRow label={t("轉帳日期")} value={formatUiDate(t, repayment.occurredAt)} />
            {transfer.note && <ConfirmRow label={t("備註")} value={transfer.note} />}
            <Text style={styles.confirmNotice}>{t("此操作只會記錄轉帳，不會代你轉帳。")}</Text>
            <FieldError text={error} />
          </ScrollView>
          <View style={styles.dialogActions}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onClose}
              style={({ pressed }) => [styles.dialogButton, (pressed || busy) && styles.dimmed]}>
              <Text style={styles.dialogButtonText}>{t("取消")}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={onConfirm}
              style={({ pressed }) => [styles.dialogButton, styles.dialogPrimary, (pressed || busy) && styles.dimmed]}>
              <Text style={[styles.dialogButtonText, styles.dialogPrimaryText]}>{busy ? t("正在記錄…") : error ? t("重試記錄") : t("確認記錄")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Success({ saved, onBack }: { saved: SavedRepayment; onBack: () => void }) {
  const t = useCopy();
  const { event, fromName, toName } = saved;
  return (
    <ConversionPage title="" onBack={onBack} footer={<ConversionButton label={t("返回活動結算")} onPress={onBack} />}>
      <View style={styles.success}>
        <View style={styles.check}><Icon name="check" size={36} /></View>
        <Text accessibilityRole="header" style={styles.successTitle}>{t("還款已記錄")}</Text>
        <Text style={[styles.caption, styles.center]}>{t("已成功記錄一筆成員還款，活動結算已更新。")}</Text>
      </View>
      <View style={[styles.card, styles.receipt]}>
        <View style={styles.receiptLine}>
          <Text style={styles.receiptTitle}>{fromName} → {toName}</Text>
          <Text style={styles.receiptTitle}>{formatResultMoney(event.currency, event.amountMinor)}</Text>
        </View>
        <Text style={styles.caption}>{t("轉帳日期：{0}", formatUiDate(t, event.occurredAt))}</Text>
        {event.note && <Text style={styles.caption}>{t("備註：{0}", event.note)}</Text>}
      </View>
    </ConversionPage>
  );
}

export function ActivityRepaymentScreen({ activityId, suggestion, onBack }: {
  activityId: string; suggestion: TransferSuggestion; onBack: () => void;
}) {
  const t = useCopy();
  const [draft, setDraft] = useState<RepaymentDraft>(() => {
    const initialAmount = formatAmount(suggestion);
    return {
      fromMemberId: suggestion.fromMemberId, toMemberId: suggestion.toMemberId, amount: initialAmount.ok ? initialAmount.value : "",
      date: expenseDateInput(new Date()), note: "",
    };
  });
  const [data, setData] = useState<ActivitySettlementData | null>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [picker, setPicker] = useState<MemberField>();
  const [dateEditing, setDateEditing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [saved, setSaved] = useState<SavedRepayment>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<DomainErrorCode>();
  const [sheetError, setSheetError] = useState<string>();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const mounted = useRef(false);
  const latest = useRef(0);
  const pending = useRef(false);
  const attempts = useRef(new Map<string, { id: string; occurredAt: number }>());

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

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; latest.current += 1; };
  }, []);
  useEffect(() => {
    void reload();
    let previous = AppState.currentState;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") void reload();
      previous = state;
    });
    return () => sub.remove();
  }, [reload]);

  const revealInput = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput();
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, 74, true);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const sub = Keyboard.addListener("keyboardDidShow", revealInput);
    return () => sub.remove();
  }, [revealInput]);

  function onFocus() {
    if (Platform.OS === "ios" && Keyboard.isVisible()) requestAnimationFrame(revealInput);
  }

  const inspection = data && inspectRepaymentDraft(draft, data, new Date());
  const names = memberLabels(t, data?.activity.members ?? []);
  const canRecord = data?.status === "unsettled" && data.suggestions.length > 0;
  const pickerMembers = picker && data ? data.activity.members.filter(({ id }) => {
    const balance = data.members.find(({ memberId }) => memberId === id)?.netBalanceMinor ?? 0;
    return picker === "fromMemberId" ? balance < 0 : balance > 0;
  }) : [];

  function change(field: keyof RepaymentDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(undefined);
  }

  function openPicker(field: MemberField) {
    Keyboard.dismiss();
    setPicker(field);
  }

  function review() {
    if (!data || !canRecord || loading || readError || pending.current || confirmation) return;
    Keyboard.dismiss();
    setAttempted(true);
    const { prepared } = inspectRepaymentDraft(draft, data, new Date());
    if (!prepared) return;
    const key = JSON.stringify([draft.date.trim(), prepared.transfer]);
    const attempt = attempts.current.get(key) ?? { id: uuid.v4(), occurredAt: prepared.occurredAt };
    attempts.current.set(key, attempt);
    setError(undefined);
    setSheetError(undefined);
    setConfirmation({ ...prepared, ...attempt,
      fromName: names.get(prepared.transfer.fromMemberId) ?? prepared.fromName,
      toName: names.get(prepared.transfer.toMemberId) ?? prepared.toName });
  }

  function closeConfirmation() {
    if (pending.current) return;
    setConfirmation(undefined);
    setSheetError(undefined);
  }

  function close() {
    if (pending.current) return;
    Keyboard.dismiss();
    onBack();
  }

  async function confirm() {
    if (!confirmation || pending.current) return;
    pending.current = true;
    setSaving(true);
    setSheetError(undefined);
    try {
      const { id, transfer, occurredAt, expectedBalances, fromName, toName } = confirmation;
      const finance = createFinanceRepository(await getLocalDatabase());
      const result = await finance.recordMemberTransfer(activityId, occurredAt, { ...transfer, id }, expectedBalances);
      if (!mounted.current) return;
      if (result.ok && result.value.kind === "memberTransfer") {
        setSaved({ event: result.value, fromName, toName });
        setConfirmation(undefined);
      } else if (!result.ok && result.error.code !== "FINANCE_STORAGE_ERROR") {
        setError(result.error.code);
        setConfirmation(undefined);
        if (result.error.code === "TRANSFER_BALANCES_CHANGED" || result.error.code === "TRANSFER_EXCEEDS_BALANCE"
          || result.error.code === "MEMBER_NOT_PARTICIPATING" || result.error.code === "ACTIVITY_NOT_FOUND") void reload();
      } else {
        setSheetError(t("未能寫入還款記錄，請重試。"));
      }
    } catch {
      if (mounted.current) setSheetError(t("未能寫入還款記錄，請重試。"));
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  if (saved) return <Success saved={saved} onBack={onBack} />;
  const dateError = error === "TRANSFER_DATE_CONFLICT" || error === "INVALID_EVENT_TIME" ? error : undefined;
  const footerError = error && !dateError ? submissionMessage(t, error) : undefined;
  const limit = inspection?.limit ?? 0;

  return (
    <>
      <ConversionPage title={t("記錄還款")} onBack={close} busy={saving} scrollRef={scroll}
        footer={<>
          <FieldError text={footerError} />
          <ConversionButton label={t("儲存還款")} disabled={!canRecord || loading || readError || saving} onPress={review} />
        </>}>
        {loading && !data && <ActivityIndicator accessibilityLabel={t("正在讀取帳本")} color={colors.ink} />}
        {readError && <ConversionReadError retry={() => { void reload(); }} />}
        {data === null && <Text style={styles.caption}>{t("找不到這個活動。")}</Text>}
        {data && !canRecord && <View style={[styles.card, styles.empty]}>
          <Text style={styles.label}>{data.status === "empty" ? t("暫無財務紀錄") : t("目前沒有可記錄的還款")}</Text>
          <Text style={styles.caption}>{t("請返回活動結算查看目前帳務。")}</Text>
        </View>}
        {data && (canRecord || attempted) && (
          <>
            <View style={styles.info}>
              <View style={styles.infoIcon}><Text style={styles.infoMark}>i</Text></View>
              <Text style={[styles.caption, styles.fill]}>{t("請記錄已實際發生的成員之間轉帳。")}{t("此操作只會記錄轉帳，不會代你轉帳。")}</Text>
            </View>
            <Field label={t("付款人 *")} error={attempted ? formMessage(t, "fromMemberId", inspection?.errors.fromMemberId) : undefined}>
              <SelectMember label={t("付款人")} name={names.get(draft.fromMemberId)} onPress={() => openPicker("fromMemberId")} />
            </Field>
            <Field label={t("收款人 *")} error={attempted ? formMessage(t, "toMemberId", inspection?.errors.toMemberId) : undefined}>
              <SelectMember label={t("收款人")} name={names.get(draft.toMemberId)} onPress={() => openPicker("toMemberId")} />
            </Field>
            <Field label={t("還款金額 ({0}) *", data.activity.currency)} error={attempted ? formMessage(t, "amount", inspection?.errors.amount) : undefined}>
              <TextInput accessibilityLabel={t("還款金額，{0}", data.activity.currency)} keyboardType="decimal-pad" onFocus={onFocus}
                value={draft.amount} onChangeText={(value) => change("amount", value)} editable={!saving}
                style={[styles.control, styles.input, styles.moneyInput]} />
              <Text style={styles.caption}>{t("最高可記錄 {0}（依雙方目前餘額）", formatResultMoney(data.activity.currency, limit))}</Text>
            </Field>
            <Field label={t("轉帳日期 *")} error={formMessage(t, "date", dateError ?? (attempted ? inspection?.errors.date : undefined))}>
              {dateEditing ? (
                <>
                  <TextInput accessibilityLabel={t("轉帳日期，年、月、日")} value={draft.date} autoFocus selectTextOnFocus
                    onChangeText={(value) => change("date", value)} onFocus={onFocus}
                    onBlur={() => { if (inspection?.occurredAt !== undefined) setDateEditing(false); }}
                    keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"}
                    returnKeyType="done" maxLength={10} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted}
                    style={[styles.control, styles.input]} />
                  <Text style={styles.caption}>{t("格式為 YYYY-MM-DD。")}</Text>
                </>
              ) : (
                <Pressable accessibilityRole="button" accessibilityLabel={t("更改轉帳日期")} onPress={() => setDateEditing(true)}
                  style={[styles.control, styles.picker]}>
                  <Icon name="calendar" size={20} />
                  <Text style={[styles.value, styles.fill]}>{inspection?.occurredAt === undefined ? draft.date : formatUiDate(t, inspection.occurredAt)}</Text>
                </Pressable>
              )}
            </Field>
            <Field label={t("備註（選填）")}>
              <TextInput accessibilityLabel={t("備註")} value={draft.note} onChangeText={(value) => change("note", value)} onFocus={onFocus}
                editable={!saving} multiline placeholder={t("例如 FPS 或現金")} placeholderTextColor={colors.muted}
                style={[styles.control, styles.input, styles.noteInput]} />
            </Field>
          </>
        )}
      </ConversionPage>
      {picker && <MemberPicker title={picker === "fromMemberId" ? t("選擇付款人") : t("選擇收款人")}
        members={pickerMembers} labels={names} selected={draft[picker]} emptyText={t("目前沒有可選的還款成員。")}
        onClose={() => setPicker(undefined)}
        onSelect={(id) => { change(picker, id); setPicker(undefined); }} />}
      {confirmation && <ConfirmationSheet repayment={confirmation} busy={saving} error={sheetError}
        onClose={closeConfirmation} onConfirm={() => { void confirm(); }} />}
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  field: { gap: 6 },
  label: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  value: { color: colors.ink, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  info: { flexDirection: "row", alignItems: "center", gap: 11, padding: 13, borderRadius: 13, backgroundColor: colors.quiet },
  infoIcon: { width: 21, height: 21, borderRadius: 11, borderWidth: 1.5, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  infoMark: { color: colors.ink, fontSize: 13, lineHeight: 16, fontWeight: "700" },
  control: { minHeight: 45, paddingHorizontal: 12, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 11 },
  picker: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 9 },
  input: { color: colors.ink, fontSize: 16, paddingVertical: 9 },
  moneyInput: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  noteInput: { minHeight: 69, textAlignVertical: "top" },
  error: { color: "#9A372B", fontSize: 13 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 16 },
  empty: { padding: 15, gap: 6 },
  overlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(40, 40, 40, 0.42)" },
  dialog: { width: "100%", maxWidth: 415, maxHeight: "100%", alignSelf: "center", padding: 16, gap: 12 },
  dialogScroll: { flexGrow: 0, flexShrink: 1 },
  dialogContent: { gap: 0 },
  dialogTitle: { color: colors.ink, fontSize: 18, fontWeight: "700", textAlign: "center", marginBottom: 12 },
  confirmRow: { minHeight: 39, paddingVertical: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  confirmValue: { color: colors.ink, fontSize: 14, fontWeight: "600", textAlign: "right", flexShrink: 1, fontVariant: ["tabular-nums"] },
  confirmNotice: { color: colors.ink, fontSize: 13, lineHeight: 19, paddingTop: 9, marginBottom: 3,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  dialogActions: { flexDirection: "row", gap: 9 },
  dialogButton: { flex: 1, minHeight: 46, padding: 8, borderRadius: 11, borderColor: colors.line, borderWidth: 1,
    backgroundColor: colors.surface, justifyContent: "center", alignItems: "center" },
  dialogPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  dialogButtonText: { color: colors.ink, fontSize: 15, fontWeight: "700", textAlign: "center" },
  dialogPrimaryText: { color: colors.onPrimary },
  dimmed: { opacity: 0.6 },
  success: { alignItems: "center", paddingTop: 23, paddingBottom: 13, gap: 14 },
  check: { width: 82, height: 82, borderRadius: 41, backgroundColor: colors.tile, alignItems: "center", justifyContent: "center" },
  successTitle: { color: colors.ink, fontSize: 24, fontWeight: "700", textAlign: "center" },
  center: { textAlign: "center", maxWidth: 230 },
  receipt: { padding: 14, gap: 7 },
  receiptLine: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 9 },
  receiptTitle: { color: colors.ink, fontSize: 17, fontWeight: "700", flexShrink: 1, fontVariant: ["tabular-nums"] },
});
