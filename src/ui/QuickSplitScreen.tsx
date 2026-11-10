import { useCopy } from "./useCopy.ts";
import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import {
  ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch,
  Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parseAmount, type Currency } from "../domain/money.ts";
import {
  addEditorMember, calculateQuickSplitEditor, editorMemberName, removeEditorMember,
  type EditorError, type EditorField, type QuickSplitEditorState, type QuickSplitPreview,
} from "../services/quickSplitEditor.ts";
import { CurrencyPicker } from "./CurrencyPicker.tsx";
import { AdvancedChargeFields, AdvancedMethodFields } from "./AdvancedSplitFields.tsx";
import { advancedEditorMessage } from "./advancedSplitCopy.ts";
import { usePro } from "./ProContext.ts";
import { SplitModeSelector } from "./SplitModeSelector.tsx";
import { validationMessage } from "./splitEditorMessages.ts";
import { useQuickSplitDraft } from "./useQuickSplitDraft.ts";
import { colors, Icon } from "./visuals.tsx";

type SectionName = "total" | "members" | "details" | "payer";
type Member = QuickSplitEditorState["members"][number];

const errorSections: Record<EditorField, SectionName> = {
  currency: "total", finalTotal: "total",
  members: "members", hostId: "members", coverAmount: "members", coverPercentage: "members",
  personalAmount: "members", sharedAmount: "members", sharedMembers: "members",
  subtotal: "details", discount: "details", serviceFee: "details", merchantPayerId: "payer",
  hosts: "members", items: "members", custom: "members", chargeDistribution: "details",
};

function InlineError({ message }: { message?: string }) {
  return message ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text> : null;
}

function Field({ label, value, onChangeText, placeholder, error, onFocus }: {
  label: string; value: string; onChangeText: (value: string) => void; placeholder: string;
  error?: string; onFocus: () => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        inputMode="decimal"
        onFocus={onFocus}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, error && styles.invalidInput]}
      />
      <InlineError message={error} />
    </View>
  );
}

function Choice({ label, selected, onPress, multiple = false }: {
  label: string; selected: boolean; onPress: () => void; multiple?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={multiple ? "checkbox" : "radio"}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, selected && styles.selectedChoice, pressed && styles.pressed]}
    >
      {multiple && <View style={[styles.checkbox, selected && styles.checkedBox]}>
        {selected && <Icon name="check" size={15} color={colors.onPrimary} />}
      </View>}
      <Text style={[styles.choiceText, selected && styles.selectedChoiceText]}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function QuickSplitScreen({ onBack, onResult, focusPayer, defaultCurrency }: {
  onBack: () => void;
  onResult: (result: QuickSplitPreview) => void;
  focusPayer?: boolean; defaultCurrency: Currency;
}) {
  const t = useCopy();
  const { language } = t;
  const { hasProAccess } = usePro();
  const { editor, updateEditor, loading, error: draftError, retry, discard, discarding } = useQuickSplitDraft(defaultCurrency);
  const [validation, setValidation] = useState<EditorError>();
  const [showCurrencies, setShowCurrencies] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsets = useRef<Partial<Record<SectionName, number>>>({});
  const chrome = useRef({ header: 0, footer: 0 });
  const { top } = useSafeAreaInsets();
  const details = editor.chargeMode === "details";
  const amountPlaceholder = editor.currency === "JPY" ? "0" : "0.00";
  const busy = loading || discarding;
  const editable = !busy && draftError !== "load";

  const revealFocusedInput = useCallback(() => {
    if (showCurrencies) return;
    const input = TextInput.State.currentlyFocusedInput();
    // The native scroll helper measures against the keyboard's screen position.
    const offset = top + chrome.current.header + chrome.current.footer + 12;
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, offset, true);
  }, [showCurrencies, top]);

  useEffect(() => {
    if (Platform.OS !== "ios" || showCurrencies) return;
    const subscription = Keyboard.addListener("keyboardDidShow", revealFocusedInput);
    return () => subscription.remove();
  }, [revealFocusedInput, showCurrencies]);

  useEffect(() => {
    if (!focusPayer || !editable) return;
    const frame = requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
    return () => cancelAnimationFrame(frame);
  }, [editable, focusPayer]);

  function onInputFocus() {
    if (Platform.OS === "ios" && Keyboard.isVisible()) requestAnimationFrame(revealFocusedInput);
  }

  function apply(update: (current: QuickSplitEditorState) => QuickSplitEditorState) {
    setValidation(undefined);
    updateEditor(update);
  }

  function setField<K extends keyof QuickSplitEditorState>(field: K, value: QuickSplitEditorState[K]) {
    apply((current) => ({ ...current, [field]: value }));
  }

  function setMember(id: string, update: Partial<Member>) {
    apply((current) => ({
      ...current, members: current.members.map((member) => member.id === id ? { ...member, ...update } : member),
    }));
  }

  function fieldError(field: EditorField, memberId?: string) {
    return validation?.field === field && validation.memberId === memberId
      ? advancedEditorMessage(validation, language, editor.customKind === "percentage") ?? validationMessage(t, validation)
      : undefined;
  }

  function amountError(field: EditorField, raw: string, memberId?: string) {
    const text = raw.trim();
    if (text !== "") {
      const parsed = parseAmount(text, editor.currency);
      if (!parsed.ok && parsed.error.code === "INVALID_AMOUNT_PRECISION") {
        return validationMessage(t, { code: parsed.error.code, field, memberId });
      }
    }
    return fieldError(field, memberId);
  }

  const finalTotalError = amountError("finalTotal", editor.finalTotal);

  function confirmChargeMode() {
    if (details) {
      Alert.alert(t("改用實付總額？"), t("只按實際帳單總額分帳，商品小計、服務費和折扣不會套用。"), [
        { text: t("取消"), style: "cancel" },
        { text: t("改用實付總額"), onPress: () => setField("chargeMode", "finalTotal") },
      ]);
    } else {
      Alert.alert(t("改按費用明細計算？"), t("實際帳單總額會用作核對。請另填未計服務費及折扣的商品小計。"), [
        { text: t("取消"), style: "cancel" },
        { text: t("按明細計算"), onPress: () => setField("chargeMode", "details") },
      ]);
    }
  }

  function confirmDiscard() {
    Alert.alert(t("放棄草稿？"), t("目前的輸入會清除，你可以重新開始。"), [
      { text: t("取消"), style: "cancel" },
      { text: t("放棄草稿"), style: "destructive", onPress: () => {
        setValidation(undefined);
        setShowCurrencies(false);
        discard();
      } },
    ]);
  }

  function viewResult() {
    Keyboard.dismiss();
    const result = calculateQuickSplitEditor(editor, hasProAccess(), language);
    if (result.ok) {
      setValidation(undefined);
      onResult(result.value);
    } else {
      setValidation(result.error);
      const y = offsets.current[errorSections[result.error.field]];
      if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
    }
  }

  const memberChoices = (selectedId: string | undefined, select: (id: string) => void) =>
    editor.members.map((member, index) => (
      <Choice key={member.id} label={editorMemberName(member, index, language)} selected={selectedId === member.id} onPress={() => select(member.id)} />
    ));

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={top}>
      <View style={styles.header} onLayout={({ nativeEvent }) => { chrome.current.header = nativeEvent.layout.height; }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("返回首頁")} onPress={onBack} style={styles.back}>
          <Icon name="back" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>{t("快速分帳")}</Text>
        {editable ? (
          <Pressable accessibilityRole="button" onPress={confirmDiscard} style={styles.headerAction}>
            <Text style={[styles.actionText, styles.headerActionText]}>{t("放棄草稿")}</Text>
          </Pressable>
        ) : <View style={styles.headerSpacer} />}
      </View>
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {busy && (
          <View style={styles.notice}>
            <ActivityIndicator color={colors.accentText} />
            <Text accessibilityLiveRegion="polite" style={styles.caption}>{loading ? t("正在讀取草稿…") : t("正在清除草稿…")}</Text>
          </View>
        )}
        {draftError && (
          <View style={styles.notice}>
            <InlineError message={draftError === "load" ? t("未能讀取草稿，請重試。")
              : draftError === "discard" ? t("未能清除草稿，請重試。") : t("未能儲存草稿。輸入仍在此頁，你可以重試。")} />
            <Pressable accessibilityRole="button" onPress={retry} style={styles.textButton}>
              <Text style={styles.actionText}>{t("重試")}</Text>
            </Pressable>
          </View>
        )}
        {editable && (
          <View style={styles.form}>
            <View onLayout={({ nativeEvent }) => { offsets.current.total = nativeEvent.layout.y; }}>
              <Section title={t("實際帳單總額")}>
                <Text style={styles.caption}>{details ? t("用作核對按明細計算的結果。") : t("輸入已包含服務費及折扣的最終實付金額。")}</Text>
                <View style={styles.amountRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("幣種 {0}", editor.currency)}
                    accessibilityState={{ expanded: showCurrencies }}
                    onPress={() => {
                      Keyboard.dismiss();
                      setShowCurrencies(true);
                    }}
                    style={styles.currencyButton}
                  >
                    <Text style={styles.currencyText}>{editor.currency}</Text>
                    <Icon name="down" size={15} color={colors.muted} />
                  </Pressable>
                  <TextInput
                    accessibilityLabel={t("實際帳單總額")}
                    inputMode="decimal"
                    placeholder={amountPlaceholder}
                    placeholderTextColor={colors.muted}
                    value={editor.finalTotal}
                    onFocus={onInputFocus}
                    onChangeText={(value) => setField("finalTotal", value)}
                    style={[styles.input, styles.billInput, finalTotalError && styles.invalidInput]}
                  />
                </View>
                <InlineError message={finalTotalError ?? fieldError("currency")} />
              </Section>
            </View>

            <Section title={t("分帳方式")}>
              <SplitModeSelector mode={editor.mode} onSelect={(mode) => setField("mode", mode)} />
            </Section>

            <View onLayout={({ nativeEvent }) => { offsets.current.members = nativeEvent.layout.y; }}>
              <Section title={t("參與成員")}>
                <Text style={styles.caption}>
                  {editor.mode === "equal" ? t("勾選要平均分攤的人。未填姓名時會使用臨時名稱。") : t("未填姓名時會使用臨時名稱。")}
                </Text>
                {editor.members.map((member, index) => {
                  const name = editorMemberName(member, index, language);
                  return (
                    <View key={member.id} style={styles.member}>
                      <View style={styles.memberRow}>
                        {(editor.mode === "equal" || editor.mode === "custom") && (
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityLabel={editor.mode === "equal" ? t("{0}參與平均分攤", name)
                              : language === "en" ? `Include ${name}` : t("{0}參與分攤", name)}
                            accessibilityState={{ checked: member.included }}
                            onPress={() => setMember(member.id, { included: !member.included })}
                            style={styles.iconButton}
                          >
                            <View style={[styles.checkbox, member.included && styles.checkedBox]}>
                              {member.included && <Icon name="check" size={15} color={colors.onPrimary} />}
                            </View>
                          </Pressable>
                        )}
                        <TextInput
                          accessibilityLabel={t("成員 {0} 姓名", index + 1)}
                          value={member.displayName}
                          onFocus={onInputFocus}
                          onChangeText={(displayName) => setMember(member.id, { displayName })}
                          placeholder={name}
                          placeholderTextColor={colors.muted}
                          style={[styles.input, styles.nameInput]}
                        />
                        {editor.members.length > 1 && (
                          <Pressable accessibilityRole="button" accessibilityLabel={t("移除{0}", name)}
                            onPress={() => apply((current) => removeEditorMember(current, member.id))} style={styles.iconButton}>
                            <Icon name="minus" size={19} color={colors.muted} />
                          </Pressable>
                        )}
                      </View>
                      {editor.mode === "individual" && !editor.itemized && (
                        <Field label={t("{0}的個人消費", name)} value={member.personalAmount}
                          onChangeText={(personalAmount) => setMember(member.id, { personalAmount })}
                          placeholder={amountPlaceholder} error={amountError("personalAmount", member.personalAmount, member.id)} onFocus={onInputFocus} />
                      )}
                    </View>
                  );
                })}
                <Pressable accessibilityRole="button" onPress={() => apply(addEditorMember)} style={styles.textButton}>
                  <Icon name="plus" size={19} color={colors.accentText} />
                  <Text style={styles.actionText}>{t("新增成員")}</Text>
                </Pressable>
                <InlineError message={fieldError("members")} />

                {editor.mode === "treat" && (
                  <View style={styles.subsection}>
                    <Text style={styles.label}>{t("請客者")}</Text>
                    <View accessibilityRole="radiogroup" style={styles.choices}>
                      {memberChoices(editor.hostId, (id) => setField("hostId", id))}
                    </View>
                    <InlineError message={fieldError("hostId")} />
                    <View accessibilityRole="radiogroup" style={styles.choices}>
                      <Choice label={t("固定金額")} selected={editor.coverKind === "fixed"} onPress={() => setField("coverKind", "fixed")} />
                      <Choice label={t("按百分比")} selected={editor.coverKind === "percentage"} onPress={() => setField("coverKind", "percentage")} />
                    </View>
                    {editor.coverKind === "fixed"
                      ? <Field label={t("請客金額")} value={editor.coverAmount} onChangeText={(value) => setField("coverAmount", value)}
                          placeholder={amountPlaceholder} error={amountError("coverAmount", editor.coverAmount)} onFocus={onInputFocus} />
                      : <Field label={t("請客百分比（%）")} value={editor.coverPercentage} onChangeText={(value) => setField("coverPercentage", value)}
                          placeholder="0–100" error={fieldError("coverPercentage")} onFocus={onInputFocus} />}
                    <View style={styles.switchRow}>
                      <Text style={[styles.label, styles.flex]}>{t("請客者也分攤餘額")}</Text>
                      <Switch accessibilityLabel={t("請客者也分攤餘額")} value={editor.includeHostInRemainder}
                        trackColor={{ true: colors.accent }} onValueChange={(value) => setField("includeHostInRemainder", value)} />
                    </View>
                    <Text style={styles.caption}>{t("餘額由其他成員平均分攤，亦可讓請客者一起分攤。")}</Text>
                  </View>
                )}

                {editor.mode === "individual" && !editor.itemized && (
                  <View style={styles.subsection}>
                    <Field label={t("公共消費總額")} value={editor.sharedAmount} onChangeText={(value) => setField("sharedAmount", value)}
                      placeholder={amountPlaceholder} error={amountError("sharedAmount", editor.sharedAmount)} onFocus={onInputFocus} />
                    <Text style={styles.label}>{t("公共消費參與者")}</Text>
                    <View style={styles.choices}>
                      {editor.members.map((member, index) => (
                        <Choice key={member.id} label={editorMemberName(member, index, language)} multiple
                          selected={member.shareCommon} onPress={() => setMember(member.id, { shareCommon: !member.shareCommon })} />
                      ))}
                    </View>
                    <InlineError message={fieldError("sharedMembers")} />
                  </View>
                )}
                <AdvancedMethodFields editor={editor} participants={editor.mode === "custom"
                  ? editor.members.filter(({ included }) => included) : editor.members}
                  update={(patch) => apply((current) => ({ ...current, ...patch }))}
                  error={fieldError} onFocus={onInputFocus} />
              </Section>
            </View>

            <View onLayout={({ nativeEvent }) => { offsets.current.details = nativeEvent.layout.y; }}>
              <Section title={t("費用明細（選填）")}>
                <Pressable accessibilityRole="button" onPress={confirmChargeMode} style={styles.textButton}>
                  <Icon name={details ? "receipt" : "plus"} size={19} color={colors.accentText} />
                  <Text style={styles.actionText}>{details ? t("改用實付總額") : t("按明細計算")}</Text>
                </Pressable>
                {details ? (
                  <>
                    <Field label={t("商品小計")} value={editor.subtotal} onChangeText={(value) => setField("subtotal", value)}
                      placeholder={amountPlaceholder} error={amountError("subtotal", editor.subtotal)} onFocus={onInputFocus} />
                    <Field label={t("固定折扣（選填）")} value={editor.discount} onChangeText={(value) => setField("discount", value)}
                      placeholder={amountPlaceholder} error={amountError("discount", editor.discount)} onFocus={onInputFocus} />
                    <Text style={styles.label}>{t("服務費")}</Text>
                    <View accessibilityRole="radiogroup" style={styles.choices}>
                      <Choice label={t("無")} selected={editor.serviceFeeMode === "none"} onPress={() => setField("serviceFeeMode", "none")} />
                      <Choice label={t("實際金額")} selected={editor.serviceFeeMode === "manual"} onPress={() => setField("serviceFeeMode", "manual")} />
                      <Choice label={t("快捷 10%")} selected={editor.serviceFeeMode === "quick10"} onPress={() => setField("serviceFeeMode", "quick10")} />
                    </View>
                    {editor.serviceFeeMode === "manual" && (
                      <Field label={t("實際服務費")} value={editor.serviceFee} onChangeText={(value) => setField("serviceFee", value)}
                        placeholder={amountPlaceholder} error={amountError("serviceFee", editor.serviceFee)} onFocus={onInputFocus} />
                    )}
                    {editor.serviceFeeMode === "quick10" && (
                      <>
                        <Text style={styles.label}>{t("服務費計算基準")}</Text>
                        <View accessibilityRole="radiogroup" style={styles.choices}>
                          <Choice label={t("折扣前小計")} selected={editor.serviceFeeBasis === "beforeDiscount"}
                            onPress={() => setField("serviceFeeBasis", "beforeDiscount")} />
                          <Choice label={t("折扣後小計")} selected={editor.serviceFeeBasis === "afterDiscount"}
                            onPress={() => setField("serviceFeeBasis", "afterDiscount")} />
                        </View>
                      </>
                    )}
                    {editor.serviceFeeMode !== "manual" && <InlineError message={fieldError("serviceFee")} />}
                    <AdvancedChargeFields editor={editor} participants={editor.mode === "equal"
                      ? editor.members.filter(({ included }) => included) : editor.members}
                      update={(patch) => apply((current) => ({ ...current, ...patch }))} error={fieldError} />
                  </>
                ) : <Text style={styles.caption}>{t("目前按實付總額分帳。")}</Text>}
              </Section>
            </View>

            <View onLayout={({ nativeEvent }) => { offsets.current.payer = nativeEvent.layout.y; }}>
              <Section title={t("誰先付款？（選填）")}>
                <Text style={styles.caption}>{t("可指定一位實際向商家付款的成員。未指定仍可試算。")}</Text>
                <View accessibilityRole="radiogroup" style={styles.choices}>
                  <Choice label={t("未指定")} selected={editor.merchantPayerId === undefined} onPress={() => setField("merchantPayerId", undefined)} />
                  {memberChoices(editor.merchantPayerId, (id) => setField("merchantPayerId", id))}
                </View>
                <InlineError message={fieldError("merchantPayerId")} />
              </Section>
            </View>
          </View>
        )}
      </ScrollView>
      <View style={styles.footer} onLayout={({ nativeEvent }) => { chrome.current.footer = nativeEvent.layout.height; }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !editable }}
          disabled={!editable}
          onPress={viewResult}
          style={({ pressed }) => [styles.resultButton, (pressed || !editable) && styles.pressed]}
        >
          <Text style={styles.resultText}>{t("查看結果")}</Text>
        </Pressable>
      </View>
      {showCurrencies && (
        <CurrencyPicker
          selected={editor.currency}
          onClose={() => setShowCurrencies(false)}
          onSelect={(currency) => {
            if (currency !== editor.currency) setField("currency", currency);
            setShowCurrencies(false);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  header: {
    minHeight: 55, width: "100%", maxWidth: 620, alignSelf: "center", flexDirection: "row",
    alignItems: "center", paddingHorizontal: 12, gap: 8,
  },
  back: { flex: 1, minHeight: 44, alignItems: "flex-start", justifyContent: "center", paddingLeft: 4 },
  title: { color: colors.ink, fontWeight: "700", fontSize: 19, textAlign: "center", flexShrink: 1 },
  headerAction: { flex: 1, minHeight: 44, justifyContent: "center", alignItems: "flex-end", paddingRight: 4 },
  headerActionText: { maxWidth: "100%", textAlign: "right" },
  headerSpacer: { flex: 1 },
  scroll: { flex: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 8, paddingBottom: 20, gap: 14 },
  form: { gap: 13 },
  section: { borderColor: colors.line, borderWidth: 1, borderRadius: 15, padding: 15, gap: 10, backgroundColor: colors.surface },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  label: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  caption: { color: colors.muted, fontSize: 14, flexShrink: 1 },
  field: { gap: 5 },
  input: {
    color: colors.ink, borderColor: colors.line, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12,
    paddingVertical: 9, minHeight: 45, fontSize: 16, backgroundColor: colors.surface,
  },
  invalidInput: { borderColor: colors.accentText },
  amountRow: { flexDirection: "row", alignItems: "stretch", gap: 8 },
  currencyButton: {
    minHeight: 54, borderColor: colors.line, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10,
    flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.surface,
  },
  currencyText: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  billInput: { flex: 1, fontSize: 26, minHeight: 54, fontWeight: "700", fontVariant: ["tabular-nums"] },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10,
    paddingVertical: 6, minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 10,
    backgroundColor: colors.surface, maxWidth: "100%",
  },
  selectedChoice: { borderColor: colors.accentText, backgroundColor: colors.quiet },
  choiceText: { color: colors.ink, fontSize: 14, flexShrink: 1 },
  selectedChoiceText: { color: colors.accentText, fontWeight: "600" },
  member: { gap: 8 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  nameInput: { flex: 1 },
  iconButton: {
    width: 44, minHeight: 44, borderColor: colors.line, borderWidth: 1, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: colors.muted, alignItems: "center", justifyContent: "center" },
  checkedBox: { backgroundColor: colors.primary, borderColor: colors.primary },
  textButton: { alignSelf: "flex-start", minHeight: 44, minWidth: 44, alignItems: "center", flexDirection: "row", gap: 6 },
  actionText: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  subsection: { borderTopColor: colors.line, borderTopWidth: 1, paddingTop: 12, gap: 9 },
  switchRow: { flexDirection: "row", minHeight: 44, alignItems: "center", gap: 8 },
  flex: { flex: 1 },
  notice: { paddingHorizontal: 8, paddingVertical: 12, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  error: { color: "#9A372B", fontSize: 14, flexShrink: 1 },
  footer: { paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.page },
  resultButton: {
    width: "100%", maxWidth: 584, alignSelf: "center", minHeight: 52, borderRadius: 14, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center", paddingHorizontal: 12, paddingVertical: 9,
  },
  resultText: { color: colors.onPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
  pressed: { opacity: 0.65 },
});
