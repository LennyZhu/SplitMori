import assert from "node:assert/strict";
import test from "node:test";
import { resolveAppLanguage } from "../src/services/appPreferences.ts";
import { resolveSettlementPngLanguages } from "../src/services/activitySettlementPng.ts";
import { copyFor, formatUiCount, formatUiDate, splitModeLabel } from "../src/services/localizedCopy.ts";
import { calculateQuickSplitEditor, createQuickSplitEditor } from "../src/services/quickSplitEditor.ts";
import { describeQuickSplitResult } from "../src/services/quickSplitResult.ts";
import { buildQuickSplitShareCard } from "../src/services/quickSplitShare.ts";
import { validationMessage } from "../src/ui/splitEditorMessages.ts";
import { settingsCopy } from "../src/ui/settingsCopy.ts";
import { proCopy } from "../src/ui/proCopy.ts";

test("Phase 4A uses one resolved language across Home, activity, form errors and settings", () => {
  for (const [preference, device, english] of [
    ["system", "zh-Hant-HK", false],
    ["system", "en-US", true],
    ["en", "zh-HK", true],
    ["zh-HK", "en-GB", false],
  ]) {
    const language = resolveAppLanguage(preference, [device]);
    const t = copyFor(language);
    const issue = validationMessage(t, { code: "INVALID_AMOUNT_PRECISION", field: "finalTotal" });
    assert.deepEqual([t("進行中活動"), t("活動詳情"), settingsCopy(language).settings], english
      ? ["Active activities", "Activity details", "Settings"] : ["進行中活動", "活動詳情", "設定"]);
    assert.equal(issue, english ? "This currency doesn’t support that many decimal places." : "小數位數超出此幣種的上限。");
    assert.equal(proCopy(language).documentExport, english ? "PDF and CSV activity settlement export" : "活動結算 PDF 及 CSV 匯出");
    const exportLanguage = english ? "zh-HK" : "en";
    const result = resolveSettlementPngLanguages({ appLocale: language, selectedOutputLanguage: exportLanguage });
    assert.equal(result.appLanguage, language);
    assert.equal(result.outputLanguage, exportLanguage);
  }
});

test("Phase 4A localizes dates, counts and long text while preserving the user's exact name", () => {
  const en = copyFor("en");
  const zh = copyFor("zh-HK");
  const date = new Date(2026, 0, 2, 12);
  assert.match(formatUiDate(en, date), /January/);
  assert.match(formatUiDate(zh, date), /2026年1月2日/);
  assert.deepEqual([formatUiCount(en, 1, "members"), formatUiCount(en, 2, "members"), formatUiCount(zh, 1, "members")],
    ["1 member", "2 members", "1 位成員"]);
  const name = '晚餐 · Alex & friends {1} '.repeat(10).trim();
  assert.equal(en("儲存至活動「{0}」", name), `Save to “${name}”`);
  assert.equal(zh("儲存至活動「{0}」", name), `儲存至活動「${name}」`);
  assert.deepEqual(["equal", "treat", "individual", "custom"].map((mode) => splitModeLabel(en, mode)),
    ["Split equally", "Treat & split", "Individual spending", "Custom split"]);
});

test("Phase 4A localizes S02 temporary names and S03/S04 presentation without changing a calculation", () => {
  const original = createQuickSplitEditor("JPY");
  const editor = {
    ...original, finalTotal: "1001",
    members: [{ ...original.members[0], displayName: "成員 1" }, original.members[1]],
  };
  const calculated = calculateQuickSplitEditor(editor, false, "en");
  assert.ok(calculated.ok);
  const preview = calculated.value;
  const en = describeQuickSplitResult(preview, "en");
  const zh = describeQuickSplitResult(preview, "zh-HK");
  assert.deepEqual(en.members.map(({ name }) => name), ["成員 1", "Member 2"]);
  assert.deepEqual(zh.members.map(({ name }) => name), ["成員 1", "Member 2"]);
  assert.deepEqual(en.members.map(({ amountMinor }) => amountMinor), zh.members.map(({ amountMinor }) => amountMinor));
  assert.match(en.roundingNote, /could not be divided evenly/);
  assert.match(zh.roundingNote, /尾差/);
  assert.equal(en.members[0].breakdown[0].label, "Equal share");
  const card = buildQuickSplitShareCard(en, new Date(2026, 0, 2, 12), "en");
  assert.equal(card.language, "en");
  assert.equal(card.total, "JPY 1,001");
  assert.equal(card.mode, "Split equally");
});
