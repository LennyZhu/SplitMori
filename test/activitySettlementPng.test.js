import assert from "node:assert/strict";
import test from "node:test";
import { buildSettlementPngCard, resolveSettlementPngLanguages, settlementPngLayout } from "../src/services/activitySettlementPng.ts";

const snapshot = {
  name: "香港 / Tokyo", createdAt: Date.UTC(2026, 10, 7, 12), currency: "HKD", activityStatus: "completed", status: "unsettled",
  generatedAt: Date.UTC(2026, 10, 8, 12), outstandingMinor: 1001n, effectiveMinor: 5000n, refundMinor: 1000n, repaymentMinor: 300n,
  members: [{ memberId: "a", displayName: "陳小明", netBalanceMinor: 1001 }, { memberId: "b", displayName: "Alex", netBalanceMinor: -1001 }],
  suggestions: [{ fromMemberId: "b", toMemberId: "a", amountMinor: 1001 }],
};

test("S11 defaults the UI and image to the current App language and localizes feedback", () => {
  const zh = resolveSettlementPngLanguages({ appLocale: "zh-HK", systemLocale: "en-US" });
  const en = resolveSettlementPngLanguages({ appLocale: "en-GB", systemLocale: "zh-HK" });
  assert.deepEqual([zh.appLanguage, zh.outputLanguage], ["zh-HK", "zh-HK"]);
  assert.deepEqual([en.appLanguage, en.outputLanguage], ["en", "en"]);
  assert.deepEqual([zh.copy.preview, zh.copy.saved, zh.copy.saveFailed, zh.copy.backToSettlement],
    ["結算圖預覽", "結算圖已儲存", "未能儲存到相簿，請重試。", "返回活動結算"]);
  assert.deepEqual([en.copy.preview, en.copy.saved, en.copy.saveFailed, en.copy.backToSettlement],
    ["Settlement image preview", "Settlement image saved", "Couldn’t save to Photos. Try again.", "Back to activity settlement"]);
  assert.doesNotMatch(zh.copy.snapshot + en.copy.snapshot, /sqlite/i);
});

test("S11 normalizes Chinese tags and resolves a manual preference before the system fallback", () => {
  for (const appLocale of ["zh-HK", "zh-Hant", "zh-TW", "zh", "ZH_hant_HK", " zh-Hant-TW "]) {
    assert.equal(resolveSettlementPngLanguages({ appLocale, systemLocale: "en" }).outputLanguage, "zh-HK");
  }
  assert.equal(resolveSettlementPngLanguages({ preferredLocale: "zh-TW", systemLocale: "en-US" }).outputLanguage, "zh-HK");
  assert.equal(resolveSettlementPngLanguages({ preferredLocale: "en-GB", systemLocale: "zh-Hant" }).outputLanguage, "en");
  assert.equal(resolveSettlementPngLanguages({ preferredLocale: "system", systemLocale: "zh-TW" }).outputLanguage, "zh-HK");
  assert.equal(resolveSettlementPngLanguages({ systemLocale: "en-US" }).outputLanguage, "en");
});

test("S11 output language selection leaves the App copy and underlying snapshot intact", () => {
  const initial = resolveSettlementPngLanguages({ appLocale: "zh-HK" });
  const selected = resolveSettlementPngLanguages({ appLocale: "zh-HK", selectedOutputLanguage: "en" });
  const zh = buildSettlementPngCard(snapshot, initial.outputLanguage);
  const en = buildSettlementPngCard(snapshot, selected.outputLanguage);
  assert.equal(selected.appLanguage, initial.appLanguage);
  assert.equal(selected.copy, initial.copy);
  assert.equal(en.language, "en");
  assert.equal(en.activityStatus, "Completed");
  assert.equal(en.settlementStatus, "Unsettled");
  assert.equal(en.name, zh.name);
  assert.deepEqual([en.effective, en.outstanding, en.refund, en.repayment], [zh.effective, zh.outstanding, zh.refund, zh.repayment]);
  assert.deepEqual(en.members.map(({ id, name, amount }) => [id, name, amount]), zh.members.map(({ id, name, amount }) => [id, name, amount]));
  assert.deepEqual(en.transfers, zh.transfers);
  assert.equal(resolveSettlementPngLanguages({ appLocale: "zh-HK", selectedOutputLanguage: en.language }).outputLanguage, "en");
});

test("S11 uses the same snapshot for both output languages and formats all six currencies", () => {
  for (const currency of ["HKD", "CNY", "MOP", "TWD", "USD", "JPY"]) {
    const zh = buildSettlementPngCard({ ...snapshot, currency }, "zh-HK");
    const en = buildSettlementPngCard({ ...snapshot, currency }, "en");
    assert.equal(zh.outstanding, currency === "JPY" ? "JPY 1,001" : `${currency} 10.01`);
    assert.equal(zh.outstanding, en.outstanding);
    assert.deepEqual(zh.transfers, en.transfers);
    assert.deepEqual(zh.transfers.map(({ from, to, amount }) => [from, to, amount]), [["Alex", "陳小明", zh.outstanding]]);
    assert.deepEqual(zh.members.map(({ direction }) => direction), ["應收", "應付"]);
    assert.deepEqual(en.members.map(({ direction }) => direction), ["To receive", "To pay"]);
    assert.equal(zh.activityStatus, "已完成");
    assert.equal(zh.settlementStatus, "未結清");
    assert.match(zh.activityDate, /2026.*11/);
    assert.match(en.activityDate, /November.*2026/);
    assert.match(en.generatedAt, /2026.*[0-9]:[0-9]{2}/);
    assert.doesNotMatch(zh.fileName, /\//);
    assert.match(zh.fileName, /\.png$/);
  }
});

test("S11 separates no financial records from settlement and preserves exact large totals", () => {
  const empty = buildSettlementPngCard({ ...snapshot, activityStatus: "active", status: "empty", outstandingMinor: 0n,
    effectiveMinor: 0n, refundMinor: 0n, repaymentMinor: 0n, members: [], suggestions: [] }, "zh-HK");
  assert.equal(empty.activityStatus, "進行中");
  assert.equal(empty.settlementStatus, "暫無財務紀錄");
  assert.equal(empty.emptyTransfers, "暫無財務紀錄");
  assert.equal(empty.outstanding, "HKD 0.00");
  const settled = buildSettlementPngCard({ ...snapshot, status: "settled", outstandingMinor: 0n,
    effectiveMinor: 10_000_000_000_000_009n,
    members: snapshot.members.map((member) => ({ ...member, netBalanceMinor: 0 })), suggestions: [] }, "en");
  assert.equal(settled.settlementStatus, "Settled");
  assert.equal(settled.effective, "HKD 100,000,000,000,000.09");
  assert.equal(settled.transfers.length, 0);
  assert.match(settled.emptyTransfers, /Everyone is settled/);
});

test("S11 projects all long member and transfer rows and fits a long receipt without cropping the frame", () => {
  const name = "陳小明與很長的名字 Long English Display Name";
  const members = Array.from({ length: 200 }, (_, index) => ({ memberId: `m${index}`, displayName: name,
    netBalanceMinor: index === 0 ? 199 : -1 }));
  const suggestions = members.slice(1).map(({ memberId }) => ({ fromMemberId: memberId, toMemberId: "m0", amountMinor: 1 }));
  const longSnapshot = { ...snapshot, members, suggestions };
  const card = buildSettlementPngCard(longSnapshot, "zh-HK");
  assert.equal(card.members.length, 200);
  assert.equal(card.transfers.length, 199);
  assert.equal(card.members.at(-1).name, `${name} (200)`);
  assert.equal(card.transfers.at(-1).from, card.members.at(-1).name);
  assert.equal(card.transfers.at(-1).to, card.members[0].name);
  assert.deepEqual(buildSettlementPngCard(longSnapshot, "en").transfers, card.transfers);
  assert.deepEqual(settlementPngLayout(360, 550, 3), { width: 360, height: 550, scale: 1 });
  for (const ratio of [1, 2, 3, 3.5]) {
    const frame = settlementPngLayout(360, 20_000.25, ratio);
    assert.ok(frame.scale < 1);
    assert.ok(frame.height >= 20_000.25 * frame.scale);
    assert.ok(frame.width >= 360 * frame.scale);
    assert.ok(frame.height * ratio <= 16_001);
    assert.ok(frame.height * frame.width * ratio ** 2 <= 18_016_000);
  }
});
