import type { ExpectedTransferBalances, FinanceMemberTransfer } from "../data/finance.ts";
import { parseAmount } from "../domain/money.ts";
import type { DomainErrorCode } from "../domain/result.ts";
import type { ActivitySettlementData } from "./activitySettlement.ts";
import { expenseDateTimestamp } from "./expenseEditor.ts";

export type RepaymentDraft = {
  fromMemberId: string;
  toMemberId: string;
  amount: string;
  date: string;
  note: string;
};

export type PreparedRepayment = {
  occurredAt: number;
  expectedBalances: ExpectedTransferBalances;
  transfer: Omit<FinanceMemberTransfer, "id" | "kind">;
  fromName: string;
  toName: string;
};

export function inspectRepaymentDraft(draft: RepaymentDraft, data: ActivitySettlementData, now: Date) {
  const from = data.members.find(({ memberId }) => memberId === draft.fromMemberId);
  const to = data.members.find(({ memberId }) => memberId === draft.toMemberId);
  const errors: Partial<Record<keyof RepaymentDraft, DomainErrorCode>> = {};
  if (!from) errors.fromMemberId = "MEMBER_NOT_PARTICIPATING";
  else if (from.netBalanceMinor >= 0) errors.fromMemberId = "TRANSFER_EXCEEDS_BALANCE";
  if (!to) errors.toMemberId = "MEMBER_NOT_PARTICIPATING";
  else if (to.memberId === from?.memberId) errors.toMemberId = "SELF_TRANSFER";
  else if (to.netBalanceMinor <= 0) errors.toMemberId = "TRANSFER_EXCEEDS_BALANCE";

  const limit = Math.max(0, Math.min(-(from?.netBalanceMinor ?? 0), to?.netBalanceMinor ?? 0));
  const amount = parseAmount(draft.amount.trim(), data.activity.currency);
  if (!amount.ok) errors.amount = amount.error.code;
  else if (amount.value.amountMinor === 0) errors.amount = "NON_POSITIVE_AMOUNT";
  else if (limit > 0 && amount.value.amountMinor > limit) errors.amount = "TRANSFER_EXCEEDS_BALANCE";

  const occurredAt = expenseDateTimestamp(draft.date.trim(), now);
  if (occurredAt === undefined || occurredAt > now.getTime()) errors.date = "INVALID_EVENT_TIME";
  const prepared: PreparedRepayment | undefined = from && to && amount.ok && occurredAt !== undefined && Object.keys(errors).length === 0
    ? {
      occurredAt, expectedBalances: { fromNetBalanceMinor: from.netBalanceMinor, toNetBalanceMinor: to.netBalanceMinor },
      transfer: { ...amount.value, fromMemberId: from.memberId, toMemberId: to.memberId, note: draft.note.trim() || undefined },
      fromName: from.displayName, toName: to.displayName,
    }
    : undefined;
  return { errors, limit, occurredAt, prepared };
}
