import { formatUiCount, formatUiDate } from "../services/localizedCopy.ts";
import { useCopy } from "./useCopy.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { loadActivityList, type ActivitySummary } from "../services/activityList.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { colors, Icon } from "./visuals.tsx";


function ActivityCard({ activity, onPress }: { activity: ActivitySummary; onPress: () => void }) {
  const t = useCopy();
  const active = activity.status === "active";
  const date = new Date(activity.createdAt);
  const status = activity.hasOutstanding ? t("尚未結清") : activity.expenseCount > 0 ? t("已結清") : t("尚無費用");
  const amount = formatResultMoney(activity.total.currency, activity.total.amountMinor);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.cardTop}>
        <Text style={styles.cardName}>{activity.name}</Text>
        {active && <Text style={styles.badge}>{t("進行中")}</Text>}
        {!active && <Text style={styles.historyAmount}>{amount}</Text>}
      </View>
      {active && <Text style={styles.activeAmount}>{amount}</Text>}
      <View style={styles.cardBottom}>
        <Text style={styles.meta}>{formatUiCount(t, activity.memberCount, "members")} · {formatUiCount(t, activity.expenseCount, "expenses")}</Text>
        <View style={styles.status}>
          <Text style={styles.meta}>{status}</Text>
          <Icon name="next" size={14} color={colors.muted} />
        </View>
      </View>
      {!Number.isNaN(date.getTime()) && <Text style={styles.meta}>{formatUiDate(t, date)}</Text>}
    </Pressable>
  );
}

export function ActivityListScreen({ onCreate, onActivity }: {
  onCreate: () => void; onActivity: (activity: ActivitySummary) => void;
}) {
  const t = useCopy();
  const [activities, setActivities] = useState<readonly ActivitySummary[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setError(false);
    try {
      const data = await loadActivityList();
      if (latest.current === request) setActivities(data);
    } catch {
      if (latest.current === request) setError(true);
    } finally {
      if (latest.current === request) setLoading(false);
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
      latest.current += 1;
      subscription.remove();
    };
  }, [reload]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading && activities !== undefined} onRefresh={reload} tintColor={colors.ink} />}
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>{t("活動")}</Text>
        <Pressable accessibilityRole="button" onPress={onCreate} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
          <Icon name="plus" size={17} />
          <Text style={styles.actionText}>{t("建立活動")}</Text>
        </Pressable>
      </View>

      {loading && activities === undefined && (
        <View style={styles.notice}>
          <ActivityIndicator color={colors.ink} />
          <Text accessibilityLiveRegion="polite" style={styles.meta}>{t("正在讀取活動…")}</Text>
        </View>
      )}
      {error && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.meta}>
            {activities ? t("未能更新活動，目前顯示上次讀取的資料。") : t("未能讀取活動。")}
          </Text>
          <Pressable accessibilityRole="button" onPress={reload} style={styles.action}><Text style={styles.actionText}>{t("重試")}</Text></Pressable>
        </View>
      )}
      {activities && (["active", "completed"] as const).map((status) => {
        const rows = activities.filter((item) => item.status === status);
        const active = status === "active";
        return (
          <View key={status} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                {active ? t("進行中") : t("已完成")} <Text style={styles.count}>({rows.length})</Text>
              </Text>
              <Text style={styles.meta}>{active ? t("目前活動") : t("歷史活動")}</Text>
            </View>
            {rows.length === 0 ? (
              <View style={[styles.card, styles.empty]}>
                <Text style={styles.meta}>{active ? t("暫時沒有進行中的活動。") : t("暫時沒有已完成的活動。")}</Text>
              </View>
            ) : rows.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} onPress={() => onActivity(activity)} />
            ))}
          </View>
        );
      })}
      {activities && <Text style={styles.meta}>{t("活動可以包含多筆費用；已完成的活動仍可查看和記錄實際還款。")}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 22, paddingTop: 12, paddingBottom: 20, gap: 20 },
  header: { minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: colors.ink, flexShrink: 1 },
  action: { minHeight: 44, minWidth: 44, flexShrink: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 },
  actionText: { color: colors.ink, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  section: { gap: 9 },
  sectionHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", gap: 6 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: "700" },
  count: { color: colors.muted, fontWeight: "400" },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 14, gap: 6 },
  empty: { minHeight: 59, justifyContent: "center" },
  cardTop: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardName: { color: colors.ink, fontSize: 16, fontWeight: "700", flexShrink: 1 },
  badge: {
    color: colors.muted, fontSize: 12, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12,
    backgroundColor: colors.quiet, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  activeAmount: { fontSize: 26, color: colors.ink, fontWeight: "700", fontVariant: ["tabular-nums"], marginVertical: 4 },
  historyAmount: { fontSize: 16, color: colors.ink, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1 },
  cardBottom: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 5 },
  status: { flexDirection: "row", alignItems: "center", gap: 3 },
  meta: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8 },
  pressed: { opacity: 0.65 },
});
