import { formatUiCount, formatUiDate, type Copy } from "../services/localizedCopy.ts";
import { useCopy } from "./useCopy.ts";
import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { DomainErrorCode } from "../domain/result.ts";
import { merchantPaymentsOf } from "../domain/balance.ts";
import { minorDigits } from "../domain/money.ts";
import type { TransferSuggestion } from "../domain/settlement.ts";
import { loadExpenseDetail, summarizeCorrectionBalances, summarizeExpenseRefunds, type ExpenseDetailData } from "../services/expenseDetail.ts";
import { expenseDateInput } from "../services/expenseEditor.ts";
import {
  inspectMerchantRefundDraft, loadMerchantRefundPreview, loadMerchantRefundVoidPreview, saveReviewedMerchantRefund,
  type MerchantRefundDraft, type ReviewedRefund,
} from "../services/merchantRefund.ts";
import { formatResultMoney } from "../services/quickSplitResult.ts";
import { ButtonPair, Card, Compare, Heading, Notice, Row, financeReviewStyles as reviewStyles } from "./FinanceReviewUi.tsx";
import { ConversionButton, ConversionPage, ConversionReadError, memberLabels, MemberPicker } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";
import { merchantPaymentCopy } from "./merchantPaymentCopy.ts";

export const merchantRefundCopy = (t: Copy) => ({
  title: t("商家退款"), register: t("登記商家退款"), registerAnother: t("登記另一筆退款"), history: t("商家退款記錄"),
  historyHeading: t("退款歷史"), detail: t("退款詳情"), viewDetail: t("查看退款詳情"), viewHistory: t("查看退款記錄"),
  noRecords: t("尚未有商家退款記錄。"), missing: t("找不到這筆活動費用。"), missingRefund: t("找不到這筆退款記錄。"),
  activeOnly: t("活動已完成。重新開啟活動後才可登記或作廢商家退款。"), fullyRefunded: t("這筆費用已全額退款。"),
  formHelp: t("記錄商家實際退回的金額、收到退款的人，以及各成員應承擔費用的減免。"),
  amount: t("實際退款金額"), recipient: t("實際退款接收人"), selectRecipient: t("選擇退款接收人"),
  date: t("退款日期"), dateHint: t("格式為 YYYY-MM-DD。"), note: t("備註（選填）"), notePlaceholder: t("例如餐廳退回部分費用"),
  allocation: t("成員減免分配"), proportional: t("按目前分攤比例"), recordedAllocation: t("已保存的減免分配"),
  default: t("預設"), allocationHelp: t("按這筆費用各成員尚未退回的承擔額分配，尾差依費用分攤順序處理。"),
  reductionTotal: t("減免合計"), allocationPlaceholder: t("輸入有效退款金額後即可查看減免。"),
  preview: t("退款影響預覽"), openPreview: t("預覽退款影響"), previewHelp: t("請核對本筆退款及整個活動的結算變化，確認後才會寫入帳本。"),
  confirm: t("確認登記退款"), backToEdit: t("返回修改"), calculating: t("正在計算…"),
  voidAction: t("作廢此退款"), voidTitle: t("作廢退款確認"), voidConfirm: t("確認作廢退款"), cancel: t("取消"),
  voidHelp: t("作廢會保留退款歷史並重新計算活動結算。此操作只會更正帳本。"),
  voidSubject: t("即將作廢的真實商家退款"), voidImpact: t("作廢後的帳務影響"), voidedAt: t("作廢時間"),
  saved: t("商家退款已登記，活動結算已更新。"), voided: t("退款已作廢，原記錄仍可查閱。"),
  saving: t("正在儲存…"), checking: t("正在查詢…"), verify: t("查詢儲存結果"), retry: t("重試儲存"),
  unknown: t("暫時無法確認儲存結果。請先查詢這次記錄。"), notSaved: t("已確認這次操作未入帳。可以重試儲存。"),
  backToExpense: t("返回費用詳情"), refresh: t("重新讀取"), loading: t("正在讀取退款資料"),
  effectiveRefund: t("有效商家退款"), effectiveExpense: t("有效費用"), remaining: t("目前可登記退款上限"),
  merchantPaid: t("原始商家付款"), merchantPayer: t("實際商家付款人"), validCount: t("有效記錄"), recordDate: t("退款日期"),
  recordedAt: t("登記時間"), version: t("退款發生時的費用版本"),
  active: t("有效"), voidedStatus: t("已作廢"), historyNote: t("備註"), unknownMember: t("未知成員"), unnamedExpense: t("未命名費用"),
  beforeRefund: t("退款前有效費用"), afterRefund: t("退款後有效費用"),
  activity: t("整個活動"), activityExpense: t("活動有效費用"), outstanding: t("尚待結算"), effectiveRepayment: t("有效成員還款"),
  netBalances: t("成員最新淨額"), receive: t("應收"), pay: t("應付"), sharesBeforeAfter: t("成員減免及承擔額"),
  transferSuggestions: t("轉帳建議"), before: t("更改前"), after: t("更改後"), noTransfers: t("目前無需轉帳"),
  suggestionNote: t("轉帳建議供核對。已登記的實際還款會保留。"),
  reduction: t("減免"), restored: t("恢復承擔"),
} as const);
const dateText = (t: Copy, timestamp: number, withTime = false) => formatUiDate(t, timestamp, withTime ? "dateTime" : "long");
const expenseLabel = (t: Copy, data: ExpenseDetailData) => data.expense.name ?? t("未命名費用");

function message(t: Copy, code: DomainErrorCode) {
  const copy = merchantRefundCopy(t);
  const messages: Partial<Record<DomainErrorCode, string>> = {
    ACTIVITY_COMPLETED: copy.activeOnly,
    ACTIVITY_NOT_FOUND: copy.missing,
    EXPENSE_NOT_FOUND: copy.missing,
    INVALID_AMOUNT: t("請輸入有效的退款金額。"),
    INVALID_AMOUNT_PRECISION: t("小數位超出此幣種的上限。"),
    NEGATIVE_AMOUNT: t("退款金額必須大於零。"),
    NON_POSITIVE_AMOUNT: t("退款金額必須大於零。"),
    REFUND_EXCEEDS_EXPENSE: t("退款金額超出這筆費用尚可退回的金額。"),
    REFUND_REDUCTION_EXCEEDS_ALLOCATION: t("減免金額超出成員可減免的承擔額。"),
    INVALID_EVENT_TIME: t("請輸入有效的退款日期，日期須為今天或更早。"),
    REFUND_DATE_CONFLICT: t("這個退款日期與當時的費用版本或已登記帳務有衝突，請核對實際退款日期與記錄。"),
    MEMBER_NOT_PARTICIPATING: t("請選擇實際收到商家退款的活動成員。"),
    REFUND_LEDGER_CHANGED: t("帳本在預覽後已更新。請重新讀取並預覽。"),
    EVENT_ALREADY_VOIDED: t("這筆退款已作廢。"),
    INVALID_VOID_TARGET: copy.missingRefund,
    VOID_OUT_OF_ORDER: t("帳本含日期較晚的事件，請先核對事件日期。"),
    VOID_LEDGER_CONFLICT: t("作廢這筆退款會與既有帳務衝突，請先核對記錄。"),
    EVENT_ID_CONFLICT: t("此請求與已保存的事件不符，請重新讀取記錄。"),
    AMOUNT_OVERFLOW: t("金額超出帳本可處理的上限。"),
    CURRENCY_MISMATCH: t("退款幣種須與活動一致。"),
  };
  return messages[code] ?? t("暫時無法處理商家退款，請核對記錄後再試。");
}

type Entry = ExpenseDetailData["refundHistory"][number];
type Preview = ReviewedRefund & { activity: ExpenseDetailData["activity"] };
type Money = (minor: number | bigint) => string;
type NameFor = (id: string) => string;

function Status({ voided }: { voided: boolean }) {
  const t = useCopy();
  const copy = merchantRefundCopy(t);
  return <Text style={[reviewStyles.badge, voided && styles.voided]}>{voided ? copy.voidedStatus : copy.active}</Text>;
}

function RefundHistoryCard({ entry, money, nameFor, onOpen }: {
  entry: Entry; money: Money; nameFor: NameFor; onOpen?: () => void;
}) {
  const t = useCopy();
  const copy = merchantRefundCopy(t);
  const { refund, version, voidEvent } = entry;
  return <Card>
    <View style={reviewStyles.row}>
      <Text style={reviewStyles.compareLabel}>{copy.title} · {money(refund.amountMinor)}</Text>
      <Status voided={!!voidEvent} />
    </View>
    <Text style={reviewStyles.caption}>{dateText(t, refund.occurredAt)}</Text>
    <Row title={copy.recipient} value={nameFor(refund.recipientId)} />
    <Row title={copy.allocation} value={refund.distribution === "proportional" ? copy.proportional : copy.recordedAllocation} />
    {version && <>
      <Row title={copy.merchantPaid} value={money(version.expense.split.total.amountMinor)} />
      <Row title={copy.version} value={`${version.expense.name ?? copy.unnamedExpense} · v${version.version}`} />
    </>}
    {onOpen ? <Pressable accessibilityRole="button" onPress={onOpen} style={[styles.link, reviewStyles.divider]}>
      <Text style={reviewStyles.compareLabel}>{copy.viewDetail}</Text><Icon name="next" size={17} />
    </Pressable> : <>
      {refund.reductions.map(({ memberId, amountMinor }) => <Row key={memberId} title={nameFor(memberId)} value={money(amountMinor)} />)}
      {refund.note && <Row title={copy.historyNote} value={refund.note} />}
      {refund.recordedAt !== undefined && <Row title={copy.recordedAt} value={dateText(t, refund.recordedAt, true)} />}
      {voidEvent && <Row title={copy.voidedAt} value={dateText(t, voidEvent.occurredAt, true)} />}
    </>}
  </Card>;
}

function Suggestions({ items, money, nameFor }: { items: readonly TransferSuggestion[]; money: Money; nameFor: NameFor }) {
  const t = useCopy();
  const copy = merchantRefundCopy(t);
  return items.length ? items.map(({ fromMemberId, toMemberId, amountMinor }) =>
    <Row key={JSON.stringify([fromMemberId, toMemberId])} title={`${nameFor(fromMemberId)} → ${nameFor(toMemberId)}`}
      value={money(amountMinor)} />) : <Text style={reviewStyles.caption}>{copy.noTransfers}</Text>;
}

function RefundImpact({ review }: { review: Preview }) {
  const t = useCopy();
  const copy = merchantRefundCopy(t);
  const { activity, preview } = review;
  const { expense, refund, before, after } = preview;
  const isVoid = review.kind === "void";
  const occurredAt = review.kind === "void" ? review.preview.refund.occurredAt : review.preview.occurredAt;
  const money: Money = (minor) => formatResultMoney(activity.currency, minor);
  const names = memberLabels(t, activity.members);
  const nameFor = (id: string) => names.get(id) ?? copy.unknownMember;
  const net = (minor: number) => minor === 0 ? money(0) : `${minor > 0 ? copy.receive : copy.pay} ${money(Math.abs(minor))}`;
  const old = summarizeCorrectionBalances(before);
  const next = summarizeCorrectionBalances(after);
  const beforeEffective = before.effectiveExpenses.find(({ expenseId }) => expenseId === expense.id)!.effectiveTotalMinor;
  const afterEffective = after.effectiveExpenses.find(({ expenseId }) => expenseId === expense.id)!.effectiveTotalMinor;
  const newBalances = new Map(after.balances.map(({ memberId, netBalanceMinor }) => [memberId, netBalanceMinor]));
  const newShares = new Map(preview.afterShares.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  const reductions = new Map(refund.reductions.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  return <>
    <Notice>{isVoid ? copy.voidHelp : copy.previewHelp}</Notice>
    <Card>
      <Text style={reviewStyles.caption}>{expense.name ?? copy.unnamedExpense} · v{preview.currentVersion}</Text>
      {isVoid ? <>
        <Text style={reviewStyles.caption}>{copy.voidSubject}</Text>
        <Text style={reviewStyles.total}>{money(refund.amountMinor)}</Text>
        <Compare title={copy.effectiveExpense} before={money(beforeEffective)} after={money(afterEffective)} />
      </> : <>
        <View style={reviewStyles.compareHeader}>
          <View style={reviewStyles.compareBox}>
            <Text style={reviewStyles.caption}>{copy.beforeRefund}</Text>
            <Text style={reviewStyles.boxAmount}>{money(beforeEffective)}</Text>
          </View>
          <Text style={reviewStyles.caption}>→</Text>
          <View style={reviewStyles.compareBox}>
            <Text style={reviewStyles.caption}>{copy.afterRefund}</Text>
            <Text style={reviewStyles.boxAmount}>{money(afterEffective)}</Text>
          </View>
        </View>
        <Row title={copy.amount} value={money(refund.amountMinor)} />
      </>}
      <Row title={copy.recipient} value={nameFor(refund.recipientId)} />
      <Row title={copy.recordDate} value={dateText(t, occurredAt)} />
    </Card>
    <Heading>{isVoid ? copy.voidImpact : copy.activity}</Heading>
    <Card>
      <Compare inline title={copy.activityExpense} before={money(old.effectiveMinor)} after={money(next.effectiveMinor)} />
      <Compare inline title={copy.outstanding} before={money(old.outstandingMinor)} after={money(next.outstandingMinor)} />
      <Compare inline title={copy.effectiveRefund} before={money(old.refundMinor)} after={money(next.refundMinor)} />
      <Compare inline title={copy.effectiveRepayment} before={money(old.repaymentMinor)} after={money(next.repaymentMinor)} />
    </Card>
    <Heading>{copy.netBalances}</Heading>
    <Card>
      {before.balances.map(({ memberId, netBalanceMinor }) => <Compare inline key={memberId} title={nameFor(memberId)}
        before={net(netBalanceMinor)} after={net(newBalances.get(memberId)!)} />)}
    </Card>
    <Heading>{copy.sharesBeforeAfter}</Heading>
    <Card>
      {preview.beforeShares.map(({ memberId, amountMinor }) => <View key={memberId}>
        <Compare inline title={nameFor(memberId)} before={money(amountMinor)} after={money(newShares.get(memberId)!)} />
        <Text style={reviewStyles.caption}>{isVoid ? copy.restored : copy.reduction} {money(reductions.get(memberId) ?? 0)}</Text>
      </View>)}
    </Card>
    <Heading>{copy.transferSuggestions} · {formatUiCount(t, preview.afterSuggestions.length, "transfers")}</Heading>
    <Card>
      <Text style={reviewStyles.compareLabel}>{copy.before}</Text>
      <Suggestions items={preview.beforeSuggestions} nameFor={nameFor} money={money} />
      <Text style={reviewStyles.compareLabel}>{copy.after}</Text>
      <Suggestions items={preview.afterSuggestions} nameFor={nameFor} money={money} />
      <Text style={reviewStyles.caption}>{copy.suggestionNote}</Text>
    </Card>
  </>;
}

export function MerchantRefundScreen({ activityId, expenseId, entryPoint, onBack }: {
  activityId: string; expenseId: string; entryPoint: "register" | "history"; onBack: () => void;
}) {
  const t = useCopy();
  const copy = merchantRefundCopy(t);
  const paymentCopy = merchantPaymentCopy(t.language);
  const [page, setPage] = useState<"register" | "history" | "detail">(entryPoint);
  const [data, setData] = useState<ExpenseDetailData | null>();
  const [draft, setDraft] = useState<MerchantRefundDraft>(() => ({
    amount: "", recipientId: "", date: expenseDateInput(new Date()), note: "",
  }));
  const [selected, setSelected] = useState<string>();
  const [formFromHistory, setFormFromHistory] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [readError, setReadError] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [review, setReview] = useState<Preview>();
  const [retry, setRetry] = useState<"write" | "verify" | "blocked">();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const submission = useRef<ReviewedRefund>(undefined);
  const readId = useRef(0);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const reload = useCallback(async () => {
    const id = ++readId.current;
    setReadError(false);
    setData(undefined);
    try {
      const result = await loadExpenseDetail(activityId, expenseId);
      if (id !== readId.current) return;
      setData(result);
      if (result?.expense.merchantPayment) {
        const defaultRecipient = result.expense.merchantPayment.memberId;
        setDraft((current) => current.recipientId ? current : { ...current, recipientId: defaultRecipient });
      }
    } catch {
      if (id === readId.current) setReadError(true);
    }
  }, [activityId, expenseId]);

  useEffect(() => {
    void reload();
    return () => { readId.current++; };
  }, [reload]);

  function revealInput() {
    const input = TextInput.State.currentlyFocusedInput();
    if (input) scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, 66, true);
  }
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const subscription = Keyboard.addListener("keyboardDidShow", revealInput);
    return () => subscription.remove();
  }, []);

  const entry = data?.refundHistory.find(({ refund }) => refund.id === selected);
  const amounts = data && summarizeExpenseRefunds(data.refunds);
  const available = data && amounts ? data.expense.split.total.amountMinor - amounts.amountMinor : 0;
  const active = data?.activity.status === "active";
  const names = memberLabels(t, data?.activity.members ?? []);
  const nameFor = (id: string) => names.get(id) ?? copy.unknownMember;
  const money: Money = (minor) => data ? formatResultMoney(data.activity.currency, minor) : "";
  const inspection = data && page === "register" ? inspectMerchantRefundDraft(draft, data, new Date()) : undefined;

  function edit<K extends keyof MerchantRefundDraft>(key: K, value: MerchantRefundDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(undefined);
  }

  function back() {
    if (pending.current) return;
    setError(undefined);
    if (review) {
      if (retry === "verify") { onBack(); return; }
      setReview(undefined);
      if (retry === "blocked") void reload();
      setRetry(undefined);
    } else if (page === "detail" || (page === "register" && formFromHistory)) {
      setPage("history");
    } else {
      onBack();
    }
  }

  async function previewAction(kind: "record" | "void") {
    if (!data || !active || pending.current) return;
    Keyboard.dismiss();
    setAttempted(true);
    setError(undefined);
    setSaved(undefined);
    const prepared = kind === "record" ? inspectMerchantRefundDraft(draft, data, new Date()).prepared : undefined;
    if (kind === "record" && !prepared) return;
    if (kind === "void" && (!entry || entry.voidEvent)) return;
    pending.current = true;
    submission.current = undefined;
    setBusy(true);
    try {
      if (kind === "record" && prepared) {
        const { occurredAt, refund } = prepared;
        const result = await loadMerchantRefundPreview(activityId, occurredAt, { ...refund, id: uuid.v4() });
        if (result.ok) setReview({ kind, preview: result.value, activity: result.value.activity });
        else setError(message(t, result.error.code));
      } else if (entry) {
        const result = await loadMerchantRefundVoidPreview(activityId, expenseId, {
          id: uuid.v4(), occurredAt: Date.now(), targetEventId: entry.refund.id,
        });
        if (result.ok) setReview({ kind: "void", preview: result.value, activity: result.value.activity });
        else setError(message(t, result.error.code));
      }
    } catch {
      setError(message(t, "FINANCE_STORAGE_ERROR"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (!review || pending.current || retry === "blocked") return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    submission.current ??= review.kind === "void"
      ? { kind: "void", preview: { ...review.preview, request: { ...review.preview.request, occurredAt: Date.now() } } }
      : review;
    try {
      const result = await saveReviewedMerchantRefund(activityId, submission.current, { verifyOnly: retry === "verify" });
      if (result.status === "saved") {
        setSaved(review.kind === "record" ? copy.saved : copy.voided);
        setPage(review.kind === "record" ? "history" : "detail");
        setReview(undefined);
        setRetry(undefined);
        void reload();
      } else if (result.status === "rejected") {
        setRetry("blocked");
        setError(message(t, result.error.code));
      } else {
        setRetry(result.status === "unknown" ? "verify" : "write");
        setError(result.status === "unknown" ? copy.unknown : copy.notSaved);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (review) {
    return <ConversionPage key={review.kind} title={review.kind === "void" ? copy.voidTitle : copy.preview} busy={busy} onBack={back}
      footer={<>
        {error && <Notice alert>{error}</Notice>}
        <ButtonPair secondary={{
          label: retry === "verify" ? copy.backToExpense : review.kind === "void" ? copy.cancel : copy.backToEdit,
          action: back, disabled: busy,
        }} primary={{
          label: retry === "verify" ? (busy ? copy.checking : copy.verify) : busy ? copy.saving : retry === "write" ? copy.retry
            : review.kind === "void" ? copy.voidConfirm : copy.confirm,
          action: () => { void confirm(); }, disabled: busy || retry === "blocked",
        }} />
      </>}>
      <RefundImpact review={review} />
    </ConversionPage>;
  }

  const footer = data && (page === "history" && active && available > 0 ? <ConversionButton label={copy.registerAnother} onPress={() => {
    setDraft({ amount: "", recipientId: data.expense.merchantPayment?.memberId ?? "", date: expenseDateInput(new Date()), note: "" });
    setAttempted(false);
    setSaved(undefined);
    setFormFromHistory(true);
    setPage("register");
  }} /> : page === "detail" && entry && !entry.voidEvent && active ? <ConversionButton label={busy ? copy.calculating : copy.voidAction}
    disabled={busy} onPress={() => { void previewAction("void"); }} />
    : page === "register" && active && available > 0 ? <ConversionButton label={busy ? copy.calculating : copy.openPreview}
      disabled={busy} onPress={() => { void previewAction("record"); }} /> : undefined);

  const fieldError = (field: keyof MerchantRefundDraft) => {
    const code = attempted ? inspection?.errors[field] : undefined;
    return code && <Text accessibilityRole="alert" style={styles.fieldError}>{message(t, code)}</Text>;
  };
  const onFocus = () => { if (Keyboard.isVisible()) requestAnimationFrame(revealInput); };

  return <>
    <ConversionPage key={page} title={page === "register" ? copy.register : page === "history" ? copy.history : copy.detail}
      scrollRef={scroll} onBack={back} busy={busy} footer={footer}>
      {saved && <Notice>{saved}</Notice>}
      {error && <Notice alert>{error}</Notice>}
      {readError ? <ConversionReadError retry={() => { void reload(); }} />
        : data === null ? <Notice>{copy.missing}</Notice>
        : !data ? <ActivityIndicator accessibilityLabel={copy.loading} color={colors.ink} />
        : <>
          {!active && <Notice>{copy.activeOnly}</Notice>}
          {page === "register" && <>
            <Notice>{copy.formHelp}</Notice>
            <Card>
              <Text style={reviewStyles.caption}>{expenseLabel(t, data)} · v{data.currentVersion} · {data.activity.currency}</Text>
              {data.expense.merchantPayment
                ? <Row title={copy.merchantPayer} value={nameFor(data.expense.merchantPayment.memberId)} divider={false} />
                : merchantPaymentsOf(data.expense).map(({ memberId, amountMinor }, index) =>
                  <Row key={memberId} title={nameFor(memberId)} value={money(amountMinor)} divider={index > 0} />)}
              <Row title={paymentCopy.paidTotal} value={money(data.expense.split.total.amountMinor)} />
              <Row title={copy.effectiveExpense} value={money(available)} />
              <Row title={copy.effectiveRefund} value={money(amounts?.amountMinor ?? 0)} />
              <Row title={copy.remaining} value={money(available)} />
            </Card>
            {available === 0 && <Notice>{copy.fullyRefunded}</Notice>}
            {active && available > 0 && <>
              <View style={styles.field}>
                <Text style={reviewStyles.compareLabel}>{copy.amount} *</Text>
                <View style={[styles.control, styles.amountInput]}>
                  <Text style={reviewStyles.caption}>{data.activity.currency}</Text>
                  <TextInput accessibilityLabel={copy.amount} value={draft.amount} onChangeText={(value) => edit("amount", value)}
                    style={styles.moneyInput} keyboardType="decimal-pad" onFocus={onFocus}
                    placeholder={minorDigits[data.activity.currency] === 0 ? "0" : "0.00"} placeholderTextColor={colors.muted} />
                </View>
                {fieldError("amount")}
              </View>
              <View style={styles.field}>
                <Text style={reviewStyles.compareLabel}>{copy.recipient} *</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={copy.selectRecipient}
                  onPress={() => { Keyboard.dismiss(); setShowPicker(true); }} style={[styles.control, reviewStyles.row]}>
                  <Text style={reviewStyles.compareLabel}>{names.get(draft.recipientId) ?? copy.selectRecipient}</Text>
                  <Icon name="down" size={16} />
                </Pressable>
                {data.expense.merchantPayments && <Text style={reviewStyles.caption}>{paymentCopy.refundRecipient}</Text>}
                {fieldError("recipientId")}
              </View>
              <Heading>{copy.allocation}</Heading>
              <Card>
                <View style={reviewStyles.row}>
                  <Text style={reviewStyles.compareLabel}>{copy.proportional}</Text>
                  <Text style={reviewStyles.badge}>{copy.default}</Text>
                </View>
                <Text style={reviewStyles.caption}>{copy.allocationHelp}</Text>
                {inspection?.reductions ? <>
                  {inspection.reductions.map(({ memberId, amountMinor }) =>
                    <Row key={memberId} title={nameFor(memberId)} value={money(amountMinor)} />)}
                  <Row title={copy.reductionTotal} value={money(inspection.reductions.reduce((sum, reduction) => sum + reduction.amountMinor, 0))} />
                </> : <Text style={reviewStyles.caption}>{copy.allocationPlaceholder}</Text>}
              </Card>
              <View style={styles.field}>
                <Text style={reviewStyles.compareLabel}>{copy.date} *</Text>
                <TextInput accessibilityLabel={copy.date} value={draft.date} onChangeText={(value) => edit("date", value)}
                  style={styles.control} maxLength={10} keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"} onFocus={onFocus} />
                <Text style={reviewStyles.caption}>{copy.dateHint}</Text>
                {fieldError("date")}
              </View>
              <View style={styles.field}>
                <Text style={reviewStyles.compareLabel}>{copy.note}</Text>
                <TextInput accessibilityLabel={copy.note} value={draft.note} onChangeText={(value) => edit("note", value)}
                  style={[styles.control, styles.note]} multiline onFocus={onFocus}
                  placeholder={copy.notePlaceholder} placeholderTextColor={colors.muted} />
              </View>
            </>}
          </>}
          {page === "history" && <>
            <View style={reviewStyles.row}>
              <Text style={reviewStyles.caption}>{expenseLabel(t, data)} · {data.activity.currency}</Text>
              <Text style={reviewStyles.badge}>v{data.currentVersion}</Text>
            </View>
            <Card>
              <Text style={reviewStyles.caption}>{copy.effectiveRefund}</Text>
              <Text style={reviewStyles.total}>{money(amounts?.amountMinor ?? 0)}</Text>
              <Row title={copy.validCount} value={`${data.refunds.length} / ${formatUiCount(t, data.refundHistory.length, "records")}`} divider={false} />
              <Row title={copy.effectiveExpense} value={money(available)} />
            </Card>
            <Heading>{copy.historyHeading}</Heading>
            {data.refundHistory.length === 0 && <Notice>{copy.noRecords}</Notice>}
            {data.refundHistory.map((record) => <RefundHistoryCard key={record.refund.id} entry={record} money={money} nameFor={nameFor}
              onOpen={() => { setSelected(record.refund.id); setSaved(undefined); setPage("detail"); }} />)}
          </>}
          {page === "detail" && (entry ? <>
            <Text style={reviewStyles.caption}>{data.activity.name} · {expenseLabel(t, data)} · {data.activity.currency}</Text>
            <RefundHistoryCard entry={entry} money={money} nameFor={nameFor} />
          </> : <Notice>{copy.missingRefund}</Notice>)}
        </>}
    </ConversionPage>
    {showPicker && data && <MemberPicker title={copy.selectRecipient} members={data.activity.members} labels={names}
      selected={draft.recipientId} onClose={() => setShowPicker(false)}
      onSelect={(id) => { edit("recipientId", id); setShowPicker(false); }} />}
  </>;
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  control: { minHeight: 47, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
    borderRadius: 11, paddingHorizontal: 12, paddingVertical: 9, color: colors.ink, fontSize: 16 },
  amountInput: { flexDirection: "row", alignItems: "center", gap: 9 },
  moneyInput: { flex: 1, minHeight: 30, color: colors.ink, fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
  note: { minHeight: 64, textAlignVertical: "top" },
  fieldError: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  voided: { color: colors.muted, backgroundColor: colors.tile },
  link: { minHeight: 44, paddingVertical: 9, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 },
});
