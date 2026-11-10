import type { DomainErrorCode } from "../domain/result.ts";
import type { AppLanguage } from "../services/appPreferences.ts";

const messages = {
  "zh-HK": {
    heading: "誰向商家付款？", payer: "實際付款人", choose: "選擇實際付款人",
    multiple: "由多人付款", single: "改用單人付款", add: "新增付款人", remove: "移除付款人",
    paid: "實際付款金額", paidTotal: "付款合計", remaining: "尚未分配", excess: "超出帳單",
    separate: "商家付款與每人應承擔額分開記錄。",
    required: "請為每筆付款選擇有效的活動成員。",
    duplicate: "每位成員只可在同一筆費用記錄一次付款。",
    invalid: "請輸入大於零且符合幣種精度的付款金額。",
    billRequired: "請先輸入有效的實際帳單總額。",
    mismatch: "付款合計必須等於實際帳單總額。",
    proRequired: "多人付款需要目前已確認的 Pro 權益。",
    learn: "了解 Pro", cancel: "繼續編輯",
    refundRecipient: "有多位原付款人，請選擇實際收到退款的成員。",
  },
  en: {
    heading: "Who paid the merchant?", payer: "Merchant payer", choose: "Choose the person who paid",
    multiple: "Paid by multiple people", single: "Use one payer", add: "Add payer", remove: "Remove payer",
    paid: "Amount paid", paidTotal: "Total paid", remaining: "Unallocated", excess: "Over the bill total",
    separate: "Merchant payments are recorded separately from each member’s share.",
    required: "Choose an activity member for each payment.",
    duplicate: "Record each member only once per expense.",
    invalid: "Enter a positive payment using the currency’s decimal precision.",
    billRequired: "Enter a valid bill total first.",
    mismatch: "The payments must add up to the actual bill total.",
    proRequired: "Multiple payers require currently verified Pro access.",
    learn: "Explore Pro", cancel: "Keep editing",
    refundRecipient: "There were multiple payers. Choose the member who actually received the refund.",
  },
};

export const merchantPaymentCopy = (language: AppLanguage) => messages[language];

export function merchantPaymentError(code: DomainErrorCode, copy: ReturnType<typeof merchantPaymentCopy>) {
  switch (code) {
    case "PRO_REQUIRED": return copy.proRequired;
    case "DUPLICATE_MEMBER_ID": return copy.duplicate;
    case "TOTAL_MISMATCH": return copy.mismatch;
    case "MEMBER_NOT_PARTICIPATING":
    case "MISSING_MERCHANT_PAYMENT": return copy.required;
    default: return copy.invalid;
  }
}
