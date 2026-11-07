import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import {
  ActivityIndicator, Alert, AppState, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  createActivityRepository, MemberManagementError, memberNameMaxLength, validMemberName, type NewMember,
} from "../data/activities.ts";
import { getLocalDatabase } from "../data/database.ts";
import { loadActivityMembers } from "../services/activityMembers.ts";
import { ConversionButton, ConversionPage, ConversionReadError } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";

type MembersData = NonNullable<Awaited<ReturnType<typeof loadActivityMembers>>>;
type ManagedMember = MembersData["members"][number];
type InputRow = { readonly key: number; readonly name: string };

function memberError(error: unknown): string {
  if (error instanceof MemberManagementError) {
    switch (error.code) {
      case "ACTIVITY_COMPLETED": return "活動已完成，請先重新開啟再管理成員。";
      case "ACTIVITY_NOT_FOUND": return "找不到這個活動，請返回活動列表重新讀取。";
      case "MEMBER_NOT_FOUND": return "找不到這位成員，請重新讀取活動。";
      case "INVALID_MEMBER_NAME": return `請輸入 1 至 ${memberNameMaxLength} 個字的成員名稱。`;
      case "SHARED_MEMBER": return "這位成員與其他活動共用，目前無法只修改本活動的名稱。";
      case "MEMBER_CONFLICT": return "成員資料與本次請求不符，請返回活動核對。";
      case "INVALID_MEMBER_BATCH": return "請核對本次新增的成員名單。";
    }
  }
  return "未能儲存成員，請重試。你亦可返回活動核對。";
}

function NameError({ name, visible }: { name: string; visible: boolean }) {
  if (!visible || validMemberName(name)) return null;
  return <Text accessibilityRole="alert" style={styles.error}>{name.trim() ? `名稱最多可用 ${memberNameMaxLength} 個字。` : "請輸入成員名稱。"}</Text>;
}

function SecondaryButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.secondary, (pressed || disabled) && styles.dimmed]}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export function ActivityMembersScreen({ activityId, onBack }: { activityId: string; onBack: () => void }) {
  const [data, setData] = useState<MembersData | null>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManagedMember>();
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setReadError(false);
    try {
      const next = await loadActivityMembers(activityId);
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
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && previous !== "active") void reload();
      previous = next;
    });
    return () => { latest.current += 1; sub.remove(); };
  }, [reload]);

  function finishAdding() {
    setAdding(false);
    void reload();
  }

  if (adding && data) {
    return <AddActivityMembers data={data} onBack={() => { setAdding(false); void reload(); }} onSaved={finishAdding} />;
  }

  const active = data?.status === "active";
  return (
    <>
      <ConversionPage title="管理成員" onBack={onBack} footer={<ConversionButton label="返回活動詳情" onPress={onBack} />}>
        {loading && <ActivityIndicator accessibilityLabel="正在讀取成員" color={colors.ink} />}
        {readError && <ConversionReadError retry={() => { void reload(); }} />}
        {data === null && <Text style={styles.caption}>找不到這個活動。</Text>}
        {data && (
          <>
            <View style={styles.intro}>
              <Text style={styles.caption}>活動 · {data.name}</Text>
              <Text accessibilityRole="header" style={styles.mainTitle}>活動成員</Text>
              <Text style={styles.caption}>管理活動內的參與者，既有費用不會重新分攤。</Text>
            </View>
            <View style={styles.section}>
              <View style={styles.headingRow}>
                <Text accessibilityRole="header" style={styles.heading}>目前成員 ({data.members.length})</Text>
                <Text style={styles.caption}>依加入順序</Text>
              </View>
              <View style={styles.card}>
                {data.members.map((member, index) => (
                  <View key={member.id} style={[styles.memberRow, index > 0 && styles.divider]}>
                    <View style={styles.avatar}><Icon name="member" size={18} /></View>
                    <View style={styles.memberCopy}>
                      <Text style={styles.memberName}>{member.displayName}</Text>
                      <Text style={styles.minor}>{member.shared ? "與其他活動共用 · 暫不支援改名"
                        : member.hasHistory ? "已有財務紀錄 · 不可移除" : "尚未參與財務紀錄"}</Text>
                    </View>
                    {active && !member.shared
                      ? <Pressable accessibilityRole="button" accessibilityLabel={`編輯${member.displayName}的名稱`}
                        onPress={() => setEditing(member)} style={styles.editButton}>
                        <Text style={styles.editText}>編輯</Text><Icon name="next" size={13} color={colors.muted} />
                      </Pressable>
                      : <Text style={styles.minor}>唯讀</Text>}
                  </View>
                ))}
              </View>
              <SecondaryButton label="＋ 新增活動成員" disabled={!active || readError || loading} onPress={() => setAdding(true)} />
              {!active && <Text style={styles.caption}>活動已完成，重新開啟後即可管理成員。</Text>}
            </View>
            <View style={[styles.card, styles.tip]}>
              <Text style={styles.tipTitle}>成員與歷史帳務</Text>
              <Text style={styles.caption}>新增成員只影響之後的費用及成員對應，已儲存的付款、分攤及還款紀錄會保留。</Text>
            </View>
          </>
        )}
      </ConversionPage>
      {editing && <EditMemberName key={editing.id} activityId={activityId} member={editing}
        onClose={() => setEditing(undefined)} onSaved={(name) => {
          setEditing(undefined);
          setData((current) => current && { ...current, members: current.members.map((member) => member.id === editing.id
            ? { ...member, displayName: name } : member) });
          void reload();
        }} />}
    </>
  );
}

function AddActivityMembers({ data, onBack, onSaved }: { data: MembersData; onBack: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<readonly InputRow[]>([{ key: 1, name: "" }, { key: 2, name: "" }]);
  const nextKey = useRef(3);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<readonly NewMember[] | undefined>(undefined);
  const pending = useRef(false);
  const mounted = useRef(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsets = useRef(new Map<number, number>());
  const editable = !saving && request.current === undefined;
  const active = data.status === "active";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const close = useCallback(() => {
    if (pending.current) return;
    Keyboard.dismiss();
    if (!rows.some(({ name }) => name.trim() !== "")) { onBack(); return; }
    Alert.alert("返回管理成員？", "本頁尚未儲存的輸入將會清除。", [
      { text: "繼續編輯", style: "cancel" }, { text: "返回", onPress: onBack },
    ]);
  }, [onBack, rows]);

  const revealInput = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput();
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, 74, true);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const sub = Keyboard.addListener("keyboardDidShow", revealInput);
    return () => sub.remove();
  }, [revealInput]);

  async function save() {
    if (pending.current || !active) return;
    Keyboard.dismiss();
    setAttempted(true);
    const invalid = rows.find(({ name }) => !validMemberName(name));
    if (invalid) {
      scroll.current?.scrollTo({ y: Math.max(0, (offsets.current.get(invalid.key) ?? 0) - 8), animated: true });
      return;
    }
    request.current ??= rows.map(({ name }) => ({ id: uuid.v4(), displayName: name.trim() }));
    pending.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const repository = createActivityRepository(await getLocalDatabase());
      await repository.addMembers(data.id, request.current);
      if (mounted.current) onSaved();
    } catch (cause) {
      if (mounted.current) setError(memberError(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <ConversionPage title="新增成員" endLabel="取消" onBack={close} busy={saving} scrollRef={scroll}
      footer={<>
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <ConversionButton label={saving ? "正在儲存…" : request.current ? "重試儲存新增成員" : "儲存新增成員"}
          disabled={saving || !active || rows.length === 0} onPress={() => { void save(); }} />
      </>}>
      <View style={styles.intro}>
        <Text style={styles.caption}>加入至活動</Text>
        <Text accessibilityRole="header" style={styles.mainTitle}>{data.name}</Text>
        <Text style={styles.caption}>為活動新增成員，日後可用於分帳和快速記錄轉入。</Text>
      </View>
      {!active && <Text accessibilityRole="alert" style={styles.error}>活動已完成，請返回並重新開啟後再新增成員。</Text>}
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>新增名單 ({rows.length})</Text>
        {rows.map(({ key, name }, index) => (
          <View key={key} style={styles.field} onLayout={({ nativeEvent }) => { offsets.current.set(key, nativeEvent.layout.y); }}>
            <Text style={styles.label}>成員名稱 *</Text>
            <View style={styles.inputRow}>
              <TextInput accessibilityLabel={`新增成員 ${index + 1} 的名稱`} value={name} editable={editable && active}
                placeholder="輸入成員名稱" placeholderTextColor={colors.muted}
                onFocus={() => { if (Platform.OS === "ios" && Keyboard.isVisible()) requestAnimationFrame(revealInput); }}
                onChangeText={(value) => setRows((current) => current.map((row) => row.key === key ? { ...row, name: value } : row))}
                style={styles.input} />
              <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 個輸入欄位`}
                disabled={!editable || rows.length === 1 || !active}
                onPress={() => setRows((current) => current.filter((row) => row.key !== key))}
                style={[styles.removeButton, (rows.length === 1 || !editable) && styles.dimmed]}>
                <View style={styles.cross}><Icon name="plus" size={18} color={colors.muted} /></View>
              </Pressable>
            </View>
            <NameError name={name} visible={attempted} />
          </View>
        ))}
        <SecondaryButton label="＋ 再新增一位" disabled={!editable || !active} onPress={() => {
          const key = nextKey.current++;
          setRows((current) => [...current, { key, name: "" }]);
        }} />
        <Text style={styles.minor}>名稱最多 {memberNameMaxLength} 個字。同名成員會分別建立。</Text>
        {request.current && !saving && <Text style={styles.caption}>本次名單已保留，重試會使用相同資料。返回管理成員可核對目前名單。</Text>}
      </View>
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>新增後</Text>
        <View style={styles.card}>
          <CountRow label="目前活動成員" count={data.members.length} />
          <CountRow label="本次新增" count={rows.length} divider />
          <CountRow label="預計總人數" count={data.members.length + rows.length} divider strong />
        </View>
      </View>
      <View style={[styles.card, styles.tip]}>
        <Text style={styles.caption}>歷史費用和每位成員已承擔的金額保持不變。</Text>
      </View>
    </ConversionPage>
  );
}

function CountRow({ label, count, divider, strong }: { label: string; count: number; divider?: boolean; strong?: boolean }) {
  return (
    <View style={[styles.countRow, divider && styles.divider]}>
      <Text style={strong ? styles.label : styles.caption}>{label}</Text>
      <Text style={[styles.memberName, strong && styles.totalCount]}>{count} 人</Text>
    </View>
  );
}

function EditMemberName({ activityId, member, onClose, onSaved }: {
  activityId: string; member: ManagedMember; onClose: () => void; onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(member.displayName);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const mounted = useRef(false);
  const { top, bottom, left, right } = useSafeAreaInsets();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  function close() {
    if (!pending.current) { Keyboard.dismiss(); onClose(); }
  }
  async function save() {
    if (pending.current) return;
    setAttempted(true);
    if (!validMemberName(name)) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await createActivityRepository(await getLocalDatabase()).renameMember(activityId, member.id, name);
      if (mounted.current) { Keyboard.dismiss(); onSaved(updated.displayName); }
    } catch (cause) {
      if (mounted.current) setError(memberError(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.overlay, { paddingTop: top + 16, paddingBottom: bottom + 16, paddingLeft: left + 18, paddingRight: right + 18 }]}>
        <View accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.card, styles.editCard]}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.editContent}>
            <Text accessibilityRole="header" style={styles.heading}>修改成員名稱</Text>
            <Text style={styles.caption}>最多 {memberNameMaxLength} 個字。改名會保留原成員及所有帳務紀錄。</Text>
            <TextInput accessibilityLabel="成員名稱" value={name} onChangeText={setName} editable={!saving}
              autoFocus selectTextOnFocus autoCorrect={false} style={styles.editInput} returnKeyType="done"
              submitBehavior="submit" onSubmitEditing={() => { void save(); }} />
            <NameError name={name} visible={attempted} />
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <ConversionButton label={saving ? "正在儲存…" : "儲存名稱"} disabled={saving} onPress={() => { void save(); }} />
            <SecondaryButton label="取消" disabled={saving} onPress={close} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 4 },
  mainTitle: { color: colors.ink, fontSize: 25, lineHeight: 32, fontWeight: "700" },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 20, flexShrink: 1 },
  minor: { color: colors.muted, fontSize: 11, lineHeight: 17, flexShrink: 1 },
  section: { gap: 10, marginTop: 12 },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  heading: { color: colors.ink, fontSize: 16, fontWeight: "700", flexShrink: 1 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 17, overflow: "hidden" },
  memberRow: { minHeight: 70, paddingVertical: 11, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  memberCopy: { flex: 1, gap: 3 },
  memberName: { color: colors.ink, fontSize: 16, fontWeight: "700", flexShrink: 1 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.quiet, justifyContent: "center", alignItems: "center" },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  editButton: { minHeight: 44, minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "flex-end" },
  editText: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  secondary: { minHeight: 49, padding: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 13,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: colors.ink, fontSize: 14, fontWeight: "600", textAlign: "center" },
  tip: { padding: 15, gap: 4, marginTop: 7 },
  tipTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  label: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  field: { gap: 8 },
  inputRow: { minHeight: 54, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingLeft: 14, paddingRight: 4 },
  input: { flex: 1, minHeight: 52, paddingVertical: 10, color: colors.ink, fontSize: 16 },
  removeButton: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  cross: { transform: [{ rotate: "45deg" }] },
  countRow: { minHeight: 51, paddingVertical: 13, paddingHorizontal: 14, flexDirection: "row",
    alignItems: "center", justifyContent: "space-between", gap: 8 },
  totalCount: { fontSize: 18 },
  error: { color: "#9A372B", fontSize: 13 },
  dimmed: { opacity: 0.55 },
  overlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(40, 40, 40, 0.32)" },
  editCard: { width: "100%", maxWidth: 420, maxHeight: "100%", alignSelf: "center" },
  editContent: { padding: 16, gap: 11 },
  editInput: { minHeight: 46, borderWidth: 1, borderColor: colors.line, borderRadius: 11,
    paddingVertical: 8, paddingHorizontal: 12, color: colors.ink, fontSize: 16 },
});
