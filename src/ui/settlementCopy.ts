import { useContext } from "react";
import { settlementPngCopy } from "../services/activitySettlementPng.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";

const copy = {
  "zh-HK": {
    overview: "結算總覽", membersTab: "每人收支", allSettled: "款項已全部結清", independent: "結清狀態與活動是否完成無關。",
    addForTransfers: "新增費用後，即可查看轉帳建議。", addForSummary: "新增費用後，即可查看成員收支及結算狀態。",
    latest: "最新結算", settlementStatus: "目前結算狀態", paymentStatus: "目前款項狀態",
    validRepayments: "有效已登記還款", noMoreTransfers: "目前無需再轉帳", independentDetail: "完成活動與款項結清是兩個獨立狀態。",
    currentOutstanding: "目前尚待結算", pendingTransfers: "尚待轉帳", autoCalculated: "依目前帳務自動計算",
    history: "歷史記錄", viewHistory: "查看還款記錄", voided: "已作廢", paidMerchant: "實際商家付款",
    receivedRefund: "已收到商家退款", allocated: "應承擔費用", sentRepayment: "已支付成員還款", receivedRepayment: "已收到成員還款",
    currentNet: "目前淨額", recordedPayment: "已登記的實際還款", suggestionOnly: "此筆為建議，不代表已付款或已登記還款。",
    note: "備註", direction: "建議付款方向", selectSuggestion: "請選擇一筆建議，再記錄實際還款。", recorded: "已登記的還款",
    memberDetails: "成員收支明細", eachMember: "每位成員", memberNote: "付款與分攤分開計算。有效退款及已登記還款均計入淨額。",
    shareHint: "預覽並分享目前的活動結算", important: "重要說明", actualTransfer: "轉帳建議依目前淨額產生。實際轉帳後，須另行記錄還款，帳本才會更新。",
    howUpdated: "資料如何更新？", updateNote: "新增費用、商家退款、費用更正或登記還款後，建議會依最新帳務更新。",
    viewTransfers: "查看轉帳建議", recordRepayment: "記錄還款", back: "返回活動詳情", title: "活動結算",
    loading: "正在讀取結算資料", loadFailed: "未能讀取結算資料，請重試。", retry: "重新讀取", notFound: "找不到這個活動。",
    expenses: (n: number) => `${n} 筆`,
    suggestionCount: (n: number) => `共 ${n} 筆建議 · 尚未記錄這些轉帳`,
    historyLine: (n: number, amount: string) => `${n} 筆歷史 · 有效 ${amount}`,
    transferFromTo: (from: string, to: string) => `由 ${from} 轉給 ${to}`,
  },
  en: {
    overview: "Overview", membersTab: "Members", allSettled: "All payments settled", independent: "Settlement is independent of activity status.",
    addForTransfers: "Add an expense to see suggested transfers.", addForSummary: "Add an expense to see member balances and settlement status.",
    latest: "Current settlement", settlementStatus: "Settlement status", paymentStatus: "Payment status",
    validRepayments: "Valid recorded repayments", noMoreTransfers: "No more transfers needed", independentDetail: "Activity completion and settlement are separate.",
    currentOutstanding: "Currently outstanding", pendingTransfers: "Transfers outstanding", autoCalculated: "Calculated from current balances",
    history: "History", viewHistory: "View repayment history", voided: "Voided", paidMerchant: "Paid to merchants",
    receivedRefund: "Merchant refunds received", allocated: "Expense share", sentRepayment: "Repayments sent", receivedRepayment: "Repayments received",
    currentNet: "Current net balance", recordedPayment: "Recorded repayment", suggestionOnly: "This is a suggestion. Payment and repayment have yet to be recorded.",
    note: "Note", direction: "Suggested payment direction", selectSuggestion: "Select a suggestion to record an actual repayment.", recorded: "Recorded repayments",
    memberDetails: "Member balance details", eachMember: "Each member", memberNote: "Payments and shares are calculated separately. Valid refunds and recorded repayments are included.",
    shareHint: "Preview and share the current settlement", important: "Important", actualTransfer: "Suggestions are based on current balances. Record an actual repayment to update the ledger after transferring.",
    howUpdated: "When do balances update?", updateNote: "Suggestions update after expenses, refunds, corrections or repayments are recorded.",
    viewTransfers: "View suggested transfers", recordRepayment: "Record repayment", back: "Back to activity details", title: "Activity settlement",
    loading: "Loading settlement", loadFailed: "Couldn’t load the settlement. Try again.", retry: "Reload", notFound: "Activity not found.",
    expenses: (n: number) => `${n} ${n === 1 ? "expense" : "expenses"}`,
    suggestionCount: (n: number) => `${n} ${n === 1 ? "suggestion" : "suggestions"} · Transfers still to be recorded`,
    historyLine: (n: number, amount: string) => `${n} ${n === 1 ? "record" : "records"} · Valid ${amount}`,
    transferFromTo: (from: string, to: string) => `From ${from} to ${to}`,
  },
};

export function useSettlementCopy() {
  const language = useContext(AppLanguageContext);
  return { ...settlementPngCopy[language], ...copy[language], locale: language === "en" ? "en-HK" : language };
}
