import type { ActivityDetail } from "../data/activities.ts";
import type { FinanceExpense } from "../data/finance.ts";
import { formatAmount } from "../domain/money.ts";
import type { Failure } from "../domain/result.ts";
import { failure } from "../domain/result.ts";
import { calculateQuickSplitEditor, createQuickSplitEditor, type EditorError, type QuickSplitEditorState } from "./quickSplitEditor.ts";

export function createExpenseEditor(activity: ActivityDetail): QuickSplitEditorState {
  return {
    ...createQuickSplitEditor(), currency: activity.currency,
    members: activity.members.map(({ id, displayName }) => ({ id, displayName, included: true, shareCommon: true, personalAmount: "" })),
  };
}

export function calculateExpenseSplit(editor: QuickSplitEditorState) {
  // Keep the merchant payer separate from the split, including when they did not participate.
  const participants = editor.members.filter(({ included }) => included);
  return calculateQuickSplitEditor({ ...editor, members: participants, merchantPayerId: undefined });
}

export function prepareNewExpense(id: string, rawName: string, editor: QuickSplitEditorState):
  { readonly ok: true; readonly value: FinanceExpense } | Failure | { readonly ok: false; readonly error: EditorError } {
  const name = rawName.trim();
  if (!name) return failure("INVALID_EXPENSE_NAME", "expenseName");
  const preview = calculateExpenseSplit(editor);
  if (!preview.ok) return preview;
  const payer = editor.members.find(({ id }) => id === editor.merchantPayerId);
  if (!payer) return failure("MISSING_MERCHANT_PAYMENT", "merchantPayment");
  const { total, allocations, allocationVersion } = preview.value.snapshot.split;
  return { ok: true, value: {
    id, name, split: { total, allocations }, splitMode: editor.mode, allocationVersion, splitInput: preview.value.input,
    merchantPayment: { memberId: payer.id, ...total },
  } };
}

export function hydrateExpenseEditor(activity: ActivityDetail, expense: FinanceExpense): QuickSplitEditorState {
  const defaults = createExpenseEditor(activity);
  const currency = expense.split.total.currency;
  const amount = (amountMinor: number) => {
    const result = formatAmount({ currency, amountMinor });
    return result.ok ? result.value : "";
  };
  const participants = new Set(expense.split.allocations.map(({ memberId }) => memberId));
  const method = expense.splitInput?.method;
  const charges = expense.splitInput?.charges;
  const treat = method?.kind === "treat" ? method.options : undefined;
  const individual = method?.kind === "individual" ? method : undefined;
  const personal = new Map(individual?.personalSpending.map(({ memberId, personalMinor }) => [memberId, personalMinor]));
  const sharedMembers = new Set(individual?.shared.memberIds);
  const details = charges?.kind === "details" ? charges : undefined;
  const fee = details?.serviceFee;
  return {
    ...defaults, mode: expense.splitMode === "custom" ? "equal" : expense.splitMode,
    members: defaults.members.map((member) => ({
      ...member, included: participants.has(member.id), shareCommon: individual ? sharedMembers.has(member.id) : true,
      personalAmount: personal.has(member.id) ? amount(personal.get(member.id)!) : "",
    })),
    finalTotal: amount(expense.split.total.amountMinor), merchantPayerId: expense.merchantPayment.memberId,
    ...(treat && {
      hostId: treat.hostId, coverKind: treat.cover.kind, includeHostInRemainder: treat.includeHostInRemainder ?? false,
      coverAmount: treat.cover.kind === "fixed" ? amount(treat.cover.amountMinor) : "",
      coverPercentage: treat.cover.kind === "percentage" ? (treat.cover.basisPoints / 100).toFixed(2) : "",
    }),
    sharedAmount: individual ? amount(individual.shared.amountMinor) : "",
    ...(details && {
      chargeMode: "details", subtotal: amount(details.subtotal.amountMinor), discount: amount(details.discountMinor ?? 0),
      serviceFeeMode: fee?.kind ?? "none",
      serviceFee: fee?.kind === "manual" ? amount(fee.amountMinor) : "",
      serviceFeeBasis: fee?.kind === "quick10" ? fee.basis ?? "beforeDiscount" : "beforeDiscount",
    }),
  };
}

export function expenseSplitUnchanged(original: QuickSplitEditorState, draft: QuickSplitEditorState): boolean {
  const { merchantPayerId: _originalPayer, ...originalSplit } = original;
  const { merchantPayerId: _draftPayer, ...draftSplit } = draft;
  return JSON.stringify(originalSplit) === JSON.stringify(draftSplit);
}

export function prepareExpenseEdit(
  original: FinanceExpense, initial: QuickSplitEditorState, draft: QuickSplitEditorState, rawName: string, expenseDate: number,
): ReturnType<typeof prepareNewExpense> {
  if (!expenseSplitUnchanged(initial, draft)) {
    const prepared = prepareNewExpense(original.id, rawName, draft);
    return prepared.ok ? { ok: true, value: { ...prepared.value, expenseDate } } : prepared;
  }
  const name = rawName.trim();
  if (!name) return failure("INVALID_EXPENSE_NAME", "expenseName");
  const payer = draft.members.find(({ id }) => id === draft.merchantPayerId);
  if (!payer) return failure("MISSING_MERCHANT_PAYMENT", "merchantPayment");
  return { ok: true, value: { ...original, name, expenseDate, merchantPayment: { ...original.split.total, memberId: payer.id } } };
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
