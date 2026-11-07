import { useLocales } from "expo-localization";
import { SQLiteStorage } from "expo-sqlite/kv-store";
import { useEffect, useRef, useState } from "react";
import { createAppPreferencesStore, defaultAppPreferences, resolveAppLanguage, type AppPreferences } from "../services/appPreferences.ts";

// Device preferences are outside the replaceable financial ledger.
const store = createAppPreferencesStore(new SQLiteStorage("splitmori-preferences.db"));

export function useAppPreferences() {
  const locales = useLocales().map(({ languageTag }) => languageTag);
  const [preferences, setPreferences] = useState<AppPreferences>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save">();
  const pending = useRef(false);

  useEffect(() => {
    let current = true;
    void store.load().then((saved) => {
      if (current) setPreferences(saved);
    }, () => {
      if (current) {
        setError("load");
        setPreferences(defaultAppPreferences);
      }
    });
    return () => { current = false; };
  }, []);

  async function save(next: AppPreferences) {
    if (!preferences || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      await store.save(next);
      setPreferences(next);
      setError(undefined);
    } catch {
      setError("save");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return {
    preferences, saving, error, save,
    language: resolveAppLanguage(preferences?.language ?? "system", locales),
    systemLanguage: resolveAppLanguage("system", locales),
  };
}
