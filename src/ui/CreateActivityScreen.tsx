import { uuid } from "expo";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import {
  BackHandler, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActiveActivityLimitError, createActivityRepository, type Activity, type ActivityCreationBlocker, type NewMember,
} from "../data/activities.ts";
import { getLocalDatabase } from "../data/database.ts";
import type { Currency } from "../domain/money.ts";
import { CurrencyPicker, currencyName } from "./CurrencyPicker.tsx";
import { colors, Icon } from "./visuals.tsx";

const dateFormat = new Intl.DateTimeFormat("zh-HK", { year: "numeric", month: "long", day: "numeric" });
const newMember = (): NewMember => ({ id: uuid.v4(), displayName: "" });

export function CreateActivityScreen({ onBack, onCreated, onBlocked, defaultCurrency }: {
  defaultCurrency: Currency; onBack: () => void; onCreated: (activity: Activity) => void; onBlocked: (blocker: ActivityCreationBlocker) => void;
}) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [members, setMembers] = useState<readonly NewMember[]>(() => [newMember(), newMember()]);
  const [currencyPicker, setCurrencyPicker] = useState(false);
  const [validation, setValidation] = useState<"name" | "members">();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const chrome = useRef({ header: 0, footer: 0 });
  const pending = useRef(false);
  const mounted = useRef(false);
  const { top } = useSafeAreaInsets();

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!saving) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [saving]);

  const revealFocused = useCallback(() => {
    if (currencyPicker) return;
    const input = TextInput.State.currentlyFocusedInput();
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(
      input, top + chrome.current.header + chrome.current.footer + 12, true,
    );
  }, [currencyPicker, top]);

  useEffect(() => {
    if (Platform.OS !== "ios" || currencyPicker) return;
    const subscription = Keyboard.addListener("keyboardDidShow", revealFocused);
    return () => subscription.remove();
  }, [currencyPicker, revealFocused]);

  function focusInput() {
    if (Platform.OS === "ios" && Keyboard.isVisible()) requestAnimationFrame(revealFocused);
  }

  function updateMembers(next: readonly NewMember[]) {
    setMembers(next);
    if (validation === "members") setValidation(undefined);
  }

  async function submit() {
    if (pending.current) return;
    Keyboard.dismiss();
    setError(false);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidation("name");
      scroll.current?.scrollTo({ y: 0 });
      return;
    }
    const initialMembers = members.filter(({ displayName }) => displayName.trim() !== "");
    if (initialMembers.length === 0) {
      setValidation("members");
      scroll.current?.scrollToEnd();
      return;
    }
    pending.current = true;
    setValidation(undefined);
    setSaving(true);
    try {
      const repository = createActivityRepository(await getLocalDatabase());
      const activity = await repository.createActivity({ id: uuid.v4(), name: trimmedName, currency, members: initialMembers });
      if (mounted.current) onCreated(activity);
    } catch (cause) {
      if (mounted.current) {
        if (cause instanceof ActiveActivityLimitError) onBlocked(cause.blocker);
        else setError(true);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={top}>
      <View style={styles.header} onLayout={({ nativeEvent }) => { chrome.current.header = nativeEvent.layout.height; }}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={onBack} disabled={saving} style={[styles.headerAction, styles.back]}>
          <Icon name="back" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>建立活動</Text>
        <Pressable accessibilityRole="button" onPress={onBack} disabled={saving} style={styles.headerAction}>
          <Text style={styles.caption}>取消</Text>
        </Pressable>
      </View>
      <ScrollView
        ref={scroll}
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.field}>
          <Text style={styles.label}>活動名稱 <Text style={styles.caption}>必填</Text></Text>
          <TextInput
            accessibilityLabel="活動名稱" value={name} editable={!saving} maxLength={80}
            placeholder="例如：週末聚餐" placeholderTextColor={colors.muted}
            onFocus={focusInput}
            onChangeText={(value) => { setName(value); if (validation === "name") setValidation(undefined); }}
            style={[styles.box, styles.input, validation === "name" && styles.invalid]}
          />
          {validation === "name" && <Text accessibilityRole="alert" style={styles.error}>請輸入活動名稱。</Text>}
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>幣種</Text>
          <Pressable
            accessibilityRole="button" accessibilityLabel={`幣種 ${currency} ${currencyName(currency)}`}
            accessibilityState={{ expanded: currencyPicker }} disabled={saving}
            onPress={() => { Keyboard.dismiss(); setCurrencyPicker(true); }}
            style={({ pressed }) => [styles.box, styles.picker, pressed && styles.pressed]}
          >
            <Text style={styles.currency}>{currency}  <Text style={styles.caption}>{currencyName(currency)}</Text></Text>
            <Icon name="down" size={17} color={colors.muted} />
          </Pressable>
          <Text style={styles.caption}>同一活動中的費用使用相同幣種。</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>日期 <Text style={styles.caption}>預設今天</Text></Text>
          <View style={[styles.box, styles.date]}><Text style={styles.currency}>{dateFormat.format(new Date())}</Text></View>
        </View>
        <View style={styles.field}>
          <View style={styles.memberHeader}>
            <Text style={styles.label}>參與成員</Text>
            <Text style={styles.caption}>{members.filter(({ displayName }) => displayName.trim() !== "").length} 位成員</Text>
          </View>
          <View style={[styles.box, validation === "members" && styles.invalid]}>
            {members.map(({ id, displayName }, index) => (
              <View key={id} style={[styles.member, index > 0 && styles.divider]}>
                <Text style={styles.ordinal}>{index + 1}</Text>
                <TextInput
                  accessibilityLabel={`成員 ${index + 1} 名稱`}
                  value={displayName} editable={!saving} maxLength={40} onFocus={focusInput}
                  onChangeText={(value) => updateMembers(members.map((member) => member.id === id ? { ...member, displayName: value } : member))}
                  placeholder={`成員 ${index + 1}`} placeholderTextColor={colors.muted} style={styles.memberInput}
                />
                {members.length > 1 && (
                  <Pressable accessibilityRole="button" accessibilityLabel={`移除成員 ${index + 1}`}
                    disabled={saving} onPress={() => updateMembers(members.filter((member) => member.id !== id))} style={styles.remove}>
                    <Icon name="minus" size={19} color={colors.muted} />
                  </Pressable>
                )}
              </View>
            ))}
            <Pressable accessibilityRole="button" onPress={() => updateMembers([...members, newMember()])} disabled={saving}
              style={({ pressed }) => [styles.add, styles.divider, pressed && styles.pressed]}>
              <Icon name="plus" size={19} />
              <Text style={styles.label}>新增成員</Text>
            </Pressable>
          </View>
          {validation === "members" ? <Text accessibilityRole="alert" style={styles.error}>請填寫至少一位成員的名稱。</Text>
            : <Text style={styles.caption}>留空的成員欄位不會加入活動。</Text>}
        </View>
      </ScrollView>
      <View style={styles.footer} onLayout={({ nativeEvent }) => { chrome.current.footer = nativeEvent.layout.height; }}>
        <View style={styles.footerInner}>
          {error && <Text accessibilityRole="alert" style={styles.error}>未能儲存活動，請重試。</Text>}
          <Pressable accessibilityRole="button" accessibilityState={{ busy: saving, disabled: saving }}
            disabled={saving} onPress={submit} style={({ pressed }) => [styles.submit, (pressed || saving) && styles.pressed]}>
            <Text style={styles.submitText}>{saving ? "正在建立…" : "建立活動"}</Text>
          </Pressable>
        </View>
      </View>
      {currencyPicker && <CurrencyPicker selected={currency} onClose={() => setCurrencyPicker(false)}
        onSelect={(next) => { setCurrency(next); setCurrencyPicker(false); }} />}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    width: "100%", maxWidth: 620, minHeight: 55, alignSelf: "center", paddingHorizontal: 18,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  headerAction: { flex: 1, minHeight: 44, justifyContent: "center", alignItems: "flex-end" },
  back: { alignItems: "flex-start" },
  title: { color: colors.ink, fontSize: 20, fontWeight: "700", textAlign: "center" },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 20, paddingTop: 13, paddingBottom: 20, gap: 18 },
  field: { gap: 7 },
  label: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  caption: { color: colors.muted, fontSize: 13, fontWeight: "400" },
  box: { minHeight: 48, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
  input: { paddingHorizontal: 13, paddingVertical: 10, color: colors.ink, fontSize: 16 },
  picker: { paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  date: { paddingHorizontal: 13, paddingVertical: 10, justifyContent: "center" },
  currency: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  memberHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 },
  member: { minHeight: 49, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12 },
  ordinal: { minWidth: 26, borderRadius: 14, padding: 5, textAlign: "center", color: colors.muted, backgroundColor: colors.quiet, fontSize: 13 },
  memberInput: { flex: 1, color: colors.ink, fontSize: 16, paddingVertical: 9, paddingRight: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  remove: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  add: { minHeight: 47, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 7 },
  footer: { backgroundColor: colors.page, paddingHorizontal: 20, paddingTop: 9, paddingBottom: 10 },
  footerInner: { width: "100%", maxWidth: 580, alignSelf: "center", gap: 7 },
  submit: { minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.primary, padding: 9 },
  submitText: { color: colors.onPrimary, fontSize: 17, fontWeight: "700" },
  invalid: { borderColor: "#9A372B" },
  error: { color: "#9A372B", fontSize: 14 },
  pressed: { opacity: 0.65 },
});
