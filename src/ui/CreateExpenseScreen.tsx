import { uuid } from "expo";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import {
  ActivityIndicator, Alert, BackHandler, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Switch, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createActivityRepository, type ActivityDetail } from "../data/activities.ts";
import { getLocalDatabase } from "../data/database.ts";
import { createFinanceRepository } from "../data/finance.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import {
  calculateExpenseSplit, createExpenseEditor, expenseDateInput, expenseDateTimestamp, prepareNewExpense,
} from "../services/expenseEditor.ts";
import type { EditorField, EditorMember, QuickSplitEditorState } from "../services/quickSplitEditor.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { SplitModeSelector } from "./SplitModeSelector.tsx";
import { validationMessage } from "./splitEditorMessages.ts";
import { colors, Icon } from "./visuals.tsx";

const dateFormat = new Intl.DateTimeFormat("zh-HK", { year: "numeric", month: "long", day: "numeric" });
type FormSection = "basic" | "total" | "members" | "payer" | "details";
const editorSections: Record<EditorField, FormSection> = {
  currency: "total", finalTotal: "total", members: "members", hostId: "members", coverAmount: "members",
  coverPercentage: "members", personalAmount: "members", sharedAmount: "members", sharedMembers: "members",
  merchantPayerId: "payer", subtotal: "details", discount: "details", serviceFee: "details",
};

function storageMessage(code: DomainErrorCode) {
  switch (code) {
    case "ACTIVITY_COMPLETED": return "活動已完成，請先重新開啟再新增費用。";
    case "ACTIVITY_NOT_FOUND": return "找不到這個活動。";
    case "MEMBER_NOT_PARTICIPATING": return "活動成員資料已變更，請返回活動詳情後再試。";
    case "CURRENCY_MISMATCH": return "活動幣種已變更，請返回活動詳情後再試。";
    case "TRANSFER_EXCEEDS_BALANCE": return "所選日期會令已記錄的還款與帳本不符，請核對費用日期。";
    case "AMOUNT_OVERFLOW": return "活動帳本的金額超出上限，請核對後再試。";
    case "EVENT_ID_CONFLICT": return "儲存請求與已有費用不符，請返回活動詳情核對。";
    default: return "未能儲存費用，請核對資料後再試。";
  }
}

function ErrorText({ message }: { message?: string }) {
  return message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;
}

function Card({ title, children, onLayout }: {
  title?: string; children: ReactNode; onLayout?: (y: number) => void;
}) {
  return (
    <View style={styles.card} onLayout={onLayout && (({ nativeEvent }) => onLayout(nativeEvent.layout.y))}>
      {title && <Text accessibilityRole="header" style={styles.heading}>{title}</Text>}
      {children}
    </View>
  );
}

function AmountField({ label, value, onChange, placeholder, error, onFocus }: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string; error?: string; onFocus: () => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} onFocus={onFocus}
        placeholder={placeholder} placeholderTextColor={colors.muted} keyboardType="decimal-pad" style={styles.input} />
      <ErrorText message={error} />
    </View>
  );
}

function Option({ label, selected, onPress, multiple = false }: {
  label: string; selected: boolean; onPress: () => void; multiple?: boolean;
}) {
  return (
    <Pressable accessibilityRole={multiple ? "checkbox" : "radio"} accessibilityState={{ checked: selected }} onPress={onPress}
      style={[styles.option, selected && styles.selectedOption]}>
      {selected && <Icon name="check" size={15} />}
      <Text style={styles.optionText}>{label}</Text>
    </Pressable>
  );
}

export function CreateExpenseScreen({ activityId, onBack, onSaved }: {
  activityId: string; onBack: () => void; onSaved: () => void;
}) {
  const [activity, setActivity] = useState<ActivityDetail | null>();
  const [editor, setEditor] = useState<QuickSplitEditorState>();
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [openedAt] = useState(() => new Date());
  const [date, setDate] = useState(() => expenseDateInput(openedAt));
  const [dateEditing, setDateEditing] = useState(false);
  const [showPayers, setShowPayers] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [id] = useState(() => uuid.v4());
  const mounted = useRef(false);
  const pending = useRef(false);
  const offsets = useRef<Partial<Record<FormSection, number>>>({});
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const { top } = useSafeAreaInsets();

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const result = await createActivityRepository(await getLocalDatabase()).getActivity(activityId);
      if (!mounted.current) return;
      setActivity(result);
      if (result?.status === "active") setEditor(createExpenseEditor(result));
    } catch {
      if (mounted.current) setLoadError(true);
    }
  }, [activityId]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => { void load(); }, [load]);

  const close = useCallback(() => {
    if (pending.current) return;
    if (!dirty) { onBack(); return; }
    Alert.alert("放棄這筆費用？", "尚未儲存的輸入將會清除。", [
      { text: "繼續編輯", style: "cancel" }, { text: "放棄", style: "destructive", onPress: onBack },
    ]);
  }, [dirty, onBack]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => sub.remove();
  }, [close]);

  function revealInput() {
    const input = TextInput.State.currentlyFocusedInput();
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, 74, true);
  }

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const sub = Keyboard.addListener("keyboardDidShow", revealInput);
    return () => sub.remove();
  }, []);

  function onInputFocus() {
    if (Platform.OS === "ios" && Keyboard.isVisible()) requestAnimationFrame(revealInput);
  }

  function markDirty() {
    setDirty(true);
    setSaveError(undefined);
  }

  function setField<K extends keyof QuickSplitEditorState>(field: K, value: QuickSplitEditorState[K]) {
    markDirty();
    setEditor((current) => current && { ...current, [field]: value });
  }

  function setMember(member: EditorMember, update: Partial<EditorMember>) {
    if (editor) setField("members", editor.members.map((row) => row.id === member.id ? { ...row, ...update } : row));
  }

  const occurredAt = expenseDateTimestamp(date, openedAt);
  const preview = editor && calculateExpenseSplit(editor);
  const split = preview?.ok ? preview.value.snapshot.split : undefined;
  const payer = editor?.members.find((member) => member.id === editor.merchantPayerId);
  const error = preview?.ok === false ? preview.error : undefined;
  const participants = editor?.members.filter(({ included }) => included) ?? [];
  const formReady = !!(activity && editor);
  const details = editor?.chargeMode === "details";

  function fieldError(field: EditorField, memberId?: string) {
    return attempted && error?.field === field && error.memberId === memberId ? validationMessage(error) : undefined;
  }

  const offset = (section: FormSection) => (y: number) => { offsets.current[section] = y; };

  function focusSection(section: FormSection) {
    if (section === "details") setShowDetails(true);
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: Math.max(0, (offsets.current[section] ?? 0) - 8) }));
  }

  async function save() {
    if (!activity || !editor || pending.current) return;
    Keyboard.dismiss();
    setAttempted(true);
    setSaveError(undefined);
    if (!name.trim() || occurredAt === undefined) { focusSection("basic"); return; }

    const expense = prepareNewExpense(id, name, editor);
    if (!expense.ok) {
      focusSection(error ? editorSections[error.field] : "payer");
      return;
    }

    pending.current = true;
    setSaving(true);
    try {
      const repository = createFinanceRepository(await getLocalDatabase());
      const result = await repository.createExpense(activityId, occurredAt, expense.value);
      if (!mounted.current) return;
      if (result.ok) onSaved();
      else setSaveError(storageMessage(result.error.code));
    } catch {
      if (mounted.current) setSaveError(storageMessage("FINANCE_STORAGE_ERROR"));
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  const placeholder = activity?.currency === "JPY" ? "0" : "0.00";
  const money = (minor: number) => activity ? formatResultMoney(activity.currency, minor) : "";
  const shares = new Map(split?.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  const total = split && money(split.total.amountMinor);

  function amountField(
    field: "coverAmount" | "coverPercentage" | "sharedAmount" | "subtotal" | "discount" | "serviceFee",
    label: string,
  ) {
    if (!editor) return null;
    return <AmountField label={label} value={editor[field]} onChange={(value) => setField(field, value)}
      placeholder={field === "coverPercentage" ? "0–100" : placeholder} error={fieldError(field)} onFocus={onInputFocus} />;
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={top}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回活動詳情" disabled={saving} onPress={close} style={styles.headerSide}>
          <Icon name="back" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>新增費用</Text>
        <Pressable accessibilityRole="button" disabled={saving} onPress={close} style={[styles.headerSide, styles.headerRight]}>
          <Text style={styles.cancel}>取消</Text>
        </Pressable>
      </View>
      <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" pointerEvents={saving ? "none" : "auto"}>
        {loadError ? (
          <Card>
            <ErrorText message="未能讀取活動，請重試。" />
            <Pressable accessibilityRole="button" onPress={() => { void load(); }} style={styles.picker}>
              <Text style={styles.label}>重新讀取</Text>
            </Pressable>
          </Card>
        ) : activity === undefined ? <ActivityIndicator accessibilityLabel="正在讀取活動" color={colors.ink} />
          : !formReady ? <ErrorText message={activity ? storageMessage("ACTIVITY_COMPLETED") : storageMessage("ACTIVITY_NOT_FOUND")} /> : null}

        {activity && editor && (
          <>
            <View style={styles.context}>
              <Text style={[styles.caption, styles.fill]}>活動　<Text style={styles.label}>{activity.name}</Text></Text>
              <Text style={[styles.caption, styles.badge]}>進行中 · {activity.currency}</Text>
            </View>

            <Card onLayout={offset("basic")}>
              <View style={styles.field}>
                <Text style={styles.label}>費用名稱 *</Text>
                <TextInput accessibilityLabel="費用名稱" value={name} onChangeText={(value) => { setName(value); markDirty(); }}
                  placeholder="輸入費用名稱" placeholderTextColor={colors.muted} onFocus={onInputFocus} style={styles.input} />
                <ErrorText message={attempted && !name.trim() ? "請輸入費用名稱。" : undefined} />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>費用日期</Text>
                {dateEditing ? (
                  <>
                    <TextInput accessibilityLabel="費用日期，年、月、日" value={date} autoFocus selectTextOnFocus
                      onChangeText={(value) => { setDate(value); markDirty(); }} onFocus={onInputFocus}
                      onBlur={() => { if (occurredAt !== undefined) setDateEditing(false); }}
                      keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"}
                      returnKeyType="done" maxLength={10} placeholder="YYYY-MM-DD" style={styles.input} />
                    <Text style={styles.caption}>格式為 YYYY-MM-DD。</Text>
                  </>
                ) : (
                  <Pressable accessibilityRole="button" accessibilityLabel="更改費用日期" style={styles.picker} onPress={() => setDateEditing(true)}>
                    <Text style={[styles.inputText, styles.fill]}>{occurredAt === undefined ? date : dateFormat.format(occurredAt)}</Text>
                    <Icon name="down" size={17} />
                  </Pressable>
                )}
                <ErrorText message={attempted && occurredAt === undefined ? "請輸入有效的費用日期。" : undefined} />
              </View>
            </Card>

            <Card title="實際帳單總額 *" onLayout={offset("total")}>
              <View style={[styles.picker, styles.bill]}>
                <View><Text style={styles.heading}>{activity.currency}</Text><Text style={styles.caption}>活動幣種</Text></View>
                <TextInput accessibilityLabel="實際帳單總額" value={editor.finalTotal} onChangeText={(value) => setField("finalTotal", value)}
                  onFocus={onInputFocus} keyboardType="decimal-pad" placeholder={placeholder} placeholderTextColor={colors.muted}
                  style={styles.billInput} />
              </View>
              <Text style={styles.caption}>{details ? "用作核對按明細計算的金額。" : "填寫已包含服務費及折扣的實付金額。"}</Text>
              <ErrorText message={fieldError("finalTotal") ?? fieldError("currency")} />
            </Card>

            <Card title="分帳方式">
              <SplitModeSelector mode={editor.mode} onSelect={(mode) => setField("mode", mode)} />
              <Text style={styles.caption}>單筆費用僅使用一種分帳方式。</Text>
            </Card>

            <Card title="參與成員" onLayout={offset("members")}>
              {editor.members.map((member, index) => (
                <View key={member.id} style={index > 0 && styles.divider}>
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: member.included }}
                    accessibilityLabel={`${member.displayName}參與分攤`}
                    onPress={() => setMember(member, { included: !member.included })} style={styles.memberRow}>
                    <View style={[styles.checkbox, member.included && styles.checkedBox]}>
                      {member.included && <Icon name="check" size={14} color={colors.onPrimary} />}
                    </View>
                    <Text style={[styles.label, styles.fill]}>{member.displayName}</Text>
                    <Text style={styles.caption}>{member.included ? "參與分攤" : "不參與"}</Text>
                  </Pressable>
                  {editor.mode === "individual" && member.included && (
                    <AmountField label={`${member.displayName}的個人消費`} value={member.personalAmount}
                      onChange={(personalAmount) => setMember(member, { personalAmount })} placeholder={placeholder}
                      error={fieldError("personalAmount", member.id)} onFocus={onInputFocus} />
                  )}
                </View>
              ))}
              <ErrorText message={fieldError("members")} />
              {editor.mode === "treat" && (
                <View style={styles.subsection}>
                  <Text style={styles.label}>誰請客？</Text>
                  <View accessibilityRole="radiogroup" style={styles.options}>
                    {participants.map(({ id, displayName }) => (
                      <Option key={id} label={displayName} selected={editor.hostId === id} onPress={() => setField("hostId", id)} />
                    ))}
                  </View>
                  <ErrorText message={fieldError("hostId")} />
                  <Text style={styles.label}>請客者最終承擔</Text>
                  <View accessibilityRole="radiogroup" style={styles.options}>
                    <Option label="固定金額" selected={editor.coverKind === "fixed"} onPress={() => setField("coverKind", "fixed")} />
                    <Option label="總額百分比" selected={editor.coverKind === "percentage"} onPress={() => setField("coverKind", "percentage")} />
                  </View>
                  {editor.coverKind === "fixed" ? amountField("coverAmount", "固定金額") : amountField("coverPercentage", "總額百分比（%）")}
                  <View style={styles.memberRow}>
                    <Text style={[styles.label, styles.fill]}>請客者也分攤餘額</Text>
                    <Switch accessibilityLabel="請客者也分攤餘額" value={editor.includeHostInRemainder}
                      trackColor={{ true: colors.ink }} onValueChange={(value) => setField("includeHostInRemainder", value)} />
                  </View>
                </View>
              )}
              {editor.mode === "individual" && (
                <View style={styles.subsection}>
                  {amountField("sharedAmount", "公共消費總額")}
                  <Text style={styles.label}>公共消費參與者</Text>
                  <View style={styles.options}>
                    {participants.map((member) => <Option key={member.id} label={member.displayName} selected={member.shareCommon}
                      multiple onPress={() => setMember(member, { shareCommon: !member.shareCommon })} />)}
                  </View>
                  <ErrorText message={fieldError("sharedMembers")} />
                </View>
              )}
            </Card>

            <Card title="誰向商家付款？ *" onLayout={offset("payer")}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPayers }} onPress={() => setShowPayers(!showPayers)} style={styles.picker}>
                <View style={[styles.fill, styles.field]}>
                  <Text style={styles.label}>{payer?.displayName ?? "選擇實際付款人"}</Text>
                  {payer && total && <Text style={styles.caption}>實際支付 {total}</Text>}
                </View>
                <Icon name={showPayers ? "minus" : "down"} size={17} />
              </Pressable>
              {showPayers && (
                <View accessibilityRole="radiogroup" style={styles.options}>
                  {editor.members.map(({ id, displayName }) => <Option key={id} label={displayName} selected={editor.merchantPayerId === id}
                    onPress={() => { setField("merchantPayerId", id); setShowPayers(false); }} />)}
                </View>
              )}
              <Text style={styles.caption}>付款與分帳承擔額分開記錄。Free 每筆費用由一位成員全額付款。</Text>
              <ErrorText message={attempted && !payer ? "請選擇實際向商家付款的成員。" : undefined} />
            </Card>

            <Card onLayout={offset("details")}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDetails }}
                onPress={() => setShowDetails(!showDetails)} style={styles.memberRow}>
                <Text style={[styles.heading, styles.fill]}>費用明細（選填）</Text>
                <Icon name={showDetails ? "minus" : "down"} size={17} />
              </Pressable>
              <Text style={styles.caption}>{details ? "已啟用費用明細，實付金額只用來核對。" : "需要服務費或整單折扣時再展開，避免重複加費。"}</Text>
              {showDetails && (
                <>
                  <View style={styles.memberRow}>
                    <Text style={[styles.label, styles.fill]}>按費用明細計算</Text>
                    <Switch accessibilityLabel="按費用明細計算" value={details} trackColor={{ true: colors.ink }}
                      onValueChange={(value) => setField("chargeMode", value ? "details" : "finalTotal")} />
                  </View>
                  {details && (
                    <>
                      {amountField("subtotal", "商品小計")}
                      {amountField("discount", "固定折扣（選填）")}
                      <Text style={styles.label}>服務費</Text>
                      <View accessibilityRole="radiogroup" style={styles.options}>
                        <Option label="無" selected={editor.serviceFeeMode === "none"} onPress={() => setField("serviceFeeMode", "none")} />
                        <Option label="實際金額" selected={editor.serviceFeeMode === "manual"} onPress={() => setField("serviceFeeMode", "manual")} />
                        <Option label="快捷 10%" selected={editor.serviceFeeMode === "quick10"} onPress={() => setField("serviceFeeMode", "quick10")} />
                      </View>
                      {editor.serviceFeeMode === "manual" && amountField("serviceFee", "實際服務費")}
                      {editor.serviceFeeMode === "quick10" && (
                        <View accessibilityRole="radiogroup" style={styles.options}>
                          <Option label="折扣前小計" selected={editor.serviceFeeBasis === "beforeDiscount"} onPress={() => setField("serviceFeeBasis", "beforeDiscount")} />
                          <Option label="折扣後小計" selected={editor.serviceFeeBasis === "afterDiscount"} onPress={() => setField("serviceFeeBasis", "afterDiscount")} />
                        </View>
                      )}
                      {editor.serviceFeeMode !== "manual" && <ErrorText message={fieldError("serviceFee")} />}
                    </>
                  )}
                </>
              )}
            </Card>

            <Card title="分攤預覽">
              {split ? (
                <>
                  <View style={styles.previewRow}>
                    <Text style={[styles.caption, styles.fill]}>實際帳單總額</Text><Text style={styles.amount}>{total}</Text>
                  </View>
                  <View style={styles.previewShares}>
                    {editor.members.map(({ id, displayName }, index) => (
                      <View key={id} style={[styles.previewRow, index > 0 && styles.divider]}>
                        <Text style={[styles.label, styles.fill]}>{displayName} · 應承擔</Text>
                        <Text style={styles.amount}>{money(shares.get(id) ?? 0)}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={[styles.previewRow, styles.divider]}>
                    <Text style={[styles.label, styles.fill]}>分攤合計</Text><Text style={styles.amount}>{total}</Text>
                  </View>
                  <Text style={styles.caption}>分攤合計與實付總額一致。</Text>
                </>
              ) : <Text style={styles.caption}>填妥金額及分攤資料後，即可查看每位成員的承擔額。</Text>}
            </Card>
            <Card>
              <Text style={styles.label}>儲存至活動「{activity.name}」</Text>
              <Text style={styles.caption}>儲存後會更新活動帳本及結算建議。</Text>
            </Card>
          </>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <View style={styles.footerContent}>
          <ErrorText message={saveError} />
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !formReady || saving, busy: saving }}
            disabled={!formReady || saving} onPress={() => { void save(); }}
            style={({ pressed }) => [styles.saveButton, (pressed || !formReady || saving) && styles.dimmed]}>
            <Text style={styles.saveText}>{saving ? "正在儲存…" : "儲存費用"}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  header: {
    width: "100%", maxWidth: 620, alignSelf: "center", minHeight: 52, paddingHorizontal: 18,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  headerSide: { flex: 1, minHeight: 44, justifyContent: "center", alignItems: "flex-start" },
  headerRight: { alignItems: "flex-end" },
  title: { color: colors.ink, fontWeight: "700", fontSize: 19, textAlign: "center" },
  cancel: { color: colors.muted, fontSize: 15, fontWeight: "600" },
  scroll: { flex: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 8, paddingBottom: 16, gap: 12 },
  context: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: { backgroundColor: colors.tile, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  card: { padding: 15, gap: 9, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 16 },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  label: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  caption: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  field: { gap: 5 },
  input: {
    minHeight: 46, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16, color: colors.ink,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 11,
  },
  inputText: { color: colors.ink, fontSize: 16 },
  picker: {
    minHeight: 46, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center",
    gap: 8, borderWidth: 1, borderColor: colors.line, borderRadius: 11,
  },
  bill: { minHeight: 62 },
  billInput: { flex: 1, minHeight: 44, color: colors.ink, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right" },
  fill: { flex: 1 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  memberRow: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: 9 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderColor: colors.muted, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  checkedBox: { backgroundColor: colors.primary, borderColor: colors.primary },
  subsection: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  option: {
    maxWidth: "100%", minHeight: 44, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: colors.line,
    borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 5,
  },
  selectedOption: { backgroundColor: colors.quiet, borderColor: colors.muted },
  optionText: { color: colors.ink, fontSize: 14, flexShrink: 1 },
  previewShares: { backgroundColor: colors.quiet, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 11, paddingHorizontal: 12 },
  previewRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 7 },
  amount: { color: colors.ink, fontSize: 15, fontWeight: "700", textAlign: "right", fontVariant: ["tabular-nums"], marginLeft: "auto" },
  error: { color: "#9A372B", fontSize: 14 },
  footer: { paddingHorizontal: 18, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  footerContent: { width: "100%", maxWidth: 584, alignSelf: "center", gap: 6 },
  saveButton: {
    minHeight: 52, padding: 10, backgroundColor: colors.primary, borderRadius: 13, justifyContent: "center", alignItems: "center",
  },
  saveText: { color: colors.onPrimary, fontSize: 17, fontWeight: "700" },
  dimmed: { opacity: 0.65 },
});
