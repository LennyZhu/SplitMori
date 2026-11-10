import { formatUiCount, formatUiDate } from "../services/localizedCopy.ts";
import { useCopy } from "./useCopy.ts";
import { useCallback } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { getLocalDatabase } from "../data/database.ts";
import { createQuickSplitRepository } from "../data/quickSplits.ts";
import { usesAdvancedSplit } from "../domain/quickSplit.ts";
import { createQuickSplitConversionService } from "../services/quickSplitConversion.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import {
  ConversionButton, ConversionPage, ConversionReadError, QuickRecordSummary, useConversionRead,
} from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";
import { useAdvancedSplitAction } from "./AdvancedSplitFields.tsx";
import { advancedSplitCopy } from "./advancedSplitCopy.ts";


export function QuickHistoryListScreen({ onRecord }: { onRecord: (id: string) => void }) {
  const t = useCopy();
  const read = useCallback(async () => {
    const result = await createQuickSplitRepository(await getLocalDatabase()).listQuickHistory();
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }, []);
  const { state, retry } = useConversionRead(read);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.list}>
      <Text accessibilityRole="header" style={styles.title}>{t("記錄")}</Text>
      <Text style={styles.label}>{t("已儲存的快速分帳")}</Text>
      {state.status === "loading" && <ActivityIndicator accessibilityLabel={t("正在讀取記錄")} color={colors.ink} />}
      {state.status === "error" && <ConversionReadError retry={retry} />}
      {state.status === "loaded" && (state.value.length === 0
        ? <View style={styles.card}><Text style={styles.caption}>{t("尚未儲存快速分帳記錄。")}</Text></View>
        : state.value.map(({ id, createdAt, snapshot: { split: { total } }, input }) => (
          <Pressable key={id} accessibilityRole="button" onPress={() => onRecord(id)} style={[styles.card, styles.row]}>
            <View style={styles.fill}>
              <Text style={styles.label}>{formatResultMoney(total.currency, total.amountMinor)}</Text>
              <Text style={styles.caption}>{formatUiDate(t, createdAt, "short")} · {formatUiCount(t, input.members.length, "members")}</Text>
            </View>
            <Icon name="next" size={16} color={colors.muted} />
          </Pressable>
        )))}
    </ScrollView>
  );
}

export function QuickHistoryScreen({ historyId, onBack, onConvert, onViewActivity }: {
  historyId: string; onBack: () => void; onConvert: () => void; onViewActivity: (activityId: string) => void;
}) {
  const t = useCopy();
  const { language } = t;
  const authorize = useAdvancedSplitAction();
  const read = useCallback(async () => createQuickSplitConversionService(await getLocalDatabase()).getSource(historyId), [historyId]);
  const { state, retry } = useConversionRead(read);
  const source = state.status === "loaded" ? state.value : undefined;
  const destination = source?.destination;
  const split = source?.history.snapshot.split;
  const allocations = new Map(split?.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));

  return (
    <ConversionPage title={t("快速分帳記錄")} onBack={onBack}
      footer={source && (destination
        ? <ConversionButton label={t("查看活動")} onPress={() => onViewActivity(destination.activityId)} />
        : <ConversionButton label={t("加入活動")} onPress={() => usesAdvancedSplit(source.history.input)
          ? authorize(advancedSplitCopy(language).addToActivity, onConvert) : onConvert()} />)}>
      {state.status === "loading" && <ActivityIndicator accessibilityLabel={t("正在讀取記錄")} color={colors.ink} />}
      {state.status === "error" && <ConversionReadError retry={retry} />}
      {source === null && <Text style={styles.caption}>{t("找不到這筆快速分帳記錄。")}</Text>}
      {source && split && (
        <>
          <QuickRecordSummary history={source.history} destination={destination} />
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.label}>{t("每人應承擔")}</Text>
            {source.history.input.members.map(({ id, displayName }) => (
              <View key={id} style={[styles.row, styles.divider]}>
                <Text style={[styles.body, styles.fill]}>{displayName}</Text>
                <Text style={styles.label}>{formatResultMoney(split.total.currency, allocations.get(id) ?? 0)}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.caption}>{destination ? t("此快速分帳記錄會繼續保留。")
            : t("這只是計算記錄，尚未加入活動帳本。")}</Text>
        </>
      )}
    </ConversionPage>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  list: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 18, paddingTop: 12, paddingBottom: 16, gap: 10 },
  title: { color: colors.ink, fontSize: 22, fontWeight: "700", marginBottom: 4 },
  card: { padding: 13, gap: 5, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingVertical: 8 },
  fill: { flex: 1 },
  label: { color: colors.ink, fontSize: 15, fontWeight: "700", flexShrink: 1 },
  body: { color: colors.ink, fontSize: 14 },
  caption: { color: colors.muted, fontSize: 13 },
});
