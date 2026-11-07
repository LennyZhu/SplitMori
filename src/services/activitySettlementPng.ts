import type { LocalDatabase } from "../data/database.ts";
import { normalizeAppLanguage, type AppLanguage } from "./appPreferences.ts";
import { loadActivitySettlement, type ActivitySettlementData } from "./activitySettlement.ts";
import { formatResultMoney } from "./quickSplitResult.ts";

export type SettlementPngLanguage = AppLanguage;

export const settlementPngCopy = {
  "zh-HK": {
    entry: "生成結算圖（PNG）", preview: "結算圖預覽", actions: "儲存或分享", savedTitle: "儲存成功",
    snapshot: "活動結算快照", template: "標準黑白 · Free", templateFile: "PNG · 標準黑白模板",
    ready: "PNG 已生成", chooseAction: "選擇下一步操作", backToSettlement: "返回活動結算",
    backToPreview: "返回預覽", language: "輸出語言", save: "儲存到相簿", saveHint: "儲存圖片至 iPhone 相簿",
    share: "系統分享", shareHint: "WhatsApp、訊息、AirDrop 等", regenerate: "重新生成", regenerateHint: "從最新帳本重新產生",
    previewNote: "圖片僅用於分享，不會記錄或更改還款。",
    shareNote: "分享由系統處理。關閉分享面板不代表圖片已傳送。",
    saved: "結算圖已儲存", savedHint: "圖片已儲存到相簿。", generating: "正在生成結算圖…", saving: "正在儲存到相簿…",
    generateFailed: "未能生成結算圖，請重試。", readFailed: "未能讀取活動結算，請重試。",
    keepPrevious: "目前仍顯示上一張結算圖。", imageMissing: "未能載入這張結算圖，請重新生成。",
    saveFailed: "未能儲存到相簿，請重試。", saveDenied: "未獲准加入相片。可在系統設定允許後再試，或使用系統分享。",
    saveCancelled: "已取消儲存。", photosUnavailable: "此裝置暫不支援儲存到相簿。", shareUnavailable: "此裝置暫不支援系統分享。",
    shareFailed: "未能開啟系統分享，請重試。", completedUnsettled: "活動已完成，但款項仍未結清", settledBadge: "已結清 · 無待轉帳建議",
    imageLabel: "活動結算圖", fileSuffix: "活動結算圖", kicker: "ACTIVITY SETTLEMENT / 活動結算", active: "進行中",
    completed: "已完成", unsettled: "未結清", settled: "已結清", empty: "暫無財務紀錄", outstanding: "尚待結算",
    effective: "活動有效費用", refund: "有效商家退款", repayment: "已登記成員還款", members: "成員結算",
    memberCount: (count: number) => `${count} 位成員`,
    transfers: "轉帳建議", transferCount: (count: number) => `${count} 筆`, receive: "應收", pay: "應付", balanced: "已平衡",
    net: "淨額", noTransfers: "目前無需轉帳。", allSettled: "所有成員已結清，目前無需轉帳。", noMembers: "暫無活動成員。",
    disclaimer: "此圖為活動結算快照，轉帳建議不代表已完成付款。", source: "以 SplitMori 內已登記的實際還款為準。",
    generated: "生成時間", dateUnavailable: "日期未能讀取", unknownMember: "未知成員",
  },
  en: {
    entry: "Generate settlement PNG", preview: "Settlement image preview", actions: "Save or share", savedTitle: "Saved",
    snapshot: "Activity settlement snapshot", template: "Black & white · Free", templateFile: "PNG · Black & white",
    ready: "PNG ready", chooseAction: "Choose an action", backToSettlement: "Back to activity settlement",
    backToPreview: "Back to preview", language: "Image language", save: "Save to Photos", saveHint: "Add the image to iPhone Photos",
    share: "System share", shareHint: "WhatsApp, Messages, AirDrop and more", regenerate: "Regenerate", regenerateHint: "Use the latest ledger",
    previewNote: "This image is for sharing. It leaves repayment records intact.",
    shareNote: "Sharing is handled by your device. Closing the share sheet does not confirm delivery.",
    saved: "Settlement image saved", savedHint: "The image was added to Photos.", generating: "Generating settlement image…", saving: "Saving to Photos…",
    generateFailed: "Couldn’t generate the settlement image. Try again.", readFailed: "Couldn’t load the activity settlement. Try again.",
    keepPrevious: "The previous image is still shown.", imageMissing: "Couldn’t load this image. Regenerate it to continue.",
    saveFailed: "Couldn’t save to Photos. Try again.", saveDenied: "Photos access was denied. Allow adding photos in Settings, or use system share.",
    saveCancelled: "Save cancelled.", photosUnavailable: "Saving to Photos is unavailable on this device.", shareUnavailable: "System sharing is unavailable on this device.",
    shareFailed: "Couldn’t open system sharing. Try again.", completedUnsettled: "Activity completed · Payments outstanding", settledBadge: "Settled · No suggested transfers",
    imageLabel: "Activity settlement image", fileSuffix: "Activity settlement", kicker: "ACTIVITY SETTLEMENT", active: "In progress",
    completed: "Completed", unsettled: "Unsettled", settled: "Settled", empty: "No financial records yet", outstanding: "Outstanding",
    effective: "Effective expenses", refund: "Effective merchant refunds", repayment: "Recorded member repayments", members: "Member balances",
    memberCount: (count: number) => `${count} ${count === 1 ? "member" : "members"}`,
    transfers: "Suggested transfers", transferCount: (count: number) => `${count} ${count === 1 ? "transfer" : "transfers"}`,
    receive: "To receive", pay: "To pay", balanced: "Balanced", net: "Net", noTransfers: "No transfers are needed right now.",
    allSettled: "Everyone is settled. No transfers are needed.", noMembers: "There are no activity members yet.",
    disclaimer: "This is a settlement snapshot. Suggested transfers are not completed payments.", source: "Refer to actual repayments recorded in SplitMori.",
    generated: "Generated", dateUnavailable: "Date unavailable", unknownMember: "Unknown member",
  },
} as const;

export function resolveSettlementPngLanguages({ appLocale, preferredLocale, systemLocale, selectedOutputLanguage }: {
  appLocale?: string;
  preferredLocale?: string;
  systemLocale?: string;
  selectedOutputLanguage?: SettlementPngLanguage;
}) {
  // A locale already resolved by the App takes precedence over device settings.
  const appLanguage = normalizeAppLanguage(appLocale) ?? normalizeAppLanguage(preferredLocale) ?? normalizeAppLanguage(systemLocale) ?? "en";
  return { appLanguage, outputLanguage: selectedOutputLanguage ?? appLanguage, copy: settlementPngCopy[appLanguage] };
}

const currencyNames = { HKD: "港幣", CNY: "人民幣", MOP: "澳門元", TWD: "新台幣", USD: "美元", JPY: "日圓" } as const;

export function captureSettlementSnapshot(data: ActivitySettlementData, generatedAt: Date) {
  const { activity, status, outstandingMinor, effectiveMinor, refundMinor, repaymentMinor } = data;
  return {
    name: activity.name, createdAt: activity.createdAt, currency: activity.currency, activityStatus: activity.status, status,
    generatedAt: generatedAt.getTime(), outstandingMinor, effectiveMinor, refundMinor, repaymentMinor,
    members: data.members.map(({ memberId, displayName, netBalanceMinor }) => ({ memberId, displayName, netBalanceMinor })),
    suggestions: data.suggestions.map(({ fromMemberId, toMemberId, amountMinor }) => ({ fromMemberId, toMemberId, amountMinor })),
  };
}

export type SettlementPngSnapshot = ReturnType<typeof captureSettlementSnapshot>;

export async function loadSettlementPngSnapshot(activityId: string, database?: LocalDatabase) {
  const data = await loadActivitySettlement(activityId, database);
  return data ? captureSettlementSnapshot(data, new Date()) : null;
}

export function buildSettlementPngCard(snapshot: SettlementPngSnapshot, language: SettlementPngLanguage) {
  const copy = settlementPngCopy[language];
  const currency = snapshot.currency;
  const money = (amountMinor: number | bigint) => formatResultMoney(currency, amountMinor);
  const date = (timestamp: number, withTime = false) => Number.isFinite(new Date(timestamp).getTime())
    ? new Intl.DateTimeFormat(language === "en" ? "en-HK" : language,
      withTime ? { dateStyle: "medium", timeStyle: "short" } : { year: "numeric", month: "long", day: "numeric" }).format(timestamp)
    : copy.dateUnavailable;
  const counts = new Map<string, number>();
  for (const { displayName } of snapshot.members) counts.set(displayName, (counts.get(displayName) ?? 0) + 1);
  const members = snapshot.members.map(({ memberId, displayName, netBalanceMinor }, index) => ({
    id: memberId, name: counts.get(displayName) === 1 ? displayName : `${displayName} (${index + 1})`,
    initial: Array.from(displayName.trim())[0]?.toUpperCase() ?? "–",
    direction: netBalanceMinor > 0 ? copy.receive : netBalanceMinor < 0 ? copy.pay
      : snapshot.status === "settled" ? copy.settled : snapshot.status === "empty" ? copy.net : copy.balanced,
    amount: money(Math.abs(netBalanceMinor)),
  }));
  const labels = new Map(members.map(({ id, name }) => [id, name]));
  const nameFor = (id: string) => labels.get(id) ?? copy.unknownMember;
  const safeName = Array.from(snapshot.name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").trim()).slice(0, 45).join("");
  return {
    language, name: snapshot.name, currency, currencyLabel: language === "zh-HK" ? `${currencyNames[currency]} ${currency}` : currency,
    activityDate: date(snapshot.createdAt), generatedAt: date(snapshot.generatedAt, true),
    activityStatus: copy[snapshot.activityStatus], settlementStatus: copy[snapshot.status],
    settled: snapshot.status === "settled",
    outstanding: money(snapshot.outstandingMinor), effective: money(snapshot.effectiveMinor),
    refund: money(snapshot.refundMinor), repayment: money(snapshot.repaymentMinor), members,
    transfers: snapshot.suggestions.map(({ fromMemberId, toMemberId, amountMinor }) => ({
      id: JSON.stringify([fromMemberId, toMemberId]), from: nameFor(fromMemberId), to: nameFor(toMemberId), amount: money(amountMinor),
    })),
    emptyTransfers: snapshot.status === "empty" ? copy.empty : snapshot.status === "settled" ? copy.allSettled : copy.noTransfers,
    fileName: `${safeName || "SplitMori"}—${copy.fileSuffix}.png`,
  };
}

export type SettlementPngCard = ReturnType<typeof buildSettlementPngCard>;

// Leave headroom below the native bitmap limits and round up to whole pixels to contain every row.
export function settlementPngLayout(width: number, height: number, pixelRatio: number) {
  const scale = Math.min(1, 16_000 / (width * pixelRatio), 16_000 / (height * pixelRatio),
    Math.sqrt(18_000_000 / (width * height * pixelRatio ** 2)));
  return {
    scale, width: Math.ceil(width * scale * pixelRatio) / pixelRatio, height: Math.ceil(height * scale * pixelRatio) / pixelRatio,
  };
}
