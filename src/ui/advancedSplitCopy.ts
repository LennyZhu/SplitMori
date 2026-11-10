import type { AppLanguage } from "../services/appPreferences.ts";
import type { EditorError } from "../services/quickSplitEditor.ts";

const messages = {
  "zh-HK": {
    custom: "自訂分攤", fixed: "固定金額", percentage: "百分比（%）", shares: "份數",
    addHost: "新增請客者", host: "請客者",
    remainder: "亦參與餘額分攤", remove: "移除", oneHost: "改用單人請客",
    itemize: "按項目分帳", byPerson: "改用各人消費總額", addItem: "新增項目", item: "項目",
    itemName: "項目名稱", quantity: "數量", itemTotal: "項目總金額",
    itemHelp: "輸入整個項目的金額。每項由所選成員均分，數量供記錄。",
    participants: "分攤成員", excluded: "不參與", charge: "更多費用分配方式",
    serviceFee: "服務費分配", discount: "折扣分配",
    proportional: "按消費比例", equal: "全部均分", selected: "指定成員均分", defaultDistribution: "改回按消費比例",
    locked: "需要有效的 Pro 權益才能使用此功能。", upgrade: "了解 Pro", cancel: "繼續編輯",
    addToActivity: "加入進階分帳至活動",
    selectHost: "請選擇不同的參與成員作為請客者。",
    hostTotal: "所有請客者的承擔合計不可超過帳單總額。",
    hostRemainder: "請至少選一位成員分攤餘額。",
    itemInvalid: "請核對項目名稱、正整數數量及金額。",
    itemMembers: "每個項目須選擇至少一位有效的分攤成員。",
    itemSum: "項目總額合計必須等於實付總額或費用明細中的商品小計。",
    customSum: "固定金額合計必須等於帳單總額。",
    percentSum: "百分比合計必須等於 100%。",
    invalidPercent: "請輸入 0 至 100 的百分比，最多兩位小數。",
    invalidShares: "份數必須為正整數。",
    invalidMoney: "請輸入有效金額並核對幣種精度。",
    chargeMembers: "請選擇至少一位有效的費用分攤成員。",
    negativeShare: "折扣分配令部分成員的承擔低於零。請調整分配。",
    details: "費用明細", subtotal: "商品小計", fee: "服務費", discountTotal: "整單折扣",
    committed: "請客承擔", sharesRemainder: "參與餘額分攤", noRemainder: "不參與餘額分攤",
  },
  en: {
    custom: "Custom split", fixed: "Fixed amount", percentage: "Percentage (%)", shares: "Shares",
    addHost: "Add a host", host: "Host",
    remainder: "Also split the remainder", remove: "Remove", oneHost: "Use one host",
    itemize: "Split by item", byPerson: "Use totals by person", addItem: "Add an item", item: "Item",
    itemName: "Item name", quantity: "Quantity", itemTotal: "Total for this item",
    itemHelp: "Enter the total for the whole item. Selected members split it equally. Quantity is for reference.",
    participants: "Participants", excluded: "Not participating", charge: "More charge allocation options",
    serviceFee: "Service fee allocation", discount: "Discount allocation",
    proportional: "By spending", equal: "Split among all", selected: "Split among selected members", defaultDistribution: "Use spending proportions",
    locked: "An active Pro entitlement is required for this feature.", upgrade: "Explore Pro", cancel: "Keep editing",
    addToActivity: "Add an advanced split to an activity",
    selectHost: "Choose a different participating member for each host.",
    hostTotal: "Host commitments together cannot exceed the bill total.",
    hostRemainder: "Choose at least one member to split the remainder.",
    itemInvalid: "Check the item name, positive whole quantity, and amount.",
    itemMembers: "Select at least one eligible participant for each item.",
    itemSum: "Item totals must add up to the final bill or the item subtotal in charge details.",
    customSum: "Fixed amounts must add up to the bill total.",
    percentSum: "Percentages must add up to 100%.",
    invalidPercent: "Enter a percentage from 0 to 100 with up to two decimal places.",
    invalidShares: "Enter a positive whole number of shares.",
    invalidMoney: "Enter a valid amount using the currency’s decimal precision.",
    chargeMembers: "Select at least one eligible participant for this charge.",
    negativeShare: "The discount would leave someone with a negative share. Adjust the allocation.",
    details: "Expense details", subtotal: "Item subtotal", fee: "Service fee", discountTotal: "Bill discount",
    committed: "Host commitment", sharesRemainder: "Splits the remainder", noRemainder: "Doesn’t split the remainder",
  },
};

export const advancedSplitCopy = (language: AppLanguage) => messages[language];

export function advancedEditorMessage({ code, field }: EditorError, language: AppLanguage, isPercent = false): string | undefined {
  const copy = advancedSplitCopy(language);
  if (code === "PRO_REQUIRED") return copy.locked;
  switch (field) {
    case "hosts":
      if (code === "COVER_EXCEEDS_TOTAL") return copy.hostTotal;
      if (code === "NO_REMAINDER_PARTICIPANTS") return copy.hostRemainder;
      if (code === "INVALID_PERCENTAGE") return copy.invalidPercent;
      if (code === "INVALID_AMOUNT" || code === "INVALID_AMOUNT_PRECISION" || code === "NEGATIVE_AMOUNT") return copy.invalidMoney;
      return copy.selectHost;
    case "items":
      if (code === "TOTAL_MISMATCH") return copy.itemSum;
      if (code === "NO_PARTICIPANTS" || code === "MEMBER_NOT_PARTICIPATING") return copy.itemMembers;
      return copy.itemInvalid;
    case "custom":
      if (code === "TOTAL_MISMATCH") return isPercent ? copy.percentSum : copy.customSum;
      if (code === "INVALID_PERCENTAGE") return copy.invalidPercent;
      if (code === "INVALID_SHARE_COUNT") return copy.invalidShares;
      return copy.invalidMoney;
    case "chargeDistribution": return code === "CHARGE_SHARE_NEGATIVE" ? copy.negativeShare : copy.chargeMembers;
  }
}
