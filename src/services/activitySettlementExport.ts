import { settlementPngCopy, type SettlementPngCard, type SettlementPngSnapshot } from "./activitySettlementPng.ts";
import { formatResultAmount } from "./quickSplitResult.ts";

export type SettlementDocumentFormat = "pdf" | "csv";
type SettlementPreview = { readonly snapshot: SettlementPngSnapshot; readonly card: SettlementPngCard };

const documentLabels = {
  "zh-HK": {
    document: "活動結算", activity: "活動", date: "活動日期", activityStatus: "活動狀態", settlementStatus: "結算狀態",
    summary: "財務摘要", currency: "幣種", section: "區段", item: "項目", member: "成員", payer: "建議付款人",
    memberOrPayer: "成員／建議付款人", recipient: "建議收款人", amount: "金額", value: "內容",
  },
  en: {
    document: "Activity settlement", activity: "Activity", date: "Activity date", activityStatus: "Activity status",
    settlementStatus: "Settlement status", summary: "Financial summary", currency: "Currency", section: "Section", item: "Item",
    member: "Member", payer: "Suggested payer", memberOrPayer: "Member / suggested payer", recipient: "Suggested recipient",
    amount: "Amount", value: "Value",
  },
} as const;

const htmlEntities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => htmlEntities[character]);
const htmlRow = (cells: readonly string[], tag = "td") => `<tr>${cells.map((text) => `<${tag}>${escapeHtml(text)}</${tag}>`).join("")}</tr>`;
const htmlTable = (headers: readonly string[], rows: readonly (readonly string[])[]) =>
  `<table><thead>${htmlRow(headers, "th")}</thead><tbody>${rows.map((cells) => htmlRow(cells)).join("")}</tbody></table>`;

function summary({ snapshot, card }: SettlementPreview) {
  const copy = settlementPngCopy[card.language];
  return [
    { label: copy.effective, display: card.effective, minor: snapshot.effectiveMinor },
    { label: copy.refund, display: card.refund, minor: snapshot.refundMinor },
    { label: copy.repayment, display: card.repayment, minor: snapshot.repaymentMinor },
    { label: copy.outstanding, display: card.outstanding, minor: snapshot.outstandingMinor },
  ];
}

function buildPdfHtml(preview: SettlementPreview) {
  const { card } = preview;
  const copy = settlementPngCopy[card.language];
  const label = documentLabels[card.language];
  const balances = card.members.map(({ name, direction, amount }) => [name, direction, amount]);
  const transfers = card.transfers.map(({ from, to, amount }) => [from, to, amount]);
  return `<!DOCTYPE html>
<html lang="${card.language}"><head><meta charset="utf-8"><title>${escapeHtml(label.document)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body{margin:0;color:#282828;background:#fff;font:12px/1.5 -apple-system,"Helvetica Neue",sans-serif}
  h1{font-size:24px;margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;break-after:avoid}
  h2{font-size:15px;margin:20px 0 5px;break-after:avoid}
  p{margin:5px 0;overflow-wrap:anywhere}
  header{border-bottom:1px solid #e7e5e2;padding-bottom:10px}
  header p,footer{color:#575757}
  table{border-collapse:collapse;table-layout:fixed;width:100%;font-variant-numeric:tabular-nums}
  tr{break-inside:avoid;page-break-inside:avoid}
  th,td{border-bottom:1px solid #e7e5e2;padding:6px 8px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}
  th:first-child,td:first-child{padding-left:0}
  th:last-child,td:last-child{text-align:right;padding-right:0;width:33%}
  footer{margin-top:18px;font-size:10px;break-inside:avoid}
</style></head><body>
<header><strong>SplitMori · ${escapeHtml(label.document)}</strong><h1>${escapeHtml(card.name)}</h1>
<p>${escapeHtml(card.activityDate)} · ${escapeHtml(card.currencyLabel)}</p>
<p>${escapeHtml(label.activityStatus)} · ${escapeHtml(card.activityStatus)}<br>${escapeHtml(label.settlementStatus)} · ${escapeHtml(card.settlementStatus)}</p></header>
<h2>${label.summary}</h2>${htmlTable([label.item, label.amount], summary(preview).map(({ label, display }) => [label, display]))}
<h2>${copy.members}</h2>${balances.length ? htmlTable([label.member, label.settlementStatus, label.amount], balances) : `<p>${copy.noMembers}</p>`}
<h2>${copy.transfers}</h2>${transfers.length ? htmlTable([label.payer, label.recipient, label.amount], transfers) : `<p>${card.emptyTransfers}</p>`}
<footer><p>${copy.disclaimer}</p><p>${copy.source}</p><p>${copy.generated} · ${escapeHtml(card.generatedAt)}</p></footer>
</body></html>`;
}

function spreadsheetText(value: string) {
  // Spreadsheet apps may interpret formula prefixes even after trimming leading whitespace or format characters.
  const trimmed = value.replace(/^[\s\p{Cc}\p{Cf}]+/u, "");
  return /^[=+\-@＝＋－＠]/u.test(trimmed) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
}

function buildCsv(preview: SettlementPreview) {
  const { snapshot, card } = preview;
  const copy = settlementPngCopy[card.language];
  const label = documentLabels[card.language];
  const currency = card.currency;
  const amount = (minor: number | bigint) => formatResultAmount(currency, minor);
  const metadata = (item: string, value: string) => [label.activity, item, "", "", "", "", value];
  const rows = [
    [label.section, label.item, label.memberOrPayer, label.recipient, label.currency, label.amount, label.value],
    metadata(label.activity, spreadsheetText(card.name)),
    metadata(label.date, card.activityDate),
    metadata(label.currency, currency),
    metadata(label.activityStatus, card.activityStatus),
    metadata(label.settlementStatus, card.settlementStatus),
    metadata(copy.generated, card.generatedAt),
    ...summary(preview).map(({ label: item, minor }) => [label.summary, item, "", "", currency, amount(minor), ""]),
    ...card.members.map(({ name, direction }, index) => [
      copy.members, label.member, spreadsheetText(name), "", currency, amount(Math.abs(snapshot.members[index].netBalanceMinor)), direction,
    ]),
    ...card.transfers.map(({ from, to }, index) => [
      copy.transfers, "", spreadsheetText(from), spreadsheetText(to), currency, amount(snapshot.suggestions[index].amountMinor), "",
    ]),
  ];
  if (!card.members.length) rows.push([copy.members, "", "", "", "", "", copy.noMembers]);
  if (!card.transfers.length) rows.push([copy.transfers, "", "", "", "", "", card.emptyTransfers]);
  rows.push([copy.transfers, "", "", "", "", "", copy.disclaimer]);
  // UTF-8 BOM makes Traditional Chinese readable in spreadsheet apps that auto-detect encodings.
  return "\uFEFF" + rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
}

export function buildSettlementDocument(preview: SettlementPreview, format: SettlementDocumentFormat) {
  return {
    format,
    name: preview.card.fileName.replace(/\.png$/, `.${format}`),
    content: format === "pdf" ? buildPdfHtml(preview) : buildCsv(preview),
  };
}

type ShareFile = { readonly uri: string; discard(): void };
export type SettlementDocumentPlatform = {
  supports(format: SettlementDocumentFormat): boolean;
  prepare(document: ReturnType<typeof buildSettlementDocument>): Promise<ShareFile>;
  present(uri: string, title: string): Promise<"completed" | "cancelled">;
};

export async function shareSettlementDocument(preview: SettlementPreview, format: SettlementDocumentFormat, platform: SettlementDocumentPlatform, options: {
  hasVerifiedProAccess(): boolean;
  isActive(): boolean;
  onPresenting(): void;
  title: string;
}) {
  if (!options.hasVerifiedProAccess()) return "proRequired";
  if (!platform.supports(format)) return "documentUnavailable";
  let file: ShareFile;
  try {
    file = await platform.prepare(buildSettlementDocument(preview, format));
  } catch {
    return "documentFailed";
  }
  try {
    if (!options.isActive()) return "cancelled";
    if (!options.hasVerifiedProAccess()) return "proRequired";
    options.onPresenting();
    return await platform.present(file.uri, options.title);
  } catch {
    return "shareFailed";
  } finally {
    file.discard();
  }
}
