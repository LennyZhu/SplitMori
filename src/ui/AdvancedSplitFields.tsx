import { uuid } from "expo";
import { useContext, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from "react-native";
import type { ChargeDistribution } from "../domain/charges.ts";
import type { EditorField, EditorHost, EditorItem, EditorMember, QuickSplitEditorState } from "../services/quickSplitEditor.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";
import { usePro, useProSnapshot } from "./ProContext.ts";
import { advancedSplitCopy } from "./advancedSplitCopy.ts";
import { colors } from "./visuals.tsx";

type FieldsProps = {
  editor: QuickSplitEditorState;
  participants: readonly EditorMember[];
  update: (patch: Partial<QuickSplitEditorState>) => void;
  error: (field: EditorField, memberId?: string) => string | undefined;
  onFocus: () => void;
};

export function useAdvancedSplitAction() {
  const language = useContext(AppLanguageContext);
  const copy = advancedSplitCopy(language);
  const { openPro, hasProAccess } = usePro();
  return (title: string, action: () => void) => {
    if (hasProAccess()) action();
    else Alert.alert(title, copy.locked, [
      { text: copy.cancel, style: "cancel" }, { text: copy.upgrade, onPress: () => openPro() },
    ]);
  };
}

function Button({ label, action, selected }: { label: string; action: () => void; selected?: boolean }) {
  return <Pressable accessibilityRole={selected === undefined ? "button" : "checkbox"}
    accessibilityState={selected === undefined ? undefined : { checked: selected }} onPress={action}
    style={({ pressed }) => [styles.button, selected && styles.selected, pressed && styles.pressed]}>
    <Text style={[styles.label, selected && styles.inverse]}>{label}</Text>
  </Pressable>;
}

function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput {...props} accessibilityLabel={label} style={styles.input} />
    <ErrorNote text={error} />
  </View>;
}

function ErrorNote({ text }: { text?: string }) {
  return text ? <Text accessibilityRole="alert" style={styles.caption}>{text}</Text> : null;
}

const toggled = (ids: readonly string[], id: string) => ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
const newHost: EditorHost = { coverKind: "fixed", coverAmount: "", coverPercentage: "", includeHostInRemainder: false };

export function AdvancedMethodFields({ editor, participants, update, error, onFocus }: FieldsProps) {
  const copy = advancedSplitCopy(useContext(AppLanguageContext));
  const { hasProAccess } = useProSnapshot();
  const authorize = useAdvancedSplitAction();
  const name = (member: EditorMember, index: number) => member.displayName.trim() || copy.member(index);
  const eligible = new Set(participants.map(({ id }) => id));
  const people = (ids: readonly string[], choose: (id: string) => void, showExcluded = false) => (
    <View style={styles.choices}>{editor.members.map((member, index) => {
      const selected = ids.includes(member.id);
      if (!eligible.has(member.id) && !(showExcluded && selected)) return null;
      return <Button key={member.id} label={eligible.has(member.id) ? name(member, index) : `${name(member, index)} · ${copy.excluded}`}
        selected={selected} action={() => choose(member.id)} />;
    })}</View>
  );

  if (editor.mode === "custom") {
    const kind = editor.customKind ?? "fixed";
    return <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>{copy.custom}</Text>
      {hasProAccess ? <>
        <View style={styles.choices}>{(["fixed", "percentage", "shares"] as const).map((key) =>
          <Button key={key} label={copy[key]} selected={kind === key} action={() => {
            if (kind !== key) update({ customKind: key, customValues: {} });
          }} />)}</View>
        {participants.map((member, index) => <Field key={member.id} label={`${name(member, index)} · ${copy[kind]}`}
          value={editor.customValues?.[member.id] ?? ""} keyboardType={kind === "shares" ? "number-pad" : "decimal-pad"}
          onChangeText={(value) => update({ customValues: { ...editor.customValues, [member.id]: value } })}
          onFocus={onFocus} error={error("custom", member.id)} />)}
      </> : <Button label={copy.upgrade} action={() => authorize(copy.custom, () => {})} />}
      <ErrorNote text={error("custom") ?? (!hasProAccess ? copy.locked : undefined)} />
    </View>;
  }

  if (editor.mode === "treat") {
    const hosts = editor.extraHosts ?? [];
    function editHost(index: number, patch: Partial<EditorHost>) {
      update({ extraHosts: hosts.map((host, row) => row === index ? { ...host, ...patch } : host) });
    }
    return <View style={styles.section}>
      {hasProAccess && hosts.map((host, index) => <View key={index} style={styles.rowCard}>
        <Text style={styles.heading}>{copy.host} {index + 2}</Text>
        {people(host.hostId ? [host.hostId] : [], (hostId) => editHost(index, { hostId }))}
        <View style={styles.choices}>
          <Button label={copy.fixed} selected={host.coverKind === "fixed"} action={() => editHost(index, { coverKind: "fixed" })} />
          <Button label={copy.percentage} selected={host.coverKind === "percentage"} action={() => editHost(index, { coverKind: "percentage" })} />
        </View>
        <Field label={copy[host.coverKind]} value={host.coverKind === "fixed" ? host.coverAmount : host.coverPercentage}
          onChangeText={(value) => editHost(index, host.coverKind === "fixed" ? { coverAmount: value } : { coverPercentage: value })}
          keyboardType="decimal-pad" onFocus={onFocus} />
        <View style={styles.switchRow}>
          <Text style={[styles.label, styles.fill]}>{copy.remainder}</Text>
          <Switch accessibilityLabel={copy.remainder} value={host.includeHostInRemainder}
            onValueChange={(includeHostInRemainder) => editHost(index, { includeHostInRemainder })} trackColor={{ true: colors.ink }} />
        </View>
        <Button label={`${copy.remove} · ${copy.host} ${index + 2}`} action={() => update({ extraHosts: hosts.filter((_, row) => row !== index) })} />
      </View>)}
      <Button label={hasProAccess ? copy.addHost : `${copy.addHost} · Pro`}
        action={() => authorize(copy.addHost, () => update({ extraHosts: [...hosts, newHost] }))} />
      {!hasProAccess && hosts.length > 0 && <Button label={copy.oneHost} action={() => update({ extraHosts: [] })} />}
      <ErrorNote text={error("hosts") ?? (!hasProAccess && hosts.length > 0 ? copy.locked : undefined)} />
    </View>;
  }

  if (editor.mode !== "individual") return null;
  const items = editor.items ?? [];
  const blankItem = (): EditorItem => ({ id: uuid.v4(), name: "", quantity: "1", amount: "", memberIds: participants.map(({ id }) => id) });
  function editItem(id: string, patch: Partial<EditorItem>) {
    update({ items: items.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }
  return <View style={styles.section}>
    {editor.itemized ? <>
      <Button label={copy.byPerson} action={() => update({ itemized: false })} />
      {hasProAccess && <>
        <Text style={styles.caption}>{copy.itemHelp}</Text>
        {items.map((item, index) => <View key={item.id} style={styles.rowCard}>
          <Text style={styles.heading}>{copy.item} {index + 1}</Text>
          <Field label={copy.itemName} value={item.name} onChangeText={(value) => editItem(item.id, { name: value })} onFocus={onFocus} />
          <Field label={copy.quantity} value={item.quantity} keyboardType="number-pad" onFocus={onFocus}
            onChangeText={(quantity) => editItem(item.id, { quantity })} />
          <Field label={copy.itemTotal} value={item.amount} keyboardType="decimal-pad" onFocus={onFocus}
            onChangeText={(amount) => editItem(item.id, { amount })} />
          <Text style={styles.label}>{copy.participants}</Text>
          {people(item.memberIds, (id) => editItem(item.id, { memberIds: toggled(item.memberIds, id) }), true)}
          <Button label={`${copy.remove} · ${copy.item} ${index + 1}`} action={() => update({ items: items.filter(({ id }) => id !== item.id) })} />
        </View>)}
        <Button label={copy.addItem} action={() => update({ items: [...items, blankItem()] })} />
      </>}
    </> : <Button label={hasProAccess ? copy.itemize : `${copy.itemize} · Pro`}
      action={() => authorize(copy.itemize, () => update({ itemized: true, items: items.length ? items : [blankItem()] }))} />}
    <ErrorNote text={error("items") ?? (!hasProAccess && editor.itemized ? copy.locked : undefined)} />
  </View>;
}

export function AdvancedChargeFields({ editor, participants, update, error }: Omit<FieldsProps, "onFocus">) {
  const copy = advancedSplitCopy(useContext(AppLanguageContext));
  const { hasProAccess } = useProSnapshot();
  const authorize = useAdvancedSplitAction();
  const [expanded, setExpanded] = useState(false);
  const configured = !!(editor.feeDistribution || editor.discountDistribution);
  if (editor.mode !== "equal" && editor.mode !== "individual") return null;
  const eligible = new Set(participants.map(({ id }) => id));

  function distributionField(field: "feeDistribution" | "discountDistribution", label: string) {
    const rule = editor[field];
    function select(kind: "proportional" | ChargeDistribution["kind"]) {
      if (kind === (rule?.kind ?? "proportional")) return;
      update({ [field]: kind === "proportional" ? undefined : kind === "equal" ? { kind } : { kind, memberIds: [] } });
    }
    return <View style={styles.rowCard}>
      <Text style={styles.heading}>{label}</Text>
      <View style={styles.choices}>{(["proportional", "equal", "selected"] as const).map((kind) =>
        <Button key={kind} label={copy[kind]} selected={(rule?.kind ?? "proportional") === kind} action={() => select(kind)} />)}</View>
      {rule?.kind === "selected" && <View style={styles.choices}>{editor.members.map((member, index) => {
        const selected = rule.memberIds.includes(member.id);
        const available = eligible.has(member.id);
        if (!available && !selected) return null;
        const name = member.displayName.trim() || copy.member(index);
        return <Button key={member.id} label={available ? name : `${name} · ${copy.excluded}`} selected={selected}
          action={() => update({ [field]: { ...rule, memberIds: toggled(rule.memberIds, member.id) } })} />;
      })}</View>}
    </View>;
  }
  return <View style={styles.section}>
    <Button label={hasProAccess ? copy.charge : `${copy.charge} · Pro`} action={() => authorize(copy.charge, () => setExpanded(true))} />
    {hasProAccess && (expanded || configured) && <>
      {distributionField("feeDistribution", copy.serviceFee)}
      {distributionField("discountDistribution", copy.discount)}
    </>}
    {!hasProAccess && configured && <Button label={copy.defaultDistribution}
      action={() => update({ feeDistribution: undefined, discountDistribution: undefined })} />}
    <ErrorNote text={error("chargeDistribution") ?? (!hasProAccess && configured ? copy.locked : undefined)} />
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  rowCard: { gap: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.line },
  heading: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  label: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 10 },
  selected: { backgroundColor: colors.ink, borderColor: colors.ink },
  inverse: { color: colors.onPrimary },
  pressed: { opacity: 0.65 },
  field: { gap: 4 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 10,
    color: colors.ink, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: 8 },
  fill: { flex: 1 },
});
