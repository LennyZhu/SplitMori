import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAppPreferencesStore, currencyLabels, resolveAppLanguage, searchCurrencies } from "../src/services/appPreferences.ts";
import { resolveSettlementPngLanguages } from "../src/services/activitySettlementPng.ts";
import { createQuickSplitEditor, hydrateQuickSplitDraft, serializeQuickSplitDraft } from "../src/services/quickSplitEditor.ts";

function openPreferences(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store = createAppPreferencesStore({
    getItem: async (key) => db.prepare("SELECT value FROM preferences WHERE key = ?").get(key)?.value ?? null,
    setItem: async (key, value) => { db.prepare("INSERT OR REPLACE INTO preferences VALUES (?, ?)").run(key, value); },
  });
  return { store, close: () => db.close() };
}

test("S13 follows the device on first launch and persists language and currency across reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "splitmori-preferences-"));
  const path = join(directory, "preferences.sqlite");
  let connection = openPreferences(path);
  try {
    const first = await connection.store.load();
    assert.deepEqual(first, { language: "system", defaultCurrency: "HKD" });
    assert.equal(resolveAppLanguage(first.language, ["zh-Hant-HK"]), "zh-HK");
    assert.equal(resolveAppLanguage(first.language, ["en-GB"]), "en");
    assert.equal(resolveAppLanguage(first.language, ["fr-FR"]), "en");

    for (const [language, device] of [["en", "zh-Hant"], ["zh-HK", "en-US"]]) {
      await connection.store.save({ language, defaultCurrency: "USD" });
      connection.close();
      connection = openPreferences(path);
      const saved = await connection.store.load();
      assert.deepEqual(saved, { language, defaultCurrency: "USD" });
      assert.equal(createQuickSplitEditor(saved.defaultCurrency).currency, "USD");
      assert.equal(resolveAppLanguage(saved.language, [device]), language);
    }
    for (const defaultCurrency of ["CAD", "AUD", "NZD", "MYR", "THB", "PHP", "KRW", "SGD", "VND"]) {
      await connection.store.save({ language: "en", defaultCurrency });
      connection.close();
      connection = openPreferences(path);
      assert.equal((await connection.store.load()).defaultCurrency, defaultCurrency);
    }
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("S13 passes the resolved language to S11 and keeps PNG selection independent", () => {
  for (const [preference, alternate] of [["zh-HK", "en"], ["en", "zh-HK"]]) {
    const appLocale = resolveAppLanguage(preference, [alternate]);
    const initial = resolveSettlementPngLanguages({ appLocale });
    assert.equal(initial.outputLanguage, preference);
    const changed = resolveSettlementPngLanguages({ appLocale, selectedOutputLanguage: alternate });
    assert.equal(changed.outputLanguage, alternate);
    assert.equal(changed.copy, initial.copy);
    assert.equal(changed.appLanguage, preference);
  }
});

test("S13 and the currency picker expose exactly 15 currencies with bilingual search", () => {
  const codes = ["HKD", "USD", "CNY", "MOP", "TWD", "JPY", "CAD", "AUD", "NZD", "MYR", "THB", "PHP", "KRW", "SGD", "VND"];
  assert.deepEqual(searchCurrencies(""), codes);
  for (const code of codes) {
    assert.deepEqual(searchCurrencies(` ${code.toLowerCase()} `), [code]);
    assert.ok(searchCurrencies(currencyLabels[code]["zh-HK"]).includes(code));
    assert.ok(searchCurrencies(currencyLabels[code].en).includes(code));
  }
  assert.deepEqual(searchCurrencies("韓元"), ["KRW"]);
  assert.deepEqual(searchCurrencies("EUR"), []);
});

test("S13 uses CAD for a new quick split and preserves an existing HKD draft", () => {
  const oldDraft = serializeQuickSplitDraft({ ...createQuickSplitEditor("HKD"), finalTotal: "560" });
  assert.equal(createQuickSplitEditor("CAD").currency, "CAD");
  const hydrated = hydrateQuickSplitDraft(oldDraft);
  assert.equal(hydrated.currency, "HKD");
  assert.equal(hydrated.finalTotal, "560");
});
