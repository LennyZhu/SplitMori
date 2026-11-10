import { formatUiDate, splitModeLabel } from "../services/localizedCopy.ts";
import type { Copy } from "../services/localizedCopy.ts";
import { useCopy } from "./useCopy.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator, Alert, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { ActiveActivityLimitError, createActivityRepository, type ActivityCreationBlocker } from "../data/activities.ts";
import { getLocalDatabase } from "../data/database.ts";
import { loadActivityDetail, type ActivityDetailData } from "../services/activityDetail.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { ActivityQuotaSheet } from "./ActivityQuotaSheet.tsx";
import { usePro } from "./ProContext.ts";
import { colors, EmptyActivityMark, Icon, type IconName } from "./visuals.tsx";


function displayDate(t: Copy, timestamp: number) {
  return formatUiDate(t, timestamp);
}

function Action({ title, onPress, icon, primary, disabled }: {
  title: string; onPress: () => void; icon?: IconName; primary?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.action, primary && styles.primary, (pressed || disabled) && styles.pressed]}
    >
      {icon && <Icon name={icon} size={19} color={primary ? colors.onPrimary : colors.ink} />}
      <Text style={[styles.actionText, primary && styles.primaryText]}>{title}</Text>
    </Pressable>
  );
}

function AmountLine({ title, value, strong }: { title: string; value: string; strong?: boolean }) {
  return (
    <View style={[styles.amountRow, strong && styles.totalRow]}>
      <Text style={strong ? styles.strong : styles.text}>{title}</Text>
      <Text style={[strong ? styles.strong : styles.text, styles.number]}>{value}</Text>
    </View>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.amountRow}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

export function ActivityDetailScreen({ activityId, onBack, onViewExisting, onAddExpense, onViewExpense, onManageMembers, onViewSettlement }: {
  activityId: string; onBack: () => void; onViewExisting: (blocker: ActivityCreationBlocker) => void;
  onAddExpense: () => void;
  onViewExpense: (expenseId: string) => void;
  onManageMembers: () => void;
  onViewSettlement: (tab?: "transfers") => void;
}) {
  const t = useCopy();
  const { hasProAccess } = usePro();
  const [data, setData] = useState<ActivityDetailData | null>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [blocker, setBlocker] = useState<ActivityCreationBlocker>();
  const [showHistory, setShowHistory] = useState(false);
  const latest = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await loadActivityDetail(activityId, undefined, t.language);
      if (latest.current === request) setData(next);
    } catch {
      if (latest.current === request) setLoadError(true);
    } finally {
      if (latest.current === request) setLoading(false);
    }
  }, [activityId, t]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; latest.current += 1; };
  }, []);
  useEffect(() => {
    void reload();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && previous !== "active") void reload();
      previous = next;
    });
    return () => subscription.remove();
  }, [reload]);

  async function changeStatus(completing: boolean) {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    setActionError(undefined);
    try {
      const repository = createActivityRepository(await getLocalDatabase(), hasProAccess);
      const updated = await (completing ? repository.completeActivity(activityId) : repository.reopenActivity(activityId));
      if (!mounted.current) return;
      // Keep the newly committed status even if refreshing the ledger fails.
      setData((current) => current && { ...current, activity: { ...current.activity, ...updated } });
      await reload();
    } catch (error) {
      if (mounted.current) {
        if (error instanceof ActiveActivityLimitError) setBlocker(error.blocker);
        else setActionError(completing ? t("未能完成活動，請重新讀取後再試。") : t("未能重新開啟活動，請重新讀取後再試。"));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  function confirmCompletion() {
    if (pending.current) return;
    Alert.alert(t("將活動標記為已完成？"), t("活動完成後仍可查看帳務及記錄還款。現有費用、還款及結算餘額會保留。"), [
      { text: t("取消"), style: "cancel" },
      { text: t("完成活動"), onPress: () => { void changeStatus(true); } },
    ]);
  }

  const active = data?.activity.status === "active";
  const hasExpenses = !!data?.expenses.length;
  const hasOutstanding = (data?.outstandingMinor ?? 0n) > 0n;
  const money = (minor: number | bigint) => data ? formatResultMoney(data.activity.currency, minor) : "";

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("返回")} onPress={onBack} style={styles.headerLeft}>
          <Icon name="back" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.headerTitle}>{t("活動詳情")}</Text>
        <View style={styles.headerRight}>
          {active && <Pressable accessibilityRole="button" accessibilityLabel={t("完成活動")} disabled={working}
            onPress={confirmCompletion} style={styles.iconButton}><Icon name="more" size={24} /></Pressable>}
        </View>
      </View>
      <ScrollView
        style={styles.screen} contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading && data != null} onRefresh={reload} tintColor={colors.ink} />}
      >
        {loading && data == null && <View style={styles.inline}><ActivityIndicator color={colors.ink} /><Text style={styles.caption}>{t("正在讀取活動…")}</Text></View>}
        {(loadError || actionError) && (
          <View style={[styles.card, styles.inset]}>
            <Text accessibilityRole="alert" style={styles.error}>{actionError ?? (data ? t("未能更新活動，目前顯示上次讀取的資料。") : t("未能讀取活動。"))}</Text>
            <Pressable accessibilityRole="button" style={styles.textButton} onPress={() => { setActionError(undefined); void reload(); }}>
              <Text style={styles.link}>{t("重新讀取")}</Text>
            </Pressable>
          </View>
        )}
        {data === null && !loading && !loadError && <Text style={styles.caption}>{t("找不到這個活動。")}</Text>}
        {data && (
          <>
            <View style={styles.hero}>
              <View style={styles.amountRow}>
                <Text style={styles.activityName}>{data.activity.name}</Text>
                <Text style={styles.badge}>{active ? t("進行中") : t("已完成")}</Text>
              </View>
              <View style={styles.inline}>
                <Icon name="calendar" size={16} />
                <Text style={styles.caption}>{displayDate(t, data.activity.createdAt)} · {data.activity.currency}</Text>
              </View>
            </View>
            <View style={[styles.card, styles.metrics]}>
              <View style={styles.metric}><Text style={styles.metricValue}>{data.activity.members.length}</Text><Text style={styles.caption}>{t("成員")}</Text></View>
              <View style={[styles.metric, styles.metricDivider]}><Text style={styles.metricValue}>{data.expenses.length}</Text><Text style={styles.caption}>{t("費用")}</Text></View>
              <View style={[styles.metric, styles.metricAmount, styles.metricDivider]}>
                <Text style={[styles.metricValue, styles.number]}>{money(data.effectiveMinor)}</Text><Text style={styles.caption}>{t("有效總額")}</Text>
              </View>
            </View>
            <View style={[styles.summary, styles.inset]}>
              <AmountLine title={t("原始支出（退款前）")} value={money(data.grossMinor)} />
              <AmountLine title={t("有效商家退款")} value={`${data.refundMinor > 0n ? "− " : ""}${money(data.refundMinor)}`} />
              <AmountLine title={t("有效總額")} value={money(data.effectiveMinor)} strong />
            </View>

            <View style={[styles.summary, styles.inset]}>
              <View style={styles.amountRow}>
                <View style={styles.stateCopy}>
                  <Text style={styles.strong}>{!hasExpenses ? t("暫無財務紀錄")
                    : hasOutstanding ? (active ? t("款項尚未結清") : t("活動已完成 · 款項尚未結清")) : t("已結清")}</Text>
                  <Text style={styles.caption}>{!hasExpenses ? t("新增費用後會更新結算資料。")
                    : hasOutstanding ? t("待結算 {0}", money(data.outstandingMinor)) : t("各成員目前淨額為零。")}</Text>
                </View>
                <Pressable accessibilityRole="button" style={styles.textButton} onPress={() => onViewSettlement()}>
                  <Text style={styles.link}>{t("查看結算")}</Text><Icon name="next" size={14} />
                </Pressable>
              </View>
            </View>

            <Section title={t("成員（{0}）", data.activity.members.length)} action={
              <Pressable accessibilityRole="button" accessibilityLabel={t("管理活動成員")} disabled={working}
                onPress={onManageMembers} hitSlop={8} style={styles.manageButton}>
                <Text style={styles.link}>{t("管理")}</Text><Icon name="next" size={14} />
              </Pressable>
            }>
              <View style={styles.card}>
                {data.activity.members.map(({ id, displayName }, index) => {
                  const net = data.balances.get(id);
                  return (
                    <View key={id} style={[styles.row, index > 0 && styles.divider]}>
                      <View style={styles.tile}><Icon name="member" size={17} /></View>
                      <Text style={[styles.strong, styles.fill]}>{displayName}</Text>
                      {hasExpenses && net !== undefined && <Text style={[styles.caption, styles.number]}>
                        {net === 0 ? t("淨額 ") : net > 0 ? t("應收 ") : t("應付 ")}{money(Math.abs(net))}
                      </Text>}
                    </View>
                  );
                })}
              </View>
            </Section>
            <Section title={t("費用（{0}）", data.expenses.length)}>
              {hasExpenses ? (
                <>
                  <View style={styles.card}>
                    {data.expenses.map((expense, index) => (
                      <Pressable key={expense.id} accessibilityRole="button" accessibilityHint={t("開啟費用詳情")}
                        onPress={() => onViewExpense(expense.id)}
                        style={({ pressed }) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
                        <View style={styles.tile}><Icon name="receipt" size={17} /></View>
                        <View style={styles.fill}>
                          <View style={styles.expenseTitle}>
                            <Text style={styles.strong}>{expense.name}</Text>
                            {expense.refundMinor > 0 && <Text style={styles.refundBadge}>{t("有退款")}</Text>}
                          </View>
                          <Text style={styles.caption}>{expense.payerName}{" " + t("付款 ·") + " "}{splitModeLabel(t, expense.splitMode)}</Text>
                          <Text style={styles.caption}>{displayDate(t, expense.occurredAt)}</Text>
                        </View>
                        <View style={styles.expenseMoney}>
                          <Text style={[styles.strong, styles.number]}>{money(expense.effectiveMinor)}</Text>
                          <Text style={styles.caption}>{t("有效金額")}</Text>
                        </View>
                        <Icon name="next" size={16} color={colors.muted} />
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : (
                <View style={[styles.card, styles.empty]}>
                  <EmptyActivityMark />
                  <Text style={styles.strong}>{t("尚未新增任何費用")}</Text>
                  <Text style={styles.caption}>{active ? t("開始記錄本次活動的共同費用。") : t("這個活動沒有費用紀錄。")}</Text>
                </View>
              )}
            </Section>

            {data.history.length > 0 && (
              <View style={styles.section}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: showHistory }} onPress={() => setShowHistory(!showHistory)}
                  style={styles.textButton}>
                  <Text style={styles.sectionTitle}>{t("財務紀錄（{0}）", data.history.length)}</Text>
                  <Icon name={showHistory ? "down" : "next"} size={16} />
                </Pressable>
                {showHistory && <View style={styles.card}>
                  {data.history.map((event, index) => (
                    <View key={event.id} style={[styles.row, index > 0 && styles.divider]}>
                      <View style={styles.fill}>
                        <Text style={styles.strong}>{event.label}{event.voided ? t(" · 已作廢") : ""}</Text>
                        <Text style={styles.caption}>{displayDate(t, event.occurredAt)}{event.description ? ` · ${event.description}` : ""}</Text>
                      </View>
                      {event.amountMinor !== undefined && <Text style={[styles.text, styles.number]}>{money(event.amountMinor)}</Text>}
                    </View>
                  ))}
                </View>}
              </View>
            )}
          </>
        )}
      </ScrollView>
      {data && (
        <View style={styles.footer}>
          <View style={styles.footerActions}>
            {active ? (
              <>
                {hasExpenses && <Action title={t("查看結算")} onPress={() => onViewSettlement()} />}
                <Action title={t("新增費用")} icon="plus" primary onPress={onAddExpense} disabled={working} />
              </>
            ) : (
              <>
                <Action title={working ? t("正在處理…") : t("重新開啟")} disabled={working} onPress={() => { void changeStatus(false); }} />
                {hasExpenses && <Action title={hasOutstanding ? t("記錄還款") : t("查看結算")} primary
                  onPress={() => onViewSettlement(hasOutstanding ? "transfers" : undefined)} />}
              </>
            )}
          </View>
        </View>
      )}
      {blocker && <ActivityQuotaSheet blocker={blocker} purpose="reopen" onClose={() => setBlocker(undefined)}
        onView={() => { setBlocker(undefined); onViewExisting(blocker); }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { width: "100%", maxWidth: 620, minHeight: 52, alignSelf: "center", flexDirection: "row", alignItems: "center", paddingHorizontal: 15 },
  headerLeft: { flex: 1, minHeight: 44, justifyContent: "center", alignItems: "flex-start" },
  headerRight: { flex: 1, alignItems: "flex-end" },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.ink, fontWeight: "700", fontSize: 17 },
  content: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 9, paddingBottom: 18, gap: 12 },
  hero: { gap: 6 },
  activityName: { color: colors.ink, fontSize: 24, fontWeight: "700", flexShrink: 1 },
  badge: { backgroundColor: colors.quiet, color: colors.ink, fontSize: 13, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 13 },
  summary: { backgroundColor: colors.quiet, borderRadius: 13 },
  metrics: { flexDirection: "row", alignItems: "stretch", paddingVertical: 9 },
  metric: { flex: 1, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", gap: 3 },
  metricAmount: { flex: 2 },
  metricDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  metricValue: { color: colors.ink, fontSize: 16, fontWeight: "700", textAlign: "center" },
  amountRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 7 },
  totalRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: 7 },
  inset: { paddingHorizontal: 13, paddingVertical: 9, gap: 6 },
  stateCopy: { gap: 4, flexShrink: 1 },
  inline: { flexDirection: "row", alignItems: "center", gap: 6 },
  section: { gap: 7, marginTop: 4 },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  textButton: { minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 3 },
  link: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  manageButton: { minWidth: 44, minHeight: 28, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2 },
  row: { minHeight: 44, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  tile: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.quiet },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: 85, gap: 3 },
  expenseTitle: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  expenseMoney: { alignItems: "flex-end", gap: 2 },
  refundBadge: { color: colors.muted, backgroundColor: colors.quiet, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6, fontSize: 11 },
  empty: { alignItems: "center", paddingHorizontal: 12, paddingVertical: 15, gap: 6 },
  text: { color: colors.ink, fontSize: 14, flexShrink: 1 },
  strong: { color: colors.ink, fontSize: 15, fontWeight: "700", flexShrink: 1 },
  caption: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  number: { fontVariant: ["tabular-nums"] },
  error: { color: "#9A372B", fontSize: 14 },
  footer: { backgroundColor: colors.page, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 10 },
  footerActions: { width: "100%", maxWidth: 584, alignSelf: "center", flexDirection: "row", gap: 8 },
  action: {
    flex: 1, minHeight: 48, backgroundColor: colors.surface, borderRadius: 12, borderColor: colors.line, borderWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", padding: 8, gap: 5,
  },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actionText: { color: colors.ink, fontSize: 15, fontWeight: "700", flexShrink: 1, textAlign: "center" },
  primaryText: { color: colors.onPrimary },
  pressed: { opacity: 0.65 },
});
