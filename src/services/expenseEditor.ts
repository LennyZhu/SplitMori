import type { ActivityDetail } from "../data/activities.ts";
import type { FinanceExpense } from "../data/finance.ts";
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
    id, name, split: { total, allocations }, splitMode: editor.mode, allocationVersion,
    merchantPayment: { memberId: payer.id, ...total },
  } };
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
