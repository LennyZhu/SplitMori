import type { Copy } from "../services/localizedCopy.ts";
import type { EditorError } from "../services/quickSplitEditor.ts";

export function validationMessage(t: Copy, { code, field }: EditorError) {
  switch (code) {
    case "NEGATIVE_AMOUNT": return t("金額不可小於 0。");
    case "INVALID_AMOUNT_PRECISION": return t("小數位數超出此幣種的上限。");
    case "AMOUNT_OVERFLOW": return t("金額過大，請核對後再試。");
    case "UNSUPPORTED_CURRENCY": return t("請選擇支援的幣種。");
    case "INVALID_PERCENTAGE": return t("請輸入 0 至 100 的百分比，最多兩位小數。");
    case "COVER_EXCEEDS_TOTAL": return t("請客金額不可超過實際帳單總額。");
    case "HOST_NOT_PARTICIPATING": return t("請選擇一位請客者。");
    case "NO_REMAINDER_PARTICIPANTS": return t("請增加分攤成員，或讓請客者參與餘額分攤。");
    case "NO_PARTICIPANTS": return field === "sharedMembers" ? t("請選擇至少一位公共消費參與者。") : t("請選擇至少一位參與成員。");
    case "DISCOUNT_EXCEEDS_SUBTOTAL": return t("折扣不可超過商品小計。");
    case "NO_CHARGE_WEIGHTS": return t("有服務費時，請核對商品小計及分攤金額。");
    case "SERVICE_FEE_CONFLICT": return t("請選擇一種服務費計算方式。");
    case "TOTAL_MISMATCH": return field === "finalTotal"
      ? t("按明細計算的總額與實際帳單不符，請核對小計、折扣及服務費。")
      : t("個人與公共消費的合計不符，請核對實付總額或商品小計。");
    default:
      if (field === "merchantPayerId") return t("請重新選擇付款人，或保留為未指定。");
      if (field === "hostId") return t("請選擇一位請客者。");
      if (field === "members") return t("請檢查參與成員。");
      return t("請輸入有效金額。");
  }
}
