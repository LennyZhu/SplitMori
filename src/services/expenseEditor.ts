import type { ActivityDetail } from "../data/activities.ts";
import type { FinanceExpense } from "../data/finance.ts";
import { merchantPaymentsOf, paymentFields, validateMerchantPayments, type ExpensePayments, type MerchantPayment } from "../domain/balance.ts";
import { formatAmount, parseAmount, type Money } from "../domain/money.ts";
import type { DomainErrorCode, Failure, Result } from "../domain/result.ts";
import { failure } from "../domain/result.ts";
import type { TreatOptions } from "../domain/split.ts";
import { calculateQuickSplitEditor, createQuickSplitEditor, type EditorError, type EditorHost, type QuickSplitEditorState } from "./quickSplitEditor.ts";

export type PaymentRow = { readonly memberId: string; readonly amount: string };
export type ExpenseEditorState = QuickSplitEditorState & { readonly paymentRows?: readonly PaymentRow[] };

export function createExpenseEditor(activity: ActivityDetail): ExpenseEditorState {
  return {
    ...createQuickSplitEditor(), currency: activity.currency,
    members: activity.members.map(({ id, displayName }) => ({ id, displayName, included: true, shareCommon: true, personalAmount: "" })),
  };
}

export function calculateExpenseSplit(editor: QuickSplitEditorState, hasProAccess = true) {
  // Keep the merchant payer separate from the split, including when they did not participate.
  const participants = editor.members.filter(({ included }) => included);
  return calculateQuickSplitEditor({ ...editor, members: participants, merchantPayerId: undefined }, hasProAccess);
}

export function inspectExpensePayments(editor: ExpenseEditorState, total?: Money) {
  const payments: MerchantPayment[] = [];
  const rowErrors: (DomainErrorCode | undefined)[] = [];
  const members = new Set(editor.members.map(({ id }) => id));
  let paidMinor = 0n;
  let error: Failure | undefined;

  if (editor.paymentRows !== undefined) {
    const seen = new Set<string>();
    for (const { memberId, amount } of editor.paymentRows) {
      const parsed = parseAmount(amount.trim(), editor.currency);
      const code = !members.has(memberId) ? "MEMBER_NOT_PARTICIPATING" : seen.has(memberId) ? "DUPLICATE_MEMBER_ID"
        : !parsed.ok ? parsed.error.code : parsed.value.amountMinor === 0 ? "NON_POSITIVE_AMOUNT" : undefined;
      rowErrors.push(code);
      if (code) error ??= failure(code, "merchantPayment");
      seen.add(memberId);
      if (parsed.ok) {
        paidMinor += BigInt(parsed.value.amountMinor);
        payments.push({ ...parsed.value, memberId });
      }
    }
    if (editor.paymentRows.length < 2) error ??= failure("MISSING_MERCHANT_PAYMENT", "merchantPayment");
  } else if (!editor.merchantPayerId || !members.has(editor.merchantPayerId)) {
    error = failure("MISSING_MERCHANT_PAYMENT", "merchantPayment");
  } else if (total) {
    payments.push({ ...total, memberId: editor.merchantPayerId });
    paidMinor = BigInt(total.amountMinor);
  }

  if (total) error ??= validateMerchantPayments(total, payments, members);
  const result: Result<ExpensePayments> = error ?? (total
    ? { ok: true, value: paymentFields(payments) } : failure("INVALID_AMOUNT", "total"));
  return { result, rowErrors, paidMinor, remainingMinor: total ? BigInt(total.amountMinor) - paidMinor : undefined };
}

export function prepareNewExpense(id: string, rawName: string, editor: ExpenseEditorState):
  { readonly ok: true; readonly value: FinanceExpense } | Failure | { readonly ok: false; readonly error: EditorError } {
  const name = rawName.trim();
  if (!name) return failure("INVALID_EXPENSE_NAME", "expenseName");
  const preview = calculateExpenseSplit(editor);
  if (!preview.ok) return preview;
  const { total, allocations, allocationVersion } = preview.value.snapshot.split;
  const payments = inspectExpensePayments(editor, total).result;
  if (!payments.ok) return payments;
  return { ok: true, value: {
    id, name, split: { total, allocations }, splitMode: editor.mode, allocationVersion, splitInput: preview.value.input,
    ...payments.value,
  } };
}

export function hydrateExpenseEditor(activity: ActivityDetail, expense: FinanceExpense): ExpenseEditorState {
  const defaults = createExpenseEditor(activity);
  const currency = expense.split.total.currency;
  const amount = (amountMinor: number) => {
    const result = formatAmount({ currency, amountMinor });
    return result.ok ? result.value : "";
  };
  const participants = new Set(expense.split.allocations.map(({ memberId }) => memberId));
  const method = expense.splitInput?.method;
  const charges = expense.splitInput?.charges;
  const treat = method?.kind === "treat" ? "hosts" in method.options ? method.options.hosts : [method.options] : [];
  const hydrateHost = ({ hostId, cover, includeHostInRemainder = false }: TreatOptions): EditorHost => ({
    hostId, coverKind: cover.kind, includeHostInRemainder,
    coverAmount: cover.kind === "fixed" ? amount(cover.amountMinor) : "",
    coverPercentage: cover.kind === "percentage" ? (cover.basisPoints / 100).toFixed(2) : "",
  });
  const individual = method?.kind === "individual" && "personalSpending" in method ? method : undefined;
  const items = method?.kind === "individual" && "items" in method ? method.items : undefined;
  const custom = method?.kind === "custom" ? method.options : undefined;
  const personal = new Map(individual?.personalSpending.map(({ memberId, personalMinor }) => [memberId, personalMinor]));
  const sharedMembers = new Set(individual?.shared.memberIds);
  const details = charges?.kind === "details" ? charges : undefined;
  const fee = details?.serviceFee;
  const currentMembers = new Map(defaults.members.map((member) => [member.id, member]));
  // Keep the original participant order for ties even after conversion from a quick calculation.
  const snapshotOrder = method && "memberIds" in method ? method.memberIds
    : custom ? custom.members.map(({ memberId }) => memberId)
    : individual?.personalSpending.map(({ memberId }) => memberId) ?? [];
  const ordered = [...new Set([...snapshotOrder, ...currentMembers.keys()])];
  const payments = merchantPaymentsOf(expense);
  return {
    ...defaults, mode: expense.splitMode,
    members: ordered.flatMap((id) => {
      const member = currentMembers.get(id);
      if (!member) return [];
      return [{
        ...member, included: participants.has(member.id), shareCommon: individual ? sharedMembers.has(member.id) : true,
        personalAmount: personal.has(member.id) ? amount(personal.get(member.id)!) : "",
      }];
    }),
    finalTotal: amount(expense.split.total.amountMinor),
    ...(payments.length === 1 ? { merchantPayerId: payments[0].memberId }
      : { paymentRows: payments.map(({ memberId, amountMinor }) => ({ memberId, amount: amount(amountMinor) })) }),
    ...(treat.length > 0 && { ...hydrateHost(treat[0]), extraHosts: treat.slice(1).map(hydrateHost) }),
    ...(items && { itemized: true, items: items.map((item, index) => ({
      id: `expense-item-${index}`, name: item.name, quantity: String(item.quantity), amount: amount(item.amountMinor), memberIds: item.memberIds,
    })) }),
    ...(custom && { customKind: custom.kind, customValues: Object.fromEntries(custom.members.map((member) => [
      member.memberId, "amountMinor" in member ? amount(member.amountMinor) : "basisPoints" in member
        ? (member.basisPoints / 100).toFixed(2) : String(member.shares),
    ])) }),
    sharedAmount: individual ? amount(individual.shared.amountMinor) : "",
    ...(details && {
      chargeMode: "details", subtotal: amount(details.subtotal.amountMinor), discount: amount(details.discountMinor ?? 0),
      serviceFeeMode: fee?.kind ?? "none",
      serviceFee: fee?.kind === "manual" ? amount(fee.amountMinor) : "",
      serviceFeeBasis: fee?.kind === "quick10" ? fee.basis ?? "beforeDiscount" : "beforeDiscount",
      feeDistribution: details.distribution?.serviceFee, discountDistribution: details.distribution?.discount,
    }),
  };
}

export function expenseSplitUnchanged(original: ExpenseEditorState, draft: ExpenseEditorState): boolean {
  const { merchantPayerId: _originalPayer, paymentRows: _originalRows, ...originalSplit } = original;
  const { merchantPayerId: _draftPayer, paymentRows: _draftRows, ...draftSplit } = draft;
  return JSON.stringify(originalSplit) === JSON.stringify(draftSplit);
}

export function prepareExpenseEdit(
  original: FinanceExpense, initial: ExpenseEditorState, draft: ExpenseEditorState, rawName: string, expenseDate: number,
): ReturnType<typeof prepareNewExpense> {
  if (!expenseSplitUnchanged(initial, draft)) {
    const prepared = prepareNewExpense(original.id, rawName, draft);
    return prepared.ok ? { ok: true, value: { ...prepared.value, expenseDate } } : prepared;
  }
  const name = rawName.trim();
  if (!name) return failure("INVALID_EXPENSE_NAME", "expenseName");
  const payments = inspectExpensePayments(draft, original.split.total).result;
  if (!payments.ok) return payments;
  const { merchantPayment: _single, merchantPayments: _multiple, ...details } = original;
  return { ok: true, value: { ...details, name, expenseDate, ...payments.value } };
}

export function expenseDateInput(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function expenseDateTimestamp(input: string, openedAt: Date): number | undefined {
  if (input === expenseDateInput(openedAt)) return openedAt.getTime();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (date.getTime() >= 0 && expenseDateInput(date) === input) return date.getTime();
}
