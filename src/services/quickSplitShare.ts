import type { AppLanguage } from "./appPreferences.ts";
import { formatResultMoney, type QuickSplitResultView } from "./quickSplitResult.ts";

export function buildQuickSplitShareCard(result: QuickSplitResultView, generatedAt: Date, language: AppLanguage = "zh-HK") {
  const money = (amountMinor: number) => formatResultMoney(result.currency, amountMinor);
  return {
    language,
    total: money(result.totalMinor),
    mode: result.modeLabel,
    memberCount: result.members.length,
    members: result.members.map(({ id, name, amountMinor }) => ({ id, name, amount: money(amountMinor) })),
    payment: result.payerName === undefined ? undefined : {
      payerName: result.payerName,
      transfers: result.suggestions.map(({ fromMemberId, toMemberId, fromName, toName, amountMinor }) => ({
        fromMemberId, toMemberId, fromName, toName, amount: money(amountMinor),
      })),
    },
    roundingNote: result.roundingNote,
    generatedAt: new Intl.DateTimeFormat(language === "en" ? "en-HK" : language, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23", timeZoneName: "short",
    }).format(generatedAt),
  };
}

export type QuickSplitShareCard = ReturnType<typeof buildQuickSplitShareCard>;
