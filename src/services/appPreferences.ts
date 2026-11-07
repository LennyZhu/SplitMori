import { isCurrency, type Currency } from "../domain/money.ts";

export type AppLanguage = "zh-HK" | "en";
export type LanguagePreference = "system" | AppLanguage;
export type AppPreferences = { language: LanguagePreference; defaultCurrency: Currency };
export const defaultAppPreferences: AppPreferences = { language: "system", defaultCurrency: "HKD" };

export const currencyLabels = {
  HKD: { "zh-HK": "港幣", en: "Hong Kong dollar" },
  CNY: { "zh-HK": "人民幣", en: "Chinese yuan" },
  MOP: { "zh-HK": "澳門幣", en: "Macanese pataca" },
  TWD: { "zh-HK": "新台幣", en: "New Taiwan dollar" },
  USD: { "zh-HK": "美元", en: "US dollar" },
  JPY: { "zh-HK": "日圓", en: "Japanese yen" },
} satisfies Record<Currency, Record<AppLanguage, string>>;

export function normalizeAppLanguage(locale?: string): AppLanguage | undefined {
  const language = locale?.trim().toLowerCase().split(/[-_]/)[0];
  if (language === "zh") return "zh-HK";
  if (language === "en") return "en";
}

export function resolveAppLanguage(preference: LanguagePreference, systemLocales: readonly string[]): AppLanguage {
  if (preference !== "system") return preference;
  for (const locale of systemLocales) {
    const language = normalizeAppLanguage(locale);
    if (language) return language;
  }
  return "en";
}

type PreferencesStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const key = "app-preferences";

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "zh-HK" || value === "en";
}

export function createAppPreferencesStore(storage: PreferencesStorage) {
  return {
    async load(): Promise<AppPreferences> {
      const raw = await storage.getItem(key);
      if (!raw) return defaultAppPreferences;
      let saved: Partial<AppPreferences> | null;
      try {
        saved = JSON.parse(raw);
      } catch {
        return defaultAppPreferences;
      }
      return {
        language: isLanguagePreference(saved?.language) ? saved.language : defaultAppPreferences.language,
        defaultCurrency: isCurrency(saved?.defaultCurrency) ? saved.defaultCurrency : defaultAppPreferences.defaultCurrency,
      };
    },
    save(preferences: AppPreferences) {
      if (!isLanguagePreference(preferences.language) || !isCurrency(preferences.defaultCurrency)) {
        throw new Error("Unsupported app preferences");
      }
      return storage.setItem(key, JSON.stringify(preferences));
    },
  };
}
