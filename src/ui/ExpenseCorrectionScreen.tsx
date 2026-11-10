import { formatUiCount, formatUiDate, splitModeLabel } from "../services/localizedCopy.ts";
import type { Copy } from "../services/localizedCopy.ts";
import { useCopy } from "./useCopy.ts";
import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { expenseEditBlocker, type FinanceExpense, type ReviewedExpenseCorrectionRequest } from "../data/finance.ts";
import { merchantPaymentsOf } from "../domain/balance.ts";
import { calculateCharges } from "../domain/charges.ts";
import type { ChargeDistribution } from "../domain/charges.ts";
import type { Failure } from "../domain/result.ts";
import type { TransferSuggestion } from "../domain/settlement.ts";
import {
  loadExpenseCorrectionPreview, loadExpenseDetail, saveReviewedExpenseCorrection, summarizeCorrectionBalances,
  summarizeExpenseRefunds, type ExpenseDetailData,
} from "../services/expenseDetail.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { hasVerifiedProAccess } from "../services/storeKitExpo.ts";
import { ButtonPair, Card, Compare, Heading, Notice, Row, financeReviewStyles } from "./FinanceReviewUi.tsx";
import { CreateExpenseScreen } from "./CreateExpenseScreen.tsx";
import { MerchantRefundScreen, merchantRefundCopy } from "./MerchantRefundScreen.tsx";
import { usePro, useProSnapshot } from "./ProContext.ts";
import { advancedSplitCopy } from "./advancedSplitCopy.ts";
import { merchantPaymentCopy, merchantPaymentError } from "./merchantPaymentCopy.ts";
import { ConversionButton, ConversionPage, ConversionReadError, memberLabels } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";

type Preview = Extract<Awaited<ReturnType<typeof loadExpenseCorrectionPreview>>, { ok: true }>["value"];
type Reviewed = { preview: Preview; id: string };
type NameFor = (memberId: string) => string;
type Money = (minor: number | bigint) => string;

const label = (t: Copy, expense: FinanceExpense) => expense.name ?? t("未命名費用");
const shares = (expense: FinanceExpense) => new Map(expense.split.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
const describeSplit = (t: Copy, expense: FinanceExpense) => `${splitModeLabel(t, expense.splitMode)} · ${formatUiCount(t, expense.split.allocations.length, "participants")}`;
const paymentSummary = (expense: FinanceExpense, money: Money, nameFor: NameFor) =>
  merchantPaymentsOf(expense).map(({ memberId, amountMinor }) => `${nameFor(memberId)} · ${money(amountMinor)}`).join("\n");

function dateText(t: Copy, timestamp: number) {
  return formatUiDate(t, timestamp);
}

function correctionError(t: Copy, { code, field }: Failure["error"]) {
  switch (code) {
    case "ACTIVITY_COMPLETED": return t("活動已完成，請返回活動詳情重新開啟後再更正費用。");
    case "EXPENSE_EDIT_LIMIT": return t("目前有多於一個進行中的活動。請先完成其他活動，再更正這筆費用。");
    case "UNSUPPORTED_EXPENSE_EDIT": return t("此筆費用使用自訂分攤，目前可查閱歷史資料。");
    case "ACTIVITY_NOT_FOUND":
    case "EXPENSE_NOT_FOUND": return t("找不到這筆活動費用，請返回活動詳情核對。");
    case "EXPENSE_VERSION_CONFLICT": return t("費用版本已更新。請返回費用詳情重新讀取，再核對更正內容。");
    case "CORRECTION_LEDGER_CHANGED": return t("帳本在預覽後已更新。請返回修改並重新預覽。");
    case "REVISION_OUT_OF_ORDER": return t("帳本含日期較晚的事件，請先核對事件日期，再重新預覽。");
    case "REFUND_EXCEEDS_EXPENSE": return t("新帳單金額低於已記錄的有效退款總額。請先核對商家退款記錄。");
    case "REFUND_REDUCTION_EXCEEDS_ALLOCATION": return t("新版分攤不足以承接已記錄的退款減免。請先核對退款及減免對象。");
    case "REFUND_REVIEW_REQUIRED": return t("請重新預覽並確認各筆有效退款及減免分配。");
    case "MEMBER_NOT_PARTICIPATING": return field === "refundReductions"
      ? t("新版分攤缺少已獲退款減免的成員。請核對退款分配。")
      : t("活動成員已更新，請返回費用詳情重新讀取。");
    case "AMOUNT_OVERFLOW": return t("更正後的帳務金額超出上限，請核對費用及分攤。");
    case "REVISION_ID_CONFLICT": return t("更正請求與既有修訂衝突，請重新預覽。");
    default: return t("未能完成費用更正，請核對資料後再試。");
  }
}

function BillDetails({ expense, money, nameFor }: { expense: FinanceExpense; money: Money; nameFor: NameFor }) {
  const t = useCopy();
  const copy = advancedSplitCopy(t.language);
  const input = expense.splitInput;
  if (!input || (input.charges.kind === "finalTotal" && input.method.kind === "equal")) return null;
  const charges = calculateCharges(input.charges);
  const method = input.method;
  const distribution = input.charges.kind === "details" ? input.charges.distribution : undefined;
  const ruleText = (rule: ChargeDistribution) => rule.kind === "equal" ? copy.equal : rule.memberIds.map(nameFor).join(" · ");
  return (
    <>
      <Heading>{copy.details}</Heading>
      <Card>
        {charges.ok && charges.value.kind === "details" && <>
          <Row title={copy.subtotal} value={money(charges.value.subtotal.amountMinor)} divider={false} />
          <Row title={copy.fee} value={money(charges.value.serviceFeeMinor)} />
          <Row title={copy.discountTotal} value={money(charges.value.discountMinor)} />
        </>}
        {distribution?.serviceFee && <Row title={copy.serviceFee} value={ruleText(distribution.serviceFee)} />}
        {distribution?.discount && <Row title={copy.discount} value={ruleText(distribution.discount)} />}
        {method.kind === "treat" && ("hosts" in method.options ? method.options.hosts : [method.options]).map((host) =>
          <Row key={host.hostId} title={`${nameFor(host.hostId)} · ${copy.committed} · ${host.includeHostInRemainder ? copy.sharesRemainder : copy.noRemainder}`}
            value={host.cover.kind === "fixed" ? money(host.cover.amountMinor) : `${host.cover.basisPoints / 100}%`} />)}
        {method.kind === "individual" && "items" in method && method.items.map((item, index) => <View key={index}>
          <Row title={`${item.name} × ${item.quantity}`} value={money(item.amountMinor)} />
          <Row title={copy.participants} value={item.memberIds.map(nameFor).join(" · ")} />
        </View>)}
        {method.kind === "individual" && "personalSpending" in method && <>
          <Row title={t("公共消費")} value={money(method.shared.amountMinor)} />
          {method.shared.memberIds.length > 0 && <Row title={t("公共消費參與者")} value={method.shared.memberIds.map(nameFor).join("、")} />}
          {method.personalSpending.map(({ memberId, personalMinor }) =>
            <Row key={memberId} title={t("{0} · 個人消費", nameFor(memberId))} value={money(personalMinor)} />)}
        </>}
        {method.kind === "custom" && <>
          <Row title={copy.custom} value={copy[method.options.kind]} />
          {method.options.members.map((member) => <Row key={member.memberId} title={nameFor(member.memberId)}
            value={"amountMinor" in member ? money(member.amountMinor)
              : "basisPoints" in member ? `${member.basisPoints / 100}%` : String(member.shares)} />)}
        </>}
      </Card>
    </>
  );
}

function RefundRows({ refunds, money, nameFor }: {
  refunds: Preview["expense"]["refunds"]; money: Money; nameFor: NameFor;
}) {
  const t = useCopy();
  return refunds.map((refund) => (
    <View key={refund.id} style={[styles.line, styles.divider]}>
      <View style={styles.row}>
        <Text style={styles.compareLabel}>{t("{0} 實收退款", nameFor(refund.recipientId))}</Text>
        <Text style={styles.value}>{money(refund.amountMinor)}</Text>
      </View>
      <Text style={styles.caption}>{t("承擔額減免")}{refund.reductions.map(({ memberId, amountMinor }) =>
        `${nameFor(memberId)} ${money(amountMinor)}`).join(" · ")}</Text>
      {"occurredAt" in refund && typeof refund.occurredAt === "number" && <Text style={styles.caption}>{dateText(t, refund.occurredAt)}</Text>}
    </View>
  ));
}

function Detail({ data, money, nameFor, onHistory, onRefundHistory }: {
  data: ExpenseDetailData; money: Money; nameFor: NameFor; onHistory: () => void; onRefundHistory: () => void;
}) {
  const t = useCopy();
  const { language } = t;
  const copy = advancedSplitCopy(language);
  const paymentCopy = merchantPaymentCopy(language);
  const { activity, expense, refunds } = data;
  const { amountMinor, reductions } = summarizeExpenseRefunds(refunds);
  return (
    <>
      <View style={styles.row}>
        <Text style={styles.caption}>{activity.name} · {activity.currency}</Text>
        <Text style={styles.badge}>{activity.status === "active" ? t("進行中") : t("已完成")}</Text>
      </View>
      <Card>
        <View style={styles.row}><Text style={styles.caption}>{t("正式活動費用")}</Text><Text style={styles.badge}>{splitModeLabel(t, expense.splitMode)}</Text></View>
        <Text accessibilityRole="header" style={styles.name}>{label(t, expense)}</Text>
        <Text style={styles.total}>{money(expense.split.total.amountMinor)}</Text>
        <Text style={styles.caption}>{dateText(t, data.expenseDate)} · v{data.currentVersion}</Text>
      </Card>
      {data.editBlocker && <Notice>{data.editBlocker === "PRO_REQUIRED"
        ? merchantPaymentsOf(expense).length > 1 ? paymentCopy.proRequired : copy.locked
        : correctionError(t, { code: data.editBlocker, field: "activityId" })}</Notice>}
      <Heading>{t("付款與分攤")}</Heading>
      <Card>
        <Row title={paymentCopy.paidTotal} value={money(expense.split.total.amountMinor)} divider={false} />
        {merchantPaymentsOf(expense).map(({ memberId, amountMinor }) =>
          <Row key={memberId} title={nameFor(memberId)} value={money(amountMinor)} />)}
        <Row title={t("參與分攤")} value={formatUiCount(t, expense.split.allocations.length, "participants")} />
        {amountMinor > 0 && <Text style={styles.caption}>{t("各人目前承擔（扣除有效退款）")}</Text>}
        {expense.split.allocations.map(({ memberId, amountMinor: share }) =>
          <Row key={memberId} title={nameFor(memberId)} value={money(share - (reductions.get(memberId) ?? 0))} />)}
      </Card>
      <BillDetails expense={expense} money={money} nameFor={nameFor} />
      <Heading>{merchantRefundCopy(t).title}</Heading>
      <Card>
        <Row title={merchantRefundCopy(t).effectiveRefund} value={money(amountMinor)} divider={false} />
        <Row title={merchantRefundCopy(t).effectiveExpense} value={money(expense.split.total.amountMinor - amountMinor)} />
        {data.refundHistory.length === 0 && <Text style={styles.caption}>{merchantRefundCopy(t).noRecords}</Text>}
        <Pressable accessibilityRole="button" onPress={onRefundHistory} style={[styles.row, styles.line, styles.divider]}>
          <Text style={styles.compareLabel}>{merchantRefundCopy(t).viewHistory}</Text>
          <Text style={styles.caption}>{formatUiCount(t, data.refundHistory.length, "records")}</Text>
          <Icon name="next" size={17} color={colors.muted} />
        </Pressable>
      </Card>
      <Heading>{t("相關記錄")}</Heading>
      <Card>
        <Pressable accessibilityRole="button" onPress={onHistory} style={[styles.row, styles.line, styles.divider]}>
          <Text style={styles.compareLabel}>{t("修訂歷史")}</Text><Text style={styles.caption}>{formatUiCount(t, data.versions.length, "revisions")}</Text>
          <Icon name="next" size={17} color={colors.muted} />
        </Pressable>
      </Card>
    </>
  );
}

function Suggestions({ items, nameFor, money }: { items: readonly TransferSuggestion[]; nameFor: NameFor; money: Money }) {
  const t = useCopy();
  if (items.length === 0) return <Text style={styles.caption}>{t("目前無需轉帳")}</Text>;
  return items.map(({ fromMemberId, toMemberId, amountMinor }) => (
    <Row key={JSON.stringify([fromMemberId, toMemberId])}
      title={`${nameFor(fromMemberId)} → ${nameFor(toMemberId)}`} value={money(amountMinor)} />
  ));
}

function Impact({ preview, reviewedRefunds, onReview }: { preview: Preview; reviewedRefunds: boolean; onReview: () => void }) {
  const t = useCopy();
  const paymentCopy = merchantPaymentCopy(t.language);
  const { before, after, expense: { before: oldBill, after: newBill, refunds }, memberChanges, activity } = preview;
  const names = memberLabels(t, activity.members);
  const nameFor = (id: string) => names.get(id) ?? t("未知成員");
  const money: Money = (minor) => formatResultMoney(activity.currency, minor);
  const amount = (minor: number) => money(minor).slice(activity.currency.length + 1);
  const net = (minor: number) => minor === 0 ? amount(0) : `${minor > 0 ? t("應收") : t("應付")} ${amount(Math.abs(minor))}`;
  const oldTotal = summarizeCorrectionBalances(before);
  const newTotal = summarizeCorrectionBalances(after);
  const oldShares = shares(oldBill);
  const newShares = shares(newBill);
  const { amountMinor, reductions } = summarizeExpenseRefunds(refunds);
  const shownMembers = activity.members.filter(({ id }) => oldShares.has(id) || newShares.has(id));
  const beforeExpense = before.effectiveExpenses.find(({ expenseId }) => expenseId === oldBill.id);
  const afterExpense = after.effectiveExpenses.find(({ expenseId }) => expenseId === oldBill.id);
  return (
    <>
      <Notice>{t("請核對本筆費用、全體成員淨額與轉帳建議。提交會新增一個費用版本。")}</Notice>
      <Card>
        <Text style={styles.caption}>{label(t, oldBill)}{" " + t("· 正式費用")}</Text>
        <View style={styles.compareHeader}>
          <View style={styles.compareBox}>
            <Text style={styles.caption}>{t("更正前")}</Text>
            <Text style={styles.boxAmount}>{money(oldBill.split.total.amountMinor)}</Text>
            <Text style={styles.caption}>{describeSplit(t, oldBill)}</Text>
          </View>
          <Text style={styles.caption}>→</Text>
          <View style={styles.compareBox}>
            <Text style={styles.caption}>{t("更正後")}</Text>
            <Text style={styles.boxAmount}>{money(newBill.split.total.amountMinor)}</Text>
            <Text style={styles.caption}>{describeSplit(t, newBill)}</Text>
          </View>
        </View>
        <Compare title={t("活動有效費用")} before={money(oldTotal.effectiveMinor)} after={money(newTotal.effectiveMinor)} />
      </Card>
      <Heading>{t("本筆分攤 · 更正前後")}</Heading>
      <Card>
        {shownMembers.map(({ id }) => {
          const original = oldShares.get(id) ?? 0;
          const proposed = newShares.get(id) ?? 0;
          const reduction = reductions.get(id) ?? 0;
          return <View key={id}>
            <Compare inline title={nameFor(id)} before={oldShares.has(id) ? amount(original) : t("未參與")}
              after={newShares.has(id) ? amount(proposed) : t("未參與")} />
            {reduction > 0 && <Compare title={t("扣除退款後承擔")} before={money(original - reduction)} after={money(proposed - reduction)} />}
          </View>;
        })}
        <Row title={t("原始分攤合計")} value={money(newBill.split.total.amountMinor)} />
        <Text style={styles.caption}>{t("各列以 {0} 顯示。", activity.currency)}</Text>
      </Card>
      <Heading>{t("整個活動 · 最新淨額")}</Heading>
      <Card>
        {memberChanges.map(({ memberId, beforeNetBalanceMinor, afterNetBalanceMinor }) => (
          <Compare inline key={memberId} title={nameFor(memberId)} before={net(beforeNetBalanceMinor)} after={net(afterNetBalanceMinor)} />
        ))}
        <Compare title={t("尚待結算")} before={money(oldTotal.outstandingMinor)} after={money(newTotal.outstandingMinor)} />
      </Card>
      <Heading>{t("本筆費用 · 付款與帳單")}</Heading>
      <Card>
        {label(t, oldBill) !== label(t, newBill) && <Compare title={t("費用名稱")} before={label(t, oldBill)} after={label(t, newBill)} />}
        <Compare title={t("費用日期")} before={dateText(t, preview.beforeDate)} after={dateText(t, preview.afterDate)} />
        <Compare title={paymentCopy.paid} before={paymentSummary(oldBill, money, nameFor)} after={paymentSummary(newBill, money, nameFor)} />
        <Row title={t("本筆有效商家退款")} value={money(amountMinor)} />
        {beforeExpense && afterExpense && <Compare title={t("本筆有效費用")} before={money(beforeExpense.effectiveTotalMinor)}
          after={money(afterExpense.effectiveTotalMinor)} />}
      </Card>
      <Heading>{t("轉帳建議")}</Heading>
      <Card>
        <Text style={styles.compareLabel}>{t("更正前")}</Text><Suggestions items={preview.beforeSuggestions} money={money} nameFor={nameFor} />
        <Text style={styles.compareLabel}>{t("更正後")}</Text><Suggestions items={preview.suggestions} money={money} nameFor={nameFor} />
        <Text style={styles.caption}>{t("以上為結算建議。已登記的實際還款仍按原記錄計入。")}</Text>
      </Card>
      <Heading>{t("有效退款與還款")}</Heading>
      <Card>
        <Compare title={t("全活動有效商家退款")} before={money(oldTotal.refundMinor)} after={money(newTotal.refundMinor)} />
        <Compare title={t("全活動有效成員還款")} before={money(oldTotal.repaymentMinor)} after={money(newTotal.repaymentMinor)} />
        {refunds.length > 0 && <>
          <Row title={t("本筆累計有效退款")} value={money(amountMinor)} />
          <RefundRows refunds={refunds} money={money} nameFor={nameFor} />
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: reviewedRefunds }} onPress={onReview}
            style={[styles.reviewRow, styles.line, styles.divider]}>
            <View style={[styles.checkbox, reviewedRefunds && styles.checked]}>
              {reviewedRefunds && <Icon name="check" size={14} color={colors.onPrimary} />}
            </View>
            <Text style={styles.compareLabel}>{t("我已核對退款接收者及各人的減免分配")}</Text>
          </Pressable>
        </>}
      </Card>
    </>
  );
}

function History({ data, saved, money, nameFor }: {
  data: ExpenseDetailData; saved: boolean; money: Money; nameFor: NameFor;
}) {
  const t = useCopy();
  const paymentCopy = merchantPaymentCopy(t.language);
  const [expanded, setExpanded] = useState<number>();
  const originalDate = data.versions[0]?.occurredAt ?? data.expenseDate;
  return (
    <>
      {saved && <Notice>{t("更正已儲存。活動結算已更新，舊版本仍可查閱。")}</Notice>}
      <Card>
        <View style={styles.row}><Text style={styles.caption}>{label(t, data.expense)}{" " + t("· 最新版本")}</Text><Text style={styles.badge}>v{data.currentVersion}</Text></View>
        <Text style={styles.total}>{money(data.expense.split.total.amountMinor)}</Text>
        <Text style={styles.caption}>{describeSplit(t, data.expense)}</Text>
        <Text style={styles.caption}>{paymentSummary(data.expense, money, nameFor)}</Text>
      </Card>
      <Heading>{t("修訂歷史")}</Heading>
      {[...data.versions].reverse().map(({ expense, id, version, occurredAt }, index) => {
        const previous = data.versions[data.versions.length - index - 2]?.expense;
        const oldShares = previous && shares(previous);
        const newShares = shares(expense);
        const memberIds = new Set([...(oldShares?.keys() ?? []), ...newShares.keys()]);
        const changed = [...memberIds].filter((memberId) => oldShares?.get(memberId) !== newShares.get(memberId));
        return (
          <Card key={id}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded === version }}
              onPress={() => setExpanded(expanded === version ? undefined : version)} style={styles.revisionHeading}>
              <View style={styles.row}>
                <Text style={styles.compareLabel}>v{version} · {version === 1 ? t("原始費用") : t("已確認修訂")}</Text>
                <Text style={styles.badge}>{version === data.currentVersion ? t("最新") : t("保留")}</Text>
              </View>
              <Text style={styles.caption}>{dateText(t, occurredAt)} · {label(t, expense)}</Text>
              <Text style={styles.caption}>{previous ? t("{0} 人 → ", previous.split.allocations.length) : ""}
                {describeSplit(t, expense)} · {money(expense.split.total.amountMinor)}</Text>
              {previous && <Text style={styles.caption}>
                {previous.split.total.amountMinor === expense.split.total.amountMinor ? t("總額不變") : t("原總額 {0}", money(previous.split.total.amountMinor))}
                {changed.length ? t(" · {0} 位成員分攤變更", changed.length) : t(" · 分攤不變")}
              </Text>}
              <Icon name="down" size={15} color={colors.muted} />
            </Pressable>
            {expanded === version && <>
              {previous && label(t, previous) !== label(t, expense) && <Compare title={t("名稱")} before={label(t, previous)} after={label(t, expense)} />}
              {previous ? <Compare title={t("費用日期")} before={dateText(t, previous.expenseDate ?? originalDate)}
                after={dateText(t, expense.expenseDate ?? originalDate)} />
                : <Row title={t("費用日期")} value={dateText(t, expense.expenseDate ?? originalDate)} />}
              {previous ? <Compare title={paymentCopy.paid} before={paymentSummary(previous, money, nameFor)}
                after={paymentSummary(expense, money, nameFor)} /> : <Row title={paymentCopy.paid} value={paymentSummary(expense, money, nameFor)} />}
              {previous && <Compare title={t("分帳方式")} before={splitModeLabel(t, previous.splitMode)} after={splitModeLabel(t, expense.splitMode)} />}
              <Row title={paymentCopy.paidTotal} value={money(expense.split.total.amountMinor)} />
              {[...memberIds].map((memberId) => oldShares
                ? <Compare key={memberId} title={nameFor(memberId)}
                  before={oldShares.has(memberId) ? money(oldShares.get(memberId)!) : t("未參與")}
                  after={newShares.has(memberId) ? money(newShares.get(memberId)!) : t("未參與")} />
                : <Row key={memberId} title={nameFor(memberId)} value={money(newShares.get(memberId)!)} />)}
            </>}
          </Card>
        );
      })}
      <Notice>{t("歷史版本供查閱。各版本的分攤金額為該次保存的帳單分攤。")}</Notice>
    </>
  );
}

export function ExpenseCorrectionScreen({ activityId, expenseId, onBack, onViewSettlement }: {
  activityId: string; expenseId: string; onBack: () => void; onViewSettlement: () => void;
}) {
  const t = useCopy();
  const { hasProAccess, openPro } = usePro();
  const { language } = t;
  const copy = advancedSplitCopy(language);
  const paymentCopy = merchantPaymentCopy(language);
  const pro = useProSnapshot();
  const [loadedData, setData] = useState<ExpenseDetailData | null>();
  const data = loadedData && { ...loadedData,
    editBlocker: expenseEditBlocker(loadedData.activity.status, loadedData.activeCount, loadedData.expense, pro.hasProAccess, pro.status === "pro") };
  const [page, setPage] = useState<"detail" | "edit" | "history">("detail");
  const [refundRoute, setRefundRoute] = useState<"register" | "history">();
  const [saved, setSaved] = useState(false);
  const [readError, setReadError] = useState(false);
  const [review, setReview] = useState<Reviewed>();
  const [reviewedRefunds, setReviewedRefunds] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [retry, setRetry] = useState<"write" | "verify">();
  const [error, setError] = useState<string>();
  const request = useRef<ReviewedExpenseCorrectionRequest>(undefined);
  const pending = useRef(false);
  const readId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++readId.current;
    setData(undefined);
    setReadError(false);
    try {
      const result = await loadExpenseDetail(activityId, expenseId);
      if (id === readId.current) setData(result);
    } catch {
      if (id === readId.current) setReadError(true);
    }
  }, [activityId, expenseId]);

  useEffect(() => {
    void reload();
    return () => { readId.current++; };
  }, [reload]);

  async function openPreview(proposed: FinanceExpense) {
    if (!data) return t("請先重新讀取費用。");
    const result = await loadExpenseCorrectionPreview(activityId, proposed, data.currentVersion, undefined, hasProAccess, hasVerifiedProAccess);
    if (!result.ok) return result.error.field === "merchantPayment" ? merchantPaymentError(result.error.code, paymentCopy)
      : result.error.code === "PRO_REQUIRED" ? copy.locked : correctionError(t, result.error);
    request.current = undefined;
    setBlocked(false);
    setRetry(undefined);
    setError(undefined);
    setReviewedRefunds(false);
    setReview({ preview: result.value, id: uuid.v4() });
  }

  function closePreview() {
    if (pending.current) return;
    if (retry === "verify") onBack();
    else setReview(undefined);
  }

  async function commit() {
    if (pending.current || blocked || !review) return;
    const { preview, id } = review;
    if (retry !== "verify" && preview.expense.refunds.length && !reviewedRefunds) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    request.current ??= {
      expenseId, revisionId: id, expectedVersion: preview.currentVersion, expectedLedger: preview.ledgerToken,
      occurredAt: Date.now(), proposed: preview.expense.after, reviewedRefundIds: preview.expense.refunds.map(({ id }) => id),
    };
    try {
      const result = await saveReviewedExpenseCorrection(activityId, request.current,
        { verifyOnly: retry === "verify", hasProAccess, hasVerifiedProAccess });
      if (result.status === "saved") {
        setReview(undefined);
        setSaved(true);
        setPage("history");
        void reload();
      } else if (result.status === "rejected") {
        setBlocked(true);
        setError(result.error.field === "merchantPayment" ? merchantPaymentError(result.error.code, paymentCopy)
          : result.error.code === "PRO_REQUIRED" ? copy.locked : correctionError(t, result.error));
      } else if (result.status === "notSaved") {
        setRetry("write");
        setError(t("已確認這次更正未入帳。可以重試儲存。"));
      } else {
        setRetry("verify");
        setError(t("暫時無法確認儲存結果。請先查詢這次修訂。"));
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  if (refundRoute) {
    return <MerchantRefundScreen activityId={activityId} expenseId={expenseId} entryPoint={refundRoute}
      onBack={() => { setRefundRoute(undefined); void reload(); }} />;
  }

  if (page === "edit" && data) {
    return (
      <>
        <CreateExpenseScreen activityId={activityId} onBack={() => { setPage("detail"); void reload(); }} edit={{
          activity: data.activity, original: data.expense, originalDate: data.expenseDate,
          name: data.expense.name ?? "", hidden: review !== undefined, onPreview: openPreview,
        }} />
        {review && <ConversionPage title={t("更正影響預覽")} onBack={closePreview} busy={saving} footer={<>
          {error && <Notice alert>{error}</Notice>}
          <ButtonPair secondary={{ label: retry === "verify" ? t("返回活動詳情") : t("返回修改"), action: closePreview, disabled: saving }} primary={{
            label: retry === "verify" ? (saving ? t("正在查詢…") : t("查詢儲存結果"))
              : saving ? t("正在儲存…") : retry === "write" ? t("重試更正") : t("確認更正"),
            action: () => { void commit(); },
            disabled: blocked || saving || (retry !== "verify" && review.preview.expense.refunds.length > 0 && !reviewedRefunds),
          }} />
        </>}>
          <Impact preview={review.preview} reviewedRefunds={reviewedRefunds} onReview={() => setReviewedRefunds((value) => !value)} />
        </ConversionPage>}
      </>
    );
  }

  const money: Money = (minor) => data ? formatResultMoney(data.activity.currency, minor) : "";
  const names = memberLabels(t, data?.activity.members ?? []);
  const nameFor = (id: string) => names.get(id) ?? t("未知成員");
  const canRegister = data?.activity.status === "active"
    && data.expense.split.total.amountMinor > summarizeExpenseRefunds(data.refunds).amountMinor;
  return (
    <ConversionPage key={page} title={page === "history" ? t("修訂歷史") : t("費用詳情")}
      onBack={page === "history" ? () => setPage("detail") : onBack}
      endAction={page === "detail" && data && (!data.editBlocker || data.editBlocker === "PRO_REQUIRED") ? {
        label: data.editBlocker ? copy.upgrade : t("更多費用操作"),
        onPress: () => data.editBlocker ? openPro() : Alert.alert(t("費用操作"), undefined, [
          { text: t("更正費用"), onPress: () => setPage("edit") }, { text: t("取消"), style: "cancel" },
        ]),
      } : undefined}
      footer={data && (page === "history"
        ? <ConversionButton label={t("返回活動結算")} onPress={onViewSettlement} />
        : <ButtonPair secondary={{ label: t("修訂歷史"), action: () => setPage("history") }}
          primary={{ label: canRegister ? merchantRefundCopy(t).register : merchantRefundCopy(t).viewHistory,
            action: () => setRefundRoute(canRegister ? "register" : "history") }} />)}>
      {data ? (page === "history" ? <History data={data} saved={saved} money={money} nameFor={nameFor} />
        : <Detail data={data} money={money} nameFor={nameFor} onHistory={() => setPage("history")}
          onRefundHistory={() => setRefundRoute("history")} />)
        : readError ? <>
          {saved && <Notice>{t("更正已儲存。暫時無法讀取最新詳情。")}</Notice>}
          <ConversionReadError retry={() => { void reload(); }} />
        </>
        : data === null ? <Notice>{t("找不到這筆活動費用。")}</Notice>
        : <ActivityIndicator accessibilityLabel={t("正在讀取費用")} color={colors.ink} />}
    </ConversionPage>
  );
}

const styles = StyleSheet.create({
  ...financeReviewStyles,
  name: { color: colors.ink, fontSize: 22, fontWeight: "700", marginTop: 3 },
  reviewRow: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44 },
  checkbox: { width: 21, height: 21, borderColor: colors.muted, borderWidth: 1, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  checked: { backgroundColor: colors.ink, borderColor: colors.ink },
  revisionHeading: { gap: 5, minHeight: 44 },
});
