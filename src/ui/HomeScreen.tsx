import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatAmount, type Currency, type Money } from "../domain/money.ts";
import { loadHomeData, type HomeActivity, type HomeData, type HomeRecentRecord } from "../services/home.ts";
import { colors, EmptyActivityMark, Icon, type IconName } from "./visuals.tsx";

type HomeActions = {
  onSettings: () => void;
  onQuickSplit: () => void;
  onCreateActivity: () => void;
  onActivities: () => void;
  onRecords: () => void;
  onActivity: (activity: HomeActivity) => void;
  onRecord: (record: HomeRecentRecord) => void;
};

const currencySymbols: Record<Currency, string> = {
  HKD: "HK$", CNY: "CN¥", MOP: "MOP$", TWD: "NT$", USD: "US$", JPY: "JP¥",
};

function displayAmount(money: Money) {
  const formatted = formatAmount(money);
  if (!formatted.ok) return "—";
  const [whole, fraction] = formatted.value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function displayDate(timestamp: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今日";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨日";
  return new Intl.DateTimeFormat("zh-HK", {
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "numeric", day: "numeric",
  }).format(date);
}

function SectionHeader({ title, onAll }: { title: string; onAll?: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
      {onAll && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`查看全部${title}`}
          onPress={onAll}
          style={({ pressed }) => [styles.sectionLink, pressed && styles.pressed]}
        >
          <Text style={styles.linkText}>查看全部</Text>
          <Icon name="next" color={colors.accentText} size={15} />
        </Pressable>
      )}
    </View>
  );
}

function ActionButton({ label, onPress, primary = false }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, primary ? styles.primary : styles.secondary, pressed && styles.pressed]}
    >
      <Icon name="plus" color={primary ? colors.white : colors.accentText} size={23} />
      <Text style={[styles.actionText, primary && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

function IconTile({ name }: { name: IconName }) {
  return (
    <View style={styles.tile}>
      <Icon name={name} color={colors.accentText} />
    </View>
  );
}

function ActivityCard({ activity, onPress }: { activity: HomeActivity; onPress: () => void }) {
  const { name, total, memberCount, expenseCount, hasOutstanding } = activity;
  const amount = displayAmount(total);
  const settlement = hasOutstanding ? "未結清" : expenseCount > 0 ? "已結清" : "尚無費用";
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.activityCard, pressed && styles.pressed]}>
      <View style={styles.activityMain}>
        <IconTile name="activity" />
        <View style={styles.activityDetails}>
          <View style={styles.activityTitle}>
            <Text style={styles.activityName}>{name}</Text>
            <View style={styles.badge}><Text style={styles.badgeText}>進行中</Text></View>
          </View>
          <Text style={styles.activityAmount} accessibilityLabel={`${total.currency} ${amount}`}>
            <Text style={styles.activityCurrency}>{currencySymbols[total.currency]} </Text>
            {amount}
          </Text>
        </View>
      </View>
      <View style={styles.activityFooter}>
        <Text style={styles.meta}>{memberCount} 位成員 · {expenseCount} 筆費用</Text>
        <View style={styles.settlement}>
          {hasOutstanding && <View style={styles.dot} />}
          <Text style={hasOutstanding ? styles.outstanding : styles.meta}>{settlement}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function RecentRow({ record, onPress }: { record: HomeRecentRecord; onPress: () => void }) {
  const quick = record.kind === "quick";
  const { total } = record;
  const amount = displayAmount(total);
  const date = displayDate(record.timestamp);
  const activityStatus = !quick && record.hasOutstanding ? "已完成活動 · 未結清" : "已完成活動";
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.recordRow, pressed && styles.pressed]}>
      <IconTile name={quick ? "receipt" : "activity"} />
      <View style={styles.recordBody}>
        <View style={styles.recordDetails}>
          <Text style={styles.recordTitle}>{quick ? "快速分帳" : record.name}</Text>
          <Text style={styles.meta}>{quick ? "快速計算" : activityStatus}{date ? ` · ${date}` : ""}</Text>
        </View>
        <Text style={styles.recordAmount} accessibilityLabel={`${total.currency} ${amount}`}>
          {currencySymbols[total.currency]} {amount}
        </Text>
      </View>
      <Icon name="next" color={colors.accentText} size={15} />
    </Pressable>
  );
}

export function HomeScreen(actions: HomeActions) {
  const [data, setData] = useState<HomeData>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const latestRequest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latestRequest.current;
    setLoading(true);
    setFailed(false);
    try {
      const next = await loadHomeData();
      if (request === latestRequest.current) setData(next);
    } catch {
      if (request === latestRequest.current) setFailed(true);
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") void reload();
      previous = state;
    });
    return () => {
      latestRequest.current += 1;
      subscription.remove();
    };
  }, [reload]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading && data !== undefined} onRefresh={reload} tintColor={colors.accentText} colors={[colors.accentText]} />}
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.wordmark}>SplitMori</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="設定"
          onPress={actions.onSettings}
          style={({ pressed }) => [styles.settings, pressed && styles.pressed]}
        >
          <Icon name="settings" size={23} />
        </Pressable>
      </View>
      <View style={styles.actions}>
        <ActionButton label="開始分帳" primary onPress={actions.onQuickSplit} />
        <ActionButton label="建立活動" onPress={actions.onCreateActivity} />
      </View>

      {failed && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.noticeText}>
            {data ? "未能更新本機資料，目前顯示上次讀取的內容。" : "未能讀取本機資料，請重試。"}
          </Text>
          <Pressable accessibilityRole="button" onPress={reload} style={({ pressed }) => [styles.sectionLink, pressed && styles.pressed]}>
            <Text style={styles.linkText}>重試</Text>
          </Pressable>
        </View>
      )}
      {!data && loading && (
        <View style={styles.notice}>
          <ActivityIndicator color={colors.accentText} />
          <Text accessibilityLiveRegion="polite" style={styles.noticeText}>正在讀取本機資料…</Text>
        </View>
      )}
      {data && (
        <>
          <View style={styles.section}>
            <SectionHeader title="進行中活動" onAll={data.activeActivities.length ? actions.onActivities : undefined} />
            <View style={styles.activityList}>
              {data.activeActivities.length > 0 ? data.activeActivities.map((activity) => (
                <ActivityCard key={activity.id} activity={activity} onPress={() => actions.onActivity(activity)} />
              )) : (
                <View style={styles.emptyActivity}>
                  <EmptyActivityMark />
                  <Text style={styles.emptyTitle}>還沒有進行中的活動</Text>
                  <Text style={styles.emptyCopy}>{"可以先快速分帳，\n也可以建立一個活動，\n記錄聚餐、旅行等共同費用。"}</Text>
                </View>
              )}
            </View>
          </View>
          <View style={styles.section}>
            <SectionHeader title="最近記錄" onAll={data.recentRecords.length ? actions.onRecords : undefined} />
            {data.recentRecords.length > 0 ? data.recentRecords.map((record) => (
              <RecentRow key={`${record.kind}:${record.id}`} record={record} onPress={() => actions.onRecord(record)} />
            )) : (
              <View style={styles.emptyRecord}>
                <Icon name="clock" color={colors.accentText} size={21} />
                <Text style={[styles.meta, styles.emptyRecordText]}>還沒有分帳記錄。輸入金額，就可以開始。</Text>
              </View>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingTop: 10, paddingHorizontal: 26, paddingBottom: 28 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  wordmark: { color: colors.ink, fontSize: 30, fontWeight: "700", letterSpacing: -0.9, flexShrink: 1 },
  settings: {
    width: 46, height: 46, borderRadius: 14, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.quiet, alignItems: "center", justifyContent: "center",
  },
  actions: { marginTop: 28, gap: 12 },
  action: {
    minHeight: 54, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
  },
  primary: { backgroundColor: colors.charcoal, minHeight: 56 },
  secondary: { backgroundColor: colors.quiet, borderWidth: 1, borderColor: colors.outline },
  actionText: { color: colors.charcoal, fontSize: 19, fontWeight: "600", flexShrink: 1 },
  primaryText: { color: colors.white },
  pressed: { opacity: 0.65 },
  section: { marginTop: 26 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 44 },
  heading: { color: colors.ink, fontSize: 20, fontWeight: "700", flexShrink: 1 },
  sectionLink: {
    minHeight: 44, minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 1, flexShrink: 1,
  },
  linkText: { color: colors.accentText, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  activityList: { gap: 10, marginTop: 3 },
  activityCard: {
    minHeight: 136, justifyContent: "space-between", padding: 15, borderRadius: 18,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
    boxShadow: "0 4px 12px rgba(74, 47, 27, 0.07)",
  },
  activityMain: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  tile: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.tile, alignItems: "center", justifyContent: "center" },
  activityDetails: { flex: 1, gap: 6 },
  activityTitle: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 5 },
  activityName: { color: colors.ink, fontSize: 18, fontWeight: "700", flexShrink: 1 },
  badge: { borderRadius: 12, backgroundColor: colors.tile, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { color: colors.accentText, fontSize: 13, fontWeight: "600" },
  activityAmount: { color: colors.ink, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"] },
  activityCurrency: { fontSize: 16, fontWeight: "700" },
  activityFooter: {
    marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6,
  },
  meta: { color: colors.muted, fontSize: 14 },
  settlement: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  outstanding: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  emptyActivity: {
    minHeight: 226, backgroundColor: colors.quiet, borderColor: colors.line, borderWidth: 1, borderRadius: 18,
    paddingHorizontal: 20, paddingVertical: 18, alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { color: colors.ink, fontSize: 19, fontWeight: "700", textAlign: "center", marginTop: 9 },
  emptyCopy: { color: colors.muted, fontSize: 16, textAlign: "center", marginTop: 7 },
  recordRow: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12,
    borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  recordBody: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 7 },
  recordDetails: { flexGrow: 1, flexShrink: 1, flexBasis: 88, gap: 3 },
  recordTitle: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  recordAmount: { color: colors.ink, fontSize: 16, fontWeight: "600", fontVariant: ["tabular-nums"], flexShrink: 1 },
  emptyRecord: {
    minHeight: 60, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 4, paddingVertical: 9,
    borderColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  emptyRecordText: { flex: 1, fontSize: 15 },
  notice: { marginTop: 24, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 6 },
  noticeText: { color: colors.muted, fontSize: 15, flex: 1 },
});
