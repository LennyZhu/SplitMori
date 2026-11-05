import type { ActivityBalances, MemberBalance } from "./balance.ts";
import { isCurrency, validateMinorAmount, type Currency, type Money } from "./money.ts";
import { failure, type Result } from "./result.ts";
import { validateMemberIds } from "./split.ts";

export type SettlementBalances = {
  readonly currency: ActivityBalances["currency"];
  readonly balances: readonly (Pick<MemberBalance, "memberId" | "netBalanceMinor"> & {
    /** A labeled row must use the activity currency. */
    readonly currency?: Currency;
  })[];
};

export type TransferSuggestion = Money & {
  readonly fromMemberId: string;
  readonly toMemberId: string;
};

type RemainingBalance = { memberId: string; amountMinor: number };

// Sort the highest remaining balance last for pop(), with ascending IDs breaking ties.
function compareForPop(left: RemainingBalance, right: RemainingBalance): number {
  if (left.amountMinor !== right.amountMinor) return left.amountMinor - right.amountMinor;
  if (left.memberId === right.memberId) return 0;
  return left.memberId < right.memberId ? 1 : -1;
}

function reinsertRemaining(queue: RemainingBalance[], balance: RemainingBalance, settledMinor: number): void {
  balance.amountMinor -= settledMinor;
  if (balance.amountMinor === 0) return;

  const index = queue.findIndex((other) => compareForPop(balance, other) < 0);
  if (index === -1) queue.push(balance);
  else queue.splice(index, 0, balance);
}

/** Suggests direct payments from a balance snapshot without recording any transfers. */
export function suggestTransfers(
  { currency, balances }: SettlementBalances,
): Result<readonly TransferSuggestion[]> {
  if (!isCurrency(currency)) return failure("UNSUPPORTED_CURRENCY", "currency");
  if (balances.length === 0) return { ok: true, value: [] };
  const invalidMembers = validateMemberIds(balances.map(({ memberId }) => memberId));
  if (invalidMembers) return invalidMembers;

  const debtors: RemainingBalance[] = [];
  const creditors: RemainingBalance[] = [];
  let netTotal = 0n;

  for (const { memberId, netBalanceMinor, currency: memberCurrency } of balances) {
    if (memberCurrency !== undefined && memberCurrency !== currency) {
      return failure("CURRENCY_MISMATCH", "currency");
    }
    if (typeof netBalanceMinor !== "number") return failure("INVALID_AMOUNT", "netBalanceMinor");
    const amountMinor = Math.abs(netBalanceMinor);
    const invalidAmount = validateMinorAmount(amountMinor, "netBalanceMinor");
    if (invalidAmount) return invalidAmount;

    netTotal += BigInt(netBalanceMinor);
    if (netBalanceMinor < 0) debtors.push({ memberId, amountMinor });
    if (netBalanceMinor > 0) creditors.push({ memberId, amountMinor });
  }
  if (netTotal !== 0n) return failure("UNBALANCED_NET_BALANCES", "netBalanceMinor");

  debtors.sort(compareForPop);
  creditors.sort(compareForPop);
  const suggestions: TransferSuggestion[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    const debtor = debtors.pop()!;
    const creditor = creditors.pop()!;
    const amountMinor = Math.min(debtor.amountMinor, creditor.amountMinor);
    suggestions.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, currency, amountMinor });
    reinsertRemaining(debtors, debtor, amountMinor);
    reinsertRemaining(creditors, creditor, amountMinor);
  }
  return { ok: true, value: suggestions };
}
