import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, AppState, Pressable, RefreshControl, SectionList, StyleSheet, Text, View, type SectionListData,
} from "react-native";
import type { TransferSuggestion } from "../domain/settlement.ts";
import { loadActivitySettlement, type ActivitySettlementData } from "../services/activitySettlement.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { colors, Icon } from "./visuals.tsx";

const tabs = [
  { id: "overview", label: "結算總覽" },
  { id: "members", label: "每人收支" },
  { id: "transfers", label: "轉帳建議" },
] as const;
type Tab = typeof tabs[number]["id"];
type Member = ActivitySettlementData["members"][number];
type SettlementRow =
  | { kind: "member"; id: string; member: Member }
  | ({ kind: "suggestion"; id: string } & TransferSuggestion)
  | ({ kind: "repayment" } & Omit<ActivitySettlementData["repayments"][number], "kind">);
type Section = SectionListData<SettlementRow, { title: string; caption?: string }>;
type FormatMoney = (minor: number | bigint) => string;

const dateFormat = new Intl.DateTimeFormat("zh-HK", { year: "numeric", month: "long", day: "numeric" });

function AmountLine({ label, value, divider = true }: { label: string; value: string; divider?: boolean }) {
  return (
    <View style={[styles.amountRow, styles.amountLine, divider && styles.divider]}>
      <Text style={styles.body}>{label}</Text>
      <Text style={styles.amount}>{value}</Text>
    </View>
  );
}

function FooterButton({ label, onPress, secondary = false, disabled = false }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <View style={styles.footer}>
      <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
        style={({ pressed }) => [styles.footerButton, secondary && styles.secondary, (pressed || disabled) && styles.pressed]}>
        <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
      </Pressable>
    </View>
  );
}

function ActivityHeading({ activity }: { activity: ActivitySettlementData["activity"] }) {
  const date = new Date(activity.createdAt);
  const formattedDate = Number.isNaN(date.getTime()) ? "日期未能讀取" : dateFormat.format(date);
  return (
    <View style={[styles.amountRow, styles.activityHeading]}>
      <View style={styles.memberCopy}>
        <Text accessibilityRole="header" style={styles.activityName}>{activity.name}</Text>
        <Text style={styles.caption}>{formattedDate} · {activity.currency}</Text>
      </View>
      <Text style={[styles.caption, styles.badge]}>{activity.status === "active" ? "進行中" : "已完成"}</Text>
    </View>
  );
}

function SettledMessage() {
  return (
    <View style={styles.settled}>
      <View style={styles.settledIcon}><Icon name="check" size={31} /></View>
      <Text accessibilityRole="header" style={styles.settledTitle}>款項已全部結清</Text>
      <Text style={[styles.caption, styles.center]}>結清狀態與活動是否完成無關。</Text>
    </View>
  );
}

function NoFinancialRecords({ transfers = false }: { transfers?: boolean }) {
  return (
    <View style={[styles.card, styles.empty]}>
      <Text accessibilityRole="header" style={styles.heading}>暫無財務紀錄</Text>
      <Text style={styles.caption}>{transfers ? "新增費用後，即可查看轉帳建議。" : "新增費用後，即可查看成員收支及結算狀態。"}</Text>
    </View>
  );
}

function Overview({ data, money }: { data: ActivitySettlementData; money: FormatMoney }) {
  if (data.status === "empty") return <NoFinancialRecords />;
  if (data.status === "settled") {
    return (
      <View style={styles.contentStack}>
        <SettledMessage />
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>最新結算</Text>
          <AmountLine label={`活動有效費用 · ${data.expenseCount} 筆`} value={money(data.effectiveMinor)} divider={false} />
          <AmountLine label="有效商家退款" value={money(data.refundMinor)} />
          <AmountLine label="已登記成員還款" value={money(data.repaymentMinor)} />
          <AmountLine label="尚待結算" value={money(data.outstandingMinor)} />
          <AmountLine label="轉帳建議" value={`${data.suggestions.length} 筆`} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.contentStack}>
      <View style={styles.card}>
        <Text style={styles.caption}>活動有效費用 · {data.expenseCount} 筆</Text>
        <Text style={styles.heroAmount}>{money(data.effectiveMinor)}</Text>
        <AmountLine label="有效商家退款" value={money(data.refundMinor)} divider={false} />
        <AmountLine label="已登記成員還款" value={money(data.repaymentMinor)} />
      </View>
      <View style={styles.group}>
        <View style={styles.amountRow}>
          <Text accessibilityRole="header" style={styles.heading}>目前結算狀態</Text>
          <Text style={[styles.caption, styles.badge]}>未結清</Text>
        </View>
        <View style={[styles.card, styles.metrics]}>
          <View style={styles.metric}>
            <Text style={[styles.metricValue, styles.center]}>{money(data.outstandingMinor)}</Text>
            <Text style={[styles.caption, styles.center]}>尚待結算</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricValue}>{data.suggestions.length} 筆</Text>
            <Text style={[styles.caption, styles.center]}>轉帳建議</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function TransferOverview({ data, money }: { data: ActivitySettlementData; money: FormatMoney }) {
  if (data.status === "empty") return <NoFinancialRecords transfers />;
  if (data.status === "settled") {
    return (
      <View style={styles.contentStack}>
        <SettledMessage />
        <Text style={[styles.caption, styles.center]}>目前沒有轉帳建議。</Text>
      </View>
    );
  }
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={styles.heading}>尚待轉帳</Text>
      <View style={[styles.card, styles.transferTotal]}>
        <Text style={styles.caption}>依目前帳務自動計算</Text>
        <Text style={styles.heroAmount}>{money(data.outstandingMinor)}</Text>
        <Text style={styles.caption}>共 {data.suggestions.length} 筆建議 · 尚未記錄這些轉帳</Text>
      </View>
    </View>
  );
}

function MemberRow({ member, money, currency, first, last, separate, expanded, onToggle }: {
  member: Member; money: FormatMoney; currency: string; first: boolean; last: boolean;
  separate: boolean; expanded: boolean; onToggle?: () => void;
}) {
  const net = member.netBalanceMinor;
  const direction = net > 0 ? "應收" : net < 0 ? "應付" : "淨額";
  const fullAmount = money(Math.abs(net));
  const memberAmount = fullAmount.slice(currency.length + 1);
  const signedAmount = net === 0 ? fullAmount : `${net > 0 ? "+" : "−"} ${fullAmount}`;
  const header = (
    <>
      <View style={styles.avatar}><Icon name="member" size={17} color={colors.muted} /></View>
      <View style={styles.memberCopy}>
        <Text style={styles.memberName}>{member.displayName}</Text>
        {expanded && <Text style={styles.caption}>{net === 0 ? "已平衡" : direction}</Text>}
      </View>
      <View style={styles.memberAmount}>
        <Text style={expanded ? styles.expandedAmount : net === 0 ? styles.caption : styles.amount}>
          {expanded ? fullAmount : `${direction} ${memberAmount}`}
        </Text>
        {onToggle && <View style={expanded && styles.chevronUp}><Icon name="down" size={14} color={colors.muted} /></View>}
      </View>
    </>
  );

  return (
    <View style={[styles.memberCard, first && styles.firstMemberCard, last && styles.lastMemberCard, separate && styles.separateCard]}>
      {!first && <View style={styles.divider} />}
      {onToggle ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
          accessibilityLabel={`${member.displayName}，${net === 0 ? "淨額" : direction} ${fullAmount}`}
          onPress={onToggle} style={({ pressed }) => [styles.memberHeader, pressed && styles.pressed]}>
          {header}
        </Pressable>
      ) : <View style={styles.memberHeader}>{header}</View>}
      {expanded && (
        <View style={styles.memberDetails}>
          <AmountLine label="實際商家付款" value={money(member.merchantPaidMinor)} />
          <AmountLine label="已收到商家退款" value={money(member.merchantRefundReceivedMinor)} />
          <AmountLine label="應承擔費用" value={money(member.allocatedMinor)} />
          <AmountLine label="已支付成員還款" value={money(member.transferSentMinor)} />
          <AmountLine label="已收到成員還款" value={money(member.transferReceivedMinor)} />
          <View style={[styles.amountRow, styles.netLine]}>
            <Text style={styles.memberName}>目前淨額</Text><Text style={styles.metricValue}>{signedAmount}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

function TransferRow({ from, to, amount, note, onSelect, selected }: {
  from: string; to: string; amount: string; note?: string; onSelect?: () => void; selected?: boolean;
}) {
  const content = (
    <>
      <View style={[styles.amountRow, styles.transferAmountRow]}>
        <View style={styles.memberCopy}>
          <Text style={styles.memberName}>{from} → {to}</Text>
          <Text style={styles.caption}>{onSelect ? `由 ${from} 轉給 ${to}` : "已登記的實際還款"}</Text>
        </View>
        <Text style={styles.metricValue}>{amount}</Text>
      </View>
      {onSelect && <Text style={[styles.caption, styles.suggestionNote]}>此筆為建議，不代表已付款或已登記還款。</Text>}
      {note && <Text style={[styles.caption, styles.suggestionNote]}>備註：{note}</Text>}
    </>
  );
  if (!onSelect) return <View style={[styles.card, styles.transferRow]}>{content}</View>;
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: !!selected }}
    accessibilityLabel={`${from} 轉給 ${to}，${amount}`} onPress={onSelect}
    style={({ pressed }) => [styles.card, styles.transferRow, selected && styles.selectedTransfer, pressed && styles.pressed]}>
    {content}
  </Pressable>;
}

function SettlementContent({ data, tab, setTab, onBack, refreshing, onRefresh, onRecordRepayment }: {
  data: ActivitySettlementData; tab: Tab; setTab: (tab: Tab) => void; onBack: () => void; refreshing: boolean; onRefresh: () => void;
  onRecordRepayment: (suggestion: TransferSuggestion) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null | undefined>();
  const [selectedPair, setSelectedPair] = useState<string>();
  const pairKey = ({ fromMemberId, toMemberId }: TransferSuggestion) => JSON.stringify([fromMemberId, toMemberId]);
  const multipleSuggestions = data.suggestions.length > 1;
  const selectedSuggestion = multipleSuggestions
    ? data.suggestions.find((suggestion) => pairKey(suggestion) === selectedPair) : data.suggestions[0];
  const openMemberId = tab === "members" ? (expandedId === undefined ? data.members[0]?.memberId : expandedId) : null;
  const { currency } = data.activity;
  const money: FormatMoney = (minor) => formatResultMoney(currency, minor);
  const names = new Map(data.members.map(({ memberId, displayName }) => [memberId, displayName]));
  const nameFor = (id: string) => names.get(id) ?? "未知成員";
  const sections: Section[] = [];
  if (tab === "transfers") {
    if (data.suggestions.length > 0) {
      sections.push({
        key: "suggestions", title: "建議付款方向",
        caption: multipleSuggestions ? "請選擇一筆建議，再記錄實際還款。" : undefined,
        data: data.suggestions.map((suggestion) => ({ ...suggestion, kind: "suggestion", id: pairKey(suggestion) })),
      });
    }
  } else {
    if (tab === "overview" && data.status === "settled" && data.repayments.length > 0) {
      sections.push({ key: "repayments", title: "已登記的還款",
        data: data.repayments.map(({ kind: _kind, ...repayment }) => ({ ...repayment, kind: "repayment" })) });
    }
    sections.push({
      key: "members", title: tab === "members" ? "成員收支明細" : "每位成員",
      caption: tab === "members" ? "付款與分攤分開計算。有效退款及已登記還款均計入淨額。" : undefined,
      data: data.members.map((member) => ({ kind: "member", id: member.memberId, member })),
    });
  }

  const header = (
    <View style={styles.contentStack}>
      {tab !== "members" && <ActivityHeading activity={data.activity} />}
      <View accessibilityRole="tablist" style={styles.segmented}>
        {tabs.map(({ id, label }) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }}
            onPress={() => setTab(id)} style={[styles.segment, tab === id && styles.segmentSelected]}>
            <Text style={[styles.segmentText, tab === id && styles.segmentTextSelected]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "overview" && <Overview data={data} money={money} />}
      {tab === "members" && data.status === "empty" && <NoFinancialRecords />}
      {tab === "transfers" && <TransferOverview data={data} money={money} />}
    </View>
  );

  return (
    <>
      <SectionList
        key={tab}
        style={styles.list}
        contentContainerStyle={styles.content}
        sections={sections}
        stickySectionHeadersEnabled={false}
        keyExtractor={(row) => `${row.kind}:${row.id}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />}
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.heading}>{section.title}</Text>
            {section.caption && <Text style={styles.caption}>{section.caption}</Text>}
          </View>
        )}
        renderItem={({ item, index }) => {
          if (item.kind !== "member") {
            return <TransferRow from={nameFor(item.fromMemberId)} to={nameFor(item.toMemberId)}
              amount={money(item.amountMinor)} note={item.kind === "repayment" ? item.note : undefined}
              selected={item.kind === "suggestion" && selectedSuggestion !== undefined && pairKey(selectedSuggestion) === item.id}
              onSelect={item.kind === "suggestion" ? () => setSelectedPair(item.id) : undefined} />;
          }
          const expanded = openMemberId === item.id;
          const first = index === 0 || expanded || data.members[index - 1]?.memberId === openMemberId;
          const last = index === data.members.length - 1 || expanded || data.members[index + 1]?.memberId === openMemberId;
          return <MemberRow member={item.member} money={money} currency={currency} first={first} last={last}
            separate={first && index > 0} expanded={expanded}
            onToggle={tab === "members" ? () => setExpandedId(expanded ? null : item.id) : undefined} />;
        }}
        ListFooterComponent={tab === "transfers" && data.suggestions.length > 0 ? (
          <View style={[styles.contentStack, styles.listNotes]}>
            <View style={styles.notice}>
              <Text style={styles.noteTitle}>重要說明</Text>
              <Text style={styles.caption}>轉帳建議依目前淨額產生。實際轉帳後，須另行記錄還款，帳本才會更新。</Text>
            </View>
            <View style={styles.updateNote}>
              <Text style={styles.noteTitle}>資料如何更新？</Text>
              <Text style={styles.caption}>新增費用、商家退款、費用更正或登記還款後，建議會依最新帳務更新。</Text>
            </View>
          </View>
        ) : undefined}
      />
      {tab === "overview" && data.status === "unsettled" && <FooterButton label="查看轉帳建議" onPress={() => setTab("transfers")} />}
      {tab === "transfers" && data.suggestions.length > 0 && <FooterButton label="記錄還款" disabled={!selectedSuggestion || refreshing}
        onPress={() => { if (selectedSuggestion) onRecordRepayment(selectedSuggestion); }} />}
      {tab !== "members" && data.status !== "unsettled" && <FooterButton label="返回活動詳情" onPress={onBack} secondary />}
    </>
  );
}

export function ActivitySettlementScreen({ activityId, onBack, initialTab = "overview", onRecordRepayment }: {
  activityId: string; onBack: () => void; initialTab?: Tab; onRecordRepayment: (suggestion: TransferSuggestion) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [data, setData] = useState<ActivitySettlementData | null>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setReadError(false);
    try {
      const next = await loadActivitySettlement(activityId);
      if (latest.current === request) setData(next);
    } catch {
      if (latest.current === request) {
        setData(undefined);
        setReadError(true);
      }
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

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回活動詳情" onPress={onBack} style={styles.headerSide}>
          <Icon name="back" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>活動結算</Text>
        <View style={styles.headerSide} />
      </View>
      {data ? <SettlementContent data={data} tab={tab} setTab={setTab} onBack={onBack} refreshing={loading} onRefresh={reload}
        onRecordRepayment={onRecordRepayment} />
        : <View style={[styles.content, styles.group]}>
          {loading && <ActivityIndicator accessibilityLabel="正在讀取結算資料" color={colors.ink} />}
          {readError && <View style={[styles.card, styles.group]}>
            <Text accessibilityRole="alert" style={styles.body}>未能讀取結算資料，請重試。</Text>
            <Pressable accessibilityRole="button" style={styles.retry} onPress={reload}><Text style={styles.amount}>重新讀取</Text></Pressable>
          </View>}
          {data === null && !loading && <Text style={styles.caption}>找不到這個活動。</Text>}
        </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  header: {
    width: "100%", maxWidth: 620, alignSelf: "center", minHeight: 54, paddingHorizontal: 18,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  headerSide: { flex: 1, minHeight: 44, alignItems: "flex-start", justifyContent: "center" },
  title: { color: colors.ink, fontSize: 19, fontWeight: "700", textAlign: "center", flexShrink: 1 },
  list: { flex: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 9, paddingBottom: 16 },
  contentStack: { gap: 14 },
  activityHeading: { paddingTop: 3 },
  activityName: { color: colors.ink, fontSize: 23, fontWeight: "700" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  badge: { backgroundColor: colors.quiet, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line, paddingHorizontal: 10, paddingVertical: 4 },
  segmented: {
    flexDirection: "row", gap: 4, padding: 3, backgroundColor: colors.quiet,
    borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15,
  },
  segment: { flex: 1, minHeight: 44, paddingHorizontal: 4, paddingVertical: 5, alignItems: "center", justifyContent: "center", borderRadius: 11 },
  segmentSelected: { backgroundColor: colors.primary },
  segmentText: { color: colors.muted, fontSize: 14, fontWeight: "600", textAlign: "center" },
  segmentTextSelected: { color: colors.onPrimary },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 17, padding: 15 },
  group: { gap: 9 },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700", flexShrink: 1 },
  heroAmount: { color: colors.ink, fontSize: 29, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 8, marginBottom: 6 },
  amountRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 10, rowGap: 4 },
  amountLine: { minHeight: 41, paddingVertical: 10 },
  body: { color: colors.ink, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  amount: { color: colors.ink, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right", flexShrink: 1 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  metrics: { flexDirection: "row", gap: 10 },
  metric: { flex: 1, minHeight: 67, paddingHorizontal: 6, paddingVertical: 10,
    borderRadius: 12, backgroundColor: colors.quiet, alignItems: "center", justifyContent: "center", gap: 2 },
  metricValue: { color: colors.ink, fontSize: 17, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1 },
  center: { textAlign: "center" },
  sectionHeading: { gap: 7, paddingTop: 19, paddingBottom: 9 },
  memberCard: { backgroundColor: colors.surface, borderColor: colors.line, borderLeftWidth: 1, borderRightWidth: 1, paddingHorizontal: 14 },
  firstMemberCard: { borderTopWidth: 1, borderTopLeftRadius: 17, borderTopRightRadius: 17, paddingTop: 3 },
  lastMemberCard: { borderBottomWidth: 1, borderBottomLeftRadius: 17, borderBottomRightRadius: 17, paddingBottom: 3 },
  separateCard: { marginTop: 12 },
  memberHeader: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 55, paddingVertical: 10 },
  avatar: { width: 33, height: 33, borderRadius: 17, backgroundColor: colors.tile, alignItems: "center", justifyContent: "center" },
  memberCopy: { flex: 1, gap: 3 },
  memberName: { color: colors.ink, fontSize: 15, fontWeight: "700", flexShrink: 1 },
  memberAmount: { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1 },
  expandedAmount: { color: colors.ink, fontSize: 21, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right", flexShrink: 1 },
  chevronUp: { transform: [{ rotate: "180deg" }] },
  memberDetails: { paddingTop: 2, paddingBottom: 11 },
  netLine: { marginTop: 6, borderRadius: 13, paddingVertical: 12, paddingHorizontal: 12, backgroundColor: colors.quiet },
  transferTotal: { gap: 2 },
  transferRow: { marginBottom: 9 },
  selectedTransfer: { borderColor: colors.ink },
  transferAmountRow: { paddingVertical: 5 },
  suggestionNote: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginTop: 10, paddingTop: 9 },
  listNotes: { paddingTop: 3, gap: 10 },
  notice: { backgroundColor: colors.quiet, borderLeftWidth: 2, borderLeftColor: colors.line, padding: 12, gap: 5 },
  updateNote: { backgroundColor: colors.quiet, borderRadius: 13, padding: 12, gap: 5 },
  noteTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  settled: { alignItems: "center", paddingHorizontal: 12, paddingVertical: 17, gap: 9 },
  settledIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.tile, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  settledTitle: { color: colors.ink, fontSize: 22, fontWeight: "700", textAlign: "center" },
  empty: { gap: 5 },
  footer: { paddingHorizontal: 18, paddingTop: 7, paddingBottom: 6, backgroundColor: colors.page },
  footerButton: {
    width: "100%", maxWidth: 584, alignSelf: "center", minHeight: 52, borderRadius: 14, padding: 10,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.primary,
  },
  buttonText: { color: colors.onPrimary, fontSize: 16, fontWeight: "700", textAlign: "center" },
  secondary: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1 },
  secondaryText: { color: colors.ink },
  pressed: { opacity: 0.65 },
  retry: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center" },
});
