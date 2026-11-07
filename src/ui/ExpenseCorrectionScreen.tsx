import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { FinanceExpense, ReviewedExpenseCorrectionRequest } from "../data/finance.ts";
import { calculateCharges } from "../domain/charges.ts";
import type { Failure } from "../domain/result.ts";
import type { TransferSuggestion } from "../domain/settlement.ts";
import {
  loadExpenseCorrectionPreview, loadExpenseDetail, saveReviewedExpenseCorrection, summarizeCorrectionBalances,
  summarizeExpenseRefunds, type ExpenseDetailData,
} from "../services/expenseDetail.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { CreateExpenseScreen } from "./CreateExpenseScreen.tsx";
import { ConversionButton, ConversionPage, ConversionReadError, memberLabels } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";

type Preview = Extract<Awaited<ReturnType<typeof loadExpenseCorrectionPreview>>, { ok: true }>["value"];
type Reviewed = { preview: Preview; id: string };
type NameFor = (memberId: string) => string;
type Money = (minor: number | bigint) => string;

const modes = { equal: "平均分攤", treat: "請客", individual: "各自消費", custom: "自訂分攤" } as const;
const dateFormat = new Intl.DateTimeFormat("zh-HK", { year: "numeric", month: "long", day: "numeric" });
const label = (expense: FinanceExpense) => expense.name ?? "未命名費用";
const shares = (expense: FinanceExpense) => new Map(expense.split.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
const describeSplit = (expense: FinanceExpense) => `${modes[expense.splitMode]} · ${expense.split.allocations.length} 人`;

function dateText(timestamp: number) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "日期未能讀取" : dateFormat.format(date);
}

function correctionError({ code, field }: Failure["error"]) {
  switch (code) {
    case "ACTIVITY_COMPLETED": return "活動已完成，請返回活動詳情重新開啟後再更正費用。";
    case "EXPENSE_EDIT_LIMIT": return "目前有多於一個進行中的活動。請先完成其他活動，再更正這筆費用。";
    case "UNSUPPORTED_EXPENSE_EDIT": return "此筆費用使用自訂分攤，目前可查閱歷史資料。";
    case "ACTIVITY_NOT_FOUND":
    case "EXPENSE_NOT_FOUND": return "找不到這筆活動費用，請返回活動詳情核對。";
    case "EXPENSE_VERSION_CONFLICT": return "費用版本已更新。請返回費用詳情重新讀取，再核對更正內容。";
    case "CORRECTION_LEDGER_CHANGED": return "帳本在預覽後已更新。請返回修改並重新預覽。";
    case "REVISION_OUT_OF_ORDER": return "帳本含日期較晚的事件，請先核對事件日期，再重新預覽。";
    case "REFUND_EXCEEDS_EXPENSE": return "新帳單金額低於已記錄的有效退款總額。請先核對商家退款記錄。";
    case "REFUND_REDUCTION_EXCEEDS_ALLOCATION": return "新版分攤不足以承接已記錄的退款減免。請先核對退款及減免對象。";
    case "REFUND_REVIEW_REQUIRED": return "請重新預覽並確認各筆有效退款及減免分配。";
    case "MEMBER_NOT_PARTICIPATING": return field === "refundReductions"
      ? "新版分攤缺少已獲退款減免的成員。請核對退款分配。"
      : "活動成員已更新，請返回費用詳情重新讀取。";
    case "AMOUNT_OVERFLOW": return "更正後的帳務金額超出上限，請核對費用及分攤。";
    case "REVISION_ID_CONFLICT": return "更正請求與既有修訂衝突，請重新預覽。";
    default: return "未能完成費用更正，請核對資料後再試。";
  }
}

function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function Heading({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" style={styles.heading}>{children}</Text>;
}

function Notice({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return <View style={styles.notice}><Text accessibilityRole={alert ? "alert" : undefined} style={styles.caption}>{children}</Text></View>;
}

function Row({ title, value, divider = true }: { title: string; value: string; divider?: boolean }) {
  return (
    <View style={[styles.row, styles.line, divider && styles.divider]}>
      <Text style={styles.caption}>{title}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function Compare({ title, before, after, inline = false }: { title: string; before: string; after: string; inline?: boolean }) {
  return (
    <View style={[styles.line, styles.divider, inline && styles.inline]}>
      <Text style={[styles.compareLabel, inline && styles.inlineLabel]}>{title}</Text>
      <View style={[styles.compareValues, inline && styles.inlineValues]}>
        <Text style={styles.oldValue}>{before}</Text><Text style={styles.caption}>→</Text><Text style={styles.value}>{after}</Text>
      </View>
    </View>
  );
}

function ButtonPair({ secondary, primary }: {
  secondary: { label: string; action: () => void; disabled?: boolean };
  primary: { label: string; action: () => void; disabled?: boolean };
}) {
  return (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: secondary.disabled }}
        disabled={secondary.disabled} onPress={secondary.action}
        style={({ pressed }) => [styles.secondary, (pressed || secondary.disabled) && styles.dimmed]}>
        <Text style={styles.buttonText}>{secondary.label}</Text>
      </Pressable>
      <View style={styles.primary}>
        <ConversionButton label={primary.label} onPress={primary.action} disabled={primary.disabled} />
      </View>
    </View>
  );
}

function BillDetails({ expense, money, nameFor }: { expense: FinanceExpense; money: Money; nameFor: NameFor }) {
  const input = expense.splitInput;
  if (!input || (input.charges.kind === "finalTotal" && input.method.kind !== "treat" && input.method.kind !== "individual")) return null;
  const charges = calculateCharges(input.charges);
  const method = input.method;
  return (
    <>
      <Heading>費用明細</Heading>
      <Card>
        {charges.ok && charges.value.kind === "details" && <>
          <Row title="商品小計" value={money(charges.value.subtotal.amountMinor)} divider={false} />
          <Row title="服務費" value={money(charges.value.serviceFeeMinor)} />
          <Row title="整單折扣" value={money(charges.value.discountMinor)} />
        </>}
        {method.kind === "treat" && <Row title={`${nameFor(method.options.hostId)} 請客 · ${method.options.includeHostInRemainder ? "參與" : "不參與"}餘額分攤`}
          value={method.options.cover.kind === "fixed" ? money(method.options.cover.amountMinor) : `${method.options.cover.basisPoints / 100}%`} />}
        {method.kind === "individual" && <>
          <Row title="公共消費" value={money(method.shared.amountMinor)} />
          {method.shared.memberIds.length > 0 && <Row title="公共消費參與者" value={method.shared.memberIds.map(nameFor).join("、")} />}
          {method.personalSpending.map(({ memberId, personalMinor }) =>
            <Row key={memberId} title={`${nameFor(memberId)} · 個人消費`} value={money(personalMinor)} />)}
        </>}
      </Card>
    </>
  );
}

function RefundRows({ refunds, money, nameFor }: {
  refunds: Preview["expense"]["refunds"]; money: Money; nameFor: NameFor;
}) {
  return refunds.map((refund) => (
    <View key={refund.id} style={[styles.line, styles.divider]}>
      <View style={styles.row}>
        <Text style={styles.compareLabel}>{nameFor(refund.recipientId)} 實收退款</Text>
        <Text style={styles.value}>{money(refund.amountMinor)}</Text>
      </View>
      <Text style={styles.caption}>承擔額減免　{refund.reductions.map(({ memberId, amountMinor }) =>
        `${nameFor(memberId)} ${money(amountMinor)}`).join(" · ")}</Text>
      {"occurredAt" in refund && typeof refund.occurredAt === "number" && <Text style={styles.caption}>{dateText(refund.occurredAt)}</Text>}
    </View>
  ));
}

function Detail({ data, money, nameFor, onHistory }: {
  data: ExpenseDetailData; money: Money; nameFor: NameFor; onHistory: () => void;
}) {
  const { activity, expense, refunds } = data;
  const { amountMinor, reductions } = summarizeExpenseRefunds(refunds);
  return (
    <>
      <View style={styles.row}>
        <Text style={styles.caption}>{activity.name} · {activity.currency}</Text>
        <Text style={styles.badge}>{activity.status === "active" ? "進行中" : "已完成"}</Text>
      </View>
      <Card>
        <View style={styles.row}><Text style={styles.caption}>正式活動費用</Text><Text style={styles.badge}>{modes[expense.splitMode]}</Text></View>
        <Text accessibilityRole="header" style={styles.name}>{label(expense)}</Text>
        <Text style={styles.total}>{money(expense.split.total.amountMinor)}</Text>
        <Text style={styles.caption}>{dateText(data.expenseDate)} · v{data.currentVersion}</Text>
      </Card>
      {data.editBlocker && <Notice>{correctionError({ code: data.editBlocker, field: "activityId" })}</Notice>}
      <Heading>付款與分攤</Heading>
      <Card>
        <Row title="實際商家付款人" value={nameFor(expense.merchantPayment.memberId)} divider={false} />
        <Row title="實際商家付款" value={money(expense.merchantPayment.amountMinor)} />
        <Row title="參與分攤" value={`${expense.split.allocations.length} 人`} />
        {amountMinor > 0 && <Text style={styles.caption}>各人目前承擔（扣除有效退款）</Text>}
        {expense.split.allocations.map(({ memberId, amountMinor: share }) =>
          <Row key={memberId} title={nameFor(memberId)} value={money(share - (reductions.get(memberId) ?? 0))} />)}
      </Card>
      <BillDetails expense={expense} money={money} nameFor={nameFor} />
      <Heading>相關記錄</Heading>
      <Card>
        <Row title="有效商家退款" value={money(amountMinor)} divider={false} />
        <RefundRows refunds={refunds} money={money} nameFor={nameFor} />
        {data.voidedRefundCount > 0 && <Text style={styles.caption}>另有 {data.voidedRefundCount} 筆已作廢退款</Text>}
        <Row title="有效費用" value={money(expense.split.total.amountMinor - amountMinor)} />
        <Pressable accessibilityRole="button" onPress={onHistory} style={[styles.row, styles.line, styles.divider]}>
          <Text style={styles.compareLabel}>修訂歷史</Text><Text style={styles.caption}>{data.versions.length} 個版本</Text>
          <Icon name="next" size={17} color={colors.muted} />
        </Pressable>
      </Card>
    </>
  );
}

function Suggestions({ items, nameFor, money }: { items: readonly TransferSuggestion[]; nameFor: NameFor; money: Money }) {
  if (items.length === 0) return <Text style={styles.caption}>目前無需轉帳</Text>;
  return items.map(({ fromMemberId, toMemberId, amountMinor }) => (
    <Row key={JSON.stringify([fromMemberId, toMemberId])}
      title={`${nameFor(fromMemberId)} → ${nameFor(toMemberId)}`} value={money(amountMinor)} />
  ));
}

function Impact({ preview, reviewedRefunds, onReview }: { preview: Preview; reviewedRefunds: boolean; onReview: () => void }) {
  const { before, after, expense: { before: oldBill, after: newBill, refunds }, memberChanges, activity } = preview;
  const names = memberLabels(activity.members);
  const nameFor = (id: string) => names.get(id) ?? "未知成員";
  const money: Money = (minor) => formatResultMoney(activity.currency, minor);
  const amount = (minor: number) => money(minor).slice(activity.currency.length + 1);
  const net = (minor: number) => minor === 0 ? amount(0) : `${minor > 0 ? "應收" : "應付"} ${amount(Math.abs(minor))}`;
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
      <Notice>請核對本筆費用、全體成員淨額與轉帳建議。提交會新增一個費用版本。</Notice>
      <Card>
        <Text style={styles.caption}>{label(oldBill)} · 正式費用</Text>
        <View style={styles.compareHeader}>
          <View style={styles.compareBox}>
            <Text style={styles.caption}>更正前</Text>
            <Text style={styles.boxAmount}>{money(oldBill.split.total.amountMinor)}</Text>
            <Text style={styles.caption}>{describeSplit(oldBill)}</Text>
          </View>
          <Text style={styles.caption}>→</Text>
          <View style={styles.compareBox}>
            <Text style={styles.caption}>更正後</Text>
            <Text style={styles.boxAmount}>{money(newBill.split.total.amountMinor)}</Text>
            <Text style={styles.caption}>{describeSplit(newBill)}</Text>
          </View>
        </View>
        <Compare title="活動有效費用" before={money(oldTotal.effectiveMinor)} after={money(newTotal.effectiveMinor)} />
      </Card>
      <Heading>本筆分攤 · 更正前後</Heading>
      <Card>
        {shownMembers.map(({ id }) => {
          const original = oldShares.get(id) ?? 0;
          const proposed = newShares.get(id) ?? 0;
          const reduction = reductions.get(id) ?? 0;
          return <View key={id}>
            <Compare inline title={nameFor(id)} before={oldShares.has(id) ? amount(original) : "未參與"}
              after={newShares.has(id) ? amount(proposed) : "未參與"} />
            {reduction > 0 && <Compare title="扣除退款後承擔" before={money(original - reduction)} after={money(proposed - reduction)} />}
          </View>;
        })}
        <Row title="原始分攤合計" value={money(newBill.split.total.amountMinor)} />
        <Text style={styles.caption}>各列以 {activity.currency} 顯示。</Text>
      </Card>
      <Heading>整個活動 · 最新淨額</Heading>
      <Card>
        {memberChanges.map(({ memberId, beforeNetBalanceMinor, afterNetBalanceMinor }) => (
          <Compare inline key={memberId} title={nameFor(memberId)} before={net(beforeNetBalanceMinor)} after={net(afterNetBalanceMinor)} />
        ))}
        <Compare title="尚待結算" before={money(oldTotal.outstandingMinor)} after={money(newTotal.outstandingMinor)} />
      </Card>
      <Heading>本筆費用 · 付款與帳單</Heading>
      <Card>
        {label(oldBill) !== label(newBill) && <Compare title="費用名稱" before={label(oldBill)} after={label(newBill)} />}
        <Compare title="費用日期" before={dateText(preview.beforeDate)} after={dateText(preview.afterDate)} />
        <Compare title="實際商家付款"
          before={`${nameFor(oldBill.merchantPayment.memberId)} · ${money(oldBill.merchantPayment.amountMinor)}`}
          after={`${nameFor(newBill.merchantPayment.memberId)} · ${money(newBill.merchantPayment.amountMinor)}`} />
        <Row title="本筆有效商家退款" value={money(amountMinor)} />
        {beforeExpense && afterExpense && <Compare title="本筆有效費用" before={money(beforeExpense.effectiveTotalMinor)}
          after={money(afterExpense.effectiveTotalMinor)} />}
      </Card>
      <Heading>轉帳建議</Heading>
      <Card>
        <Text style={styles.compareLabel}>更正前</Text><Suggestions items={preview.beforeSuggestions} money={money} nameFor={nameFor} />
        <Text style={styles.compareLabel}>更正後</Text><Suggestions items={preview.suggestions} money={money} nameFor={nameFor} />
        <Text style={styles.caption}>以上為結算建議。已登記的實際還款仍按原記錄計入。</Text>
      </Card>
      <Heading>有效退款與還款</Heading>
      <Card>
        <Compare title="全活動有效商家退款" before={money(oldTotal.refundMinor)} after={money(newTotal.refundMinor)} />
        <Compare title="全活動有效成員還款" before={money(oldTotal.repaymentMinor)} after={money(newTotal.repaymentMinor)} />
        {refunds.length > 0 && <>
          <Row title="本筆累計有效退款" value={money(amountMinor)} />
          <RefundRows refunds={refunds} money={money} nameFor={nameFor} />
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: reviewedRefunds }} onPress={onReview}
            style={[styles.reviewRow, styles.line, styles.divider]}>
            <View style={[styles.checkbox, reviewedRefunds && styles.checked]}>
              {reviewedRefunds && <Icon name="check" size={14} color={colors.onPrimary} />}
            </View>
            <Text style={styles.compareLabel}>我已核對退款接收者及各人的減免分配</Text>
          </Pressable>
        </>}
      </Card>
    </>
  );
}

function History({ data, saved, money, nameFor }: {
  data: ExpenseDetailData; saved: boolean; money: Money; nameFor: NameFor;
}) {
  const [expanded, setExpanded] = useState<number>();
  const originalDate = data.versions[0]?.occurredAt ?? data.expenseDate;
  return (
    <>
      {saved && <Notice>更正已儲存。活動結算已更新，舊版本仍可查閱。</Notice>}
      <Card>
        <View style={styles.row}><Text style={styles.caption}>{label(data.expense)} · 最新版本</Text><Text style={styles.badge}>v{data.currentVersion}</Text></View>
        <Text style={styles.total}>{money(data.expense.split.total.amountMinor)}</Text>
        <Text style={styles.caption}>{nameFor(data.expense.merchantPayment.memberId)} 實際付款 · {describeSplit(data.expense)}</Text>
      </Card>
      <Heading>修訂歷史</Heading>
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
                <Text style={styles.compareLabel}>v{version} · {version === 1 ? "原始費用" : "已確認修訂"}</Text>
                <Text style={styles.badge}>{version === data.currentVersion ? "最新" : "保留"}</Text>
              </View>
              <Text style={styles.caption}>{dateText(occurredAt)} · {label(expense)}</Text>
              <Text style={styles.caption}>{previous ? `${previous.split.allocations.length} 人 → ` : ""}
                {describeSplit(expense)} · {money(expense.split.total.amountMinor)}</Text>
              {previous && <Text style={styles.caption}>
                {previous.split.total.amountMinor === expense.split.total.amountMinor ? "總額不變" : `原總額 ${money(previous.split.total.amountMinor)}`}
                {changed.length ? ` · ${changed.length} 位成員分攤變更` : " · 分攤不變"}
              </Text>}
              <Icon name="down" size={15} color={colors.muted} />
            </Pressable>
            {expanded === version && <>
              {previous && label(previous) !== label(expense) && <Compare title="名稱" before={label(previous)} after={label(expense)} />}
              {previous ? <Compare title="費用日期" before={dateText(previous.expenseDate ?? originalDate)}
                after={dateText(expense.expenseDate ?? originalDate)} />
                : <Row title="費用日期" value={dateText(expense.expenseDate ?? originalDate)} />}
              {previous ? <Compare title="商家付款人" before={nameFor(previous.merchantPayment.memberId)}
                after={nameFor(expense.merchantPayment.memberId)} /> : <Row title="商家付款人" value={nameFor(expense.merchantPayment.memberId)} />}
              {previous && <Compare title="分帳方式" before={modes[previous.splitMode]} after={modes[expense.splitMode]} />}
              <Row title="實際付款" value={money(expense.merchantPayment.amountMinor)} />
              {[...memberIds].map((memberId) => oldShares
                ? <Compare key={memberId} title={nameFor(memberId)}
                  before={oldShares.has(memberId) ? money(oldShares.get(memberId)!) : "未參與"}
                  after={newShares.has(memberId) ? money(newShares.get(memberId)!) : "未參與"} />
                : <Row key={memberId} title={nameFor(memberId)} value={money(newShares.get(memberId)!)} />)}
            </>}
          </Card>
        );
      })}
      <Notice>歷史版本供查閱。各版本的分攤金額為該次保存的帳單分攤。</Notice>
    </>
  );
}

export function ExpenseCorrectionScreen({ activityId, expenseId, onBack, onViewSettlement }: {
  activityId: string; expenseId: string; onBack: () => void; onViewSettlement: () => void;
}) {
  const [data, setData] = useState<ExpenseDetailData | null>();
  const [page, setPage] = useState<"detail" | "edit" | "history">("detail");
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
    if (!data) return "請先重新讀取費用。";
    const result = await loadExpenseCorrectionPreview(activityId, proposed, data.currentVersion);
    if (!result.ok) return correctionError(result.error);
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
      const result = await saveReviewedExpenseCorrection(activityId, request.current, { verifyOnly: retry === "verify" });
      if (result.status === "saved") {
        setReview(undefined);
        setSaved(true);
        setPage("history");
        void reload();
      } else if (result.status === "rejected") {
        setBlocked(true);
        setError(correctionError(result.error));
      } else if (result.status === "notSaved") {
        setRetry("write");
        setError("已確認這次更正未入帳。可以重試儲存。");
      } else {
        setRetry("verify");
        setError("暫時無法確認儲存結果。請先查詢這次修訂。");
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  if (page === "edit" && data) {
    return (
      <>
        <CreateExpenseScreen activityId={activityId} onBack={() => { setPage("detail"); void reload(); }} edit={{
          activity: data.activity, original: data.expense, originalDate: data.expenseDate,
          name: data.expense.name ?? "", hidden: review !== undefined, onPreview: openPreview,
        }} />
        {review && <ConversionPage title="更正影響預覽" onBack={closePreview} busy={saving} footer={<>
          {error && <Notice alert>{error}</Notice>}
          <ButtonPair secondary={{ label: retry === "verify" ? "返回活動詳情" : "返回修改", action: closePreview, disabled: saving }} primary={{
            label: retry === "verify" ? (saving ? "正在查詢…" : "查詢儲存結果")
              : saving ? "正在儲存…" : retry === "write" ? "重試更正" : "確認更正",
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
  const names = memberLabels(data?.activity.members ?? []);
  const nameFor = (id: string) => names.get(id) ?? "未知成員";
  return (
    <ConversionPage key={page} title={page === "history" ? "修訂歷史" : "費用詳情"}
      onBack={page === "history" ? () => setPage("detail") : onBack}
      footer={data && (page === "history"
        ? <ConversionButton label="返回活動結算" onPress={onViewSettlement} />
        : <ButtonPair secondary={{ label: "修訂歷史", action: () => setPage("history") }}
          primary={{ label: "更正費用", action: () => setPage("edit"), disabled: !!data.editBlocker }} />)}>
      {data ? (page === "history" ? <History data={data} saved={saved} money={money} nameFor={nameFor} />
        : <Detail data={data} money={money} nameFor={nameFor} onHistory={() => setPage("history")} />)
        : readError ? <>
          {saved && <Notice>更正已儲存。暫時無法讀取最新詳情。</Notice>}
          <ConversionReadError retry={() => { void reload(); }} />
        </>
        : data === null ? <Notice>找不到這筆活動費用。</Notice>
        : <ActivityIndicator accessibilityLabel="正在讀取費用" color={colors.ink} />}
    </ConversionPage>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 11, gap: 4 },
  notice: { backgroundColor: colors.quiet, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700", marginTop: 4 },
  name: { color: colors.ink, fontSize: 22, fontWeight: "700", marginTop: 3 },
  total: { color: colors.ink, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"], marginVertical: 3 },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  badge: { color: colors.muted, backgroundColor: colors.quiet, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: 10, rowGap: 3 },
  line: { paddingVertical: 8, gap: 4 },
  divider: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  value: { color: colors.ink, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" },
  compareLabel: { color: colors.ink, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  inline: { flexDirection: "row", alignItems: "center", gap: 7 },
  inlineLabel: { flexBasis: "25%" },
  inlineValues: { flex: 1 },
  compareValues: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  oldValue: { color: colors.muted, fontSize: 14, fontVariant: ["tabular-nums"], flex: 1 },
  compareHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 6 },
  compareBox: { flex: 1, gap: 4, backgroundColor: colors.quiet, borderRadius: 12, padding: 10 },
  boxAmount: { color: colors.ink, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  reviewRow: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44 },
  checkbox: { width: 21, height: 21, borderColor: colors.muted, borderWidth: 1, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  checked: { backgroundColor: colors.ink, borderColor: colors.ink },
  revisionHeading: { gap: 5, minHeight: 44 },
  actions: { flexDirection: "row", gap: 8 },
  primary: { flex: 1 },
  secondary: { flex: 0.82, minHeight: 52, padding: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.ink, fontSize: 16, fontWeight: "700", textAlign: "center" },
  dimmed: { opacity: 0.65 },
});
