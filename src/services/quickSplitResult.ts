import { copyFor, splitModeLabel, type Copy } from "./localizedCopy.ts";
import { calculateCharges, type CalculatedChargeDetails } from "../domain/charges.ts";
import { formatAmount, wholeBasisPoints, type Currency } from "../domain/money.ts";
import type { QuickSplitPreview } from "./quickSplitEditor.ts";
import type { AppLanguage } from "./appPreferences.ts";

type BreakdownLine = {
  readonly label: string;
  readonly amountMinor: number;
  readonly deduction?: boolean;
};

type ResultMember = {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly breakdown: readonly BreakdownLine[];
};

type ResultSuggestion = {
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly fromName: string;
  readonly toName: string;
  readonly amountMinor: number;
};

export type QuickSplitResultView = {
  readonly currency: Currency;
  readonly totalMinor: number;
  readonly allocatedMinor: bigint;
  readonly balanced: boolean;
  readonly modeLabel: string;
  readonly payerName?: string;
  readonly members: readonly ResultMember[];
  readonly suggestions: readonly ResultSuggestion[];
  readonly chargeBreakdown?: readonly BreakdownLine[];
  readonly roundingNote?: string;
};

type Split = QuickSplitPreview["snapshot"]["split"];
type Allocation = Split["allocations"][number];

export function formatResultAmount(currency: Currency, amountMinor: number | bigint): string {
  let amount: string;
  if (typeof amountMinor === "bigint" && amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    // A diagnostic sum may exceed the domain's safe integer range. Keep its digits exact.
    const zero = formatAmount({ currency, amountMinor: 0 });
    if (!zero.ok) return "—";
    const scale = zero.value.split(".")[1]?.length ?? 0;
    const digits = String(amountMinor).padStart(scale + 1, "0");
    amount = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  } else {
    const formatted = formatAmount({ currency, amountMinor: Number(amountMinor) });
    if (!formatted.ok) return "—";
    amount = formatted.value;
  }

  return amount;
}

export function formatResultMoney(currency: Currency, amountMinor: number | bigint): string {
  const amount = formatResultAmount(currency, amountMinor);
  if (amount === "—") return amount;
  const [whole, fraction] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

function memberBreakdown(
  allocation: Allocation, explanation: Split["explanation"], personalSpending: ReadonlyMap<string, number>, t: Copy,
): BreakdownLine[] {
  const { memberId, amountMinor } = allocation;
  const breakdown: BreakdownLine[] = [];
  const originalMinor = "baseMinor" in allocation ? allocation.baseMinor : amountMinor;
  switch (explanation.kind) {
    case "equal":
      breakdown.push({ label: t("均分基準"), amountMinor: explanation.baseMinor });
      if (originalMinor > explanation.baseMinor) {
        breakdown.push({ label: t("尾差"), amountMinor: originalMinor - explanation.baseMinor });
      }
      break;
    case "individual": {
      if ("items" in explanation) {
        for (const item of explanation.items) {
          const share = item.allocations.find((entry) => entry.memberId === memberId);
          if (share) breakdown.push({ label: item.name, amountMinor: share.amountMinor });
        }
        break;
      }
      const personalMinor = "personalMinor" in allocation ? allocation.personalMinor : personalSpending.get(memberId);
      if (personalMinor === undefined) {
        breakdown.push({ label: t("原始分攤"), amountMinor: originalMinor });
        break;
      }
      const sharedMinor = "sharedMinor" in allocation ? allocation.sharedMinor : originalMinor - personalMinor;
      breakdown.push({ label: t("個人消費"), amountMinor: personalMinor });
      if (explanation.sharedTotalMinor > 0 && explanation.sharedMemberIds.includes(memberId)) {
        breakdown.push({ label: t("公共消費分攤"), amountMinor: sharedMinor });
      }
      break;
    }
    case "treat": {
      if ("hosts" in explanation) {
        const host = explanation.hosts.find(({ hostId }) => hostId === memberId);
        if (host) breakdown.push({ label: t("請客承擔"), amountMinor: host.coveredMinor });
        if (!host || host.includeHostInRemainder) breakdown.push({
          label: t("剩餘均分"), amountMinor: amountMinor - (host?.coveredMinor ?? 0),
        });
        break;
      }
      const isHost = memberId === explanation.hostId;
      if (isHost) breakdown.push({ label: t("請客承擔"), amountMinor: explanation.coveredMinor });
      if (!isHost || explanation.includeHostInRemainder) {
        breakdown.push({
          label: t("剩餘均分"), amountMinor: isHost ? amountMinor - explanation.coveredMinor : amountMinor,
        });
      }
      break;
    }
    case "custom":
      breakdown.push({ label: t("自訂分攤"), amountMinor });
      break;
  }

  if ("serviceFeeMinor" in allocation && allocation.serviceFeeMinor > 0) {
    breakdown.push({ label: t("分配服務費"), amountMinor: allocation.serviceFeeMinor });
  }
  if ("discountMinor" in allocation && allocation.discountMinor > 0) {
    breakdown.push({ label: t("分配折扣"), amountMinor: allocation.discountMinor, deduction: true });
  }
  return breakdown;
}

function getRoundingNote(
  { input, snapshot: { split } }: QuickSplitPreview, charges: CalculatedChargeDetails | undefined, t: Copy,
) {
  const { explanation, total } = split;
  const notes: string[] = [];
  const equalRemainder = explanation.kind === "equal" ? explanation.extraMinorUnits
    : explanation.kind === "individual" && "sharedSplit" in explanation ? explanation.sharedSplit.extraMinorUnits
      : explanation.kind === "treat" ? explanation.remainderSplit.extraMinorUnits : 0;
  if (equalRemainder > 0) {
    const subject = explanation.kind === "individual" ? t("公共消費") : explanation.kind === "treat" ? t("請客後餘額") : t("分攤金額");
    notes.push(t("{0}未能整除。尾差按試算時的成員順序分配，獲分配尾差的成員在這一步各多分配 {1}。", subject, formatResultMoney(total.currency, 1)));
  }
  if (explanation.kind === "treat" && "cover" in explanation && explanation.cover.kind === "percentage"
    && BigInt(total.amountMinor) * BigInt(explanation.cover.basisPoints) % BigInt(wholeBasisPoints) !== 0n) {
    notes.push(t("按百分比計算的請客金額，已按幣種的最小貨幣單位四捨五入。"));
  }
  if (charges && input.charges.kind === "details" && input.charges.serviceFee?.kind === "quick10") {
    const basis = input.charges.serviceFee.basis === "afterDiscount"
      ? charges.subtotal.amountMinor - charges.discountMinor : charges.subtotal.amountMinor;
    if (basis % 10 !== 0) notes.push(t("快捷服務費已按幣種的最小貨幣單位四捨五入。"));
  }
  if (charges && charges.subtotal.amountMinor > 0 && input.charges.kind === "details" && !input.charges.distribution) {
    const subtotal = BigInt(charges.subtotal.amountMinor);
    const hasChargeRemainder = (amountMinor: number) => amountMinor > 0 && split.allocations.some((allocation: Allocation) =>
      "baseMinor" in allocation && BigInt(amountMinor) * BigInt(allocation.baseMinor) % subtotal !== 0n,
    );
    const parts = [
      hasChargeRemainder(charges.serviceFeeMinor) ? t("服務費") : "",
      hasChargeRemainder(charges.discountMinor) ? t("折扣") : "",
    ].filter(Boolean);
    if (parts.length > 0) {
      notes.push(t("{0}按原始分攤比例分配。尾差先分給小數餘額較大的成員，餘額相同時按試算順序分配。", parts.join(t("及"))));
    }
  }
  return notes.length ? notes.join(" ") : undefined;
}

export function describeQuickSplitResult(preview: QuickSplitPreview, language: AppLanguage = "zh-HK"): QuickSplitResultView {
  const t = copyFor(language);
  const { input, snapshot: { split, suggestions } } = preview;
  const { currency, amountMinor: totalMinor } = split.total;
  const names = new Map(input.members.map(({ id, displayName }) => [id, displayName]));
  const memberName = (id: string) => names.get(id) ?? id;
  const payerName = input.merchantPayerId === undefined ? undefined : memberName(input.merchantPayerId);
  const personalSpending = new Map(input.method.kind === "individual" && "personalSpending" in input.method
    ? input.method.personalSpending.map(({ memberId, personalMinor }) => [memberId, personalMinor]) : []);
  const members = split.allocations.map((allocation) => ({
    id: allocation.memberId, name: memberName(allocation.memberId), amountMinor: allocation.amountMinor,
    breakdown: memberBreakdown(allocation, split.explanation, personalSpending, t),
  }));
  const allocatedMinor = members.reduce((sum, member) => sum + BigInt(member.amountMinor), 0n);

  let charges: CalculatedChargeDetails | undefined;
  let chargeBreakdown: BreakdownLine[] | undefined;
  if (input.charges.kind === "details") {
    const calculated = calculateCharges(input.charges);
    if (calculated.ok && calculated.value.kind === "details") {
      charges = calculated.value;
      chargeBreakdown = [{ label: t("商品小計"), amountMinor: charges.subtotal.amountMinor }];
      if (charges.serviceFeeMinor > 0) chargeBreakdown.push({ label: t("服務費"), amountMinor: charges.serviceFeeMinor });
      if (charges.discountMinor > 0) chargeBreakdown.push({ label: t("折扣"), amountMinor: charges.discountMinor, deduction: true });
    }
  }

  return {
    currency, totalMinor, allocatedMinor, balanced: allocatedMinor === BigInt(totalMinor),
    modeLabel: splitModeLabel(t, split.explanation.kind),
    payerName, members, chargeBreakdown,
    suggestions: payerName === undefined ? [] : suggestions.map(({ fromMemberId, toMemberId, amountMinor }) => ({
      fromMemberId, toMemberId, fromName: memberName(fromMemberId), toName: memberName(toMemberId), amountMinor,
    })),
    roundingNote: getRoundingNote(preview, charges, t),
  };
}
