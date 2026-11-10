import { isCurrency, type Currency } from "../domain/money.ts";

export type AppLanguage = "zh-HK" | "en";
export type LanguagePreference = "system" | AppLanguage;
export type AppPreferences = { language: LanguagePreference; defaultCurrency: Currency };
export const defaultAppPreferences: AppPreferences = { language: "system", defaultCurrency: "HKD" };

export const currencyLabels = {
  HKD: { "zh-HK": "港幣", en: "Hong Kong dollar" },
  USD: { "zh-HK": "美元", en: "US dollar" },
  CNY: { "zh-HK": "人民幣", en: "Chinese yuan" },
  MOP: { "zh-HK": "澳門元", en: "Macanese pataca" },
  TWD: { "zh-HK": "新台幣", en: "New Taiwan dollar" },
  JPY: { "zh-HK": "日圓", en: "Japanese yen" },
  CAD: { "zh-HK": "加元", en: "Canadian dollar" },
  AUD: { "zh-HK": "澳元", en: "Australian dollar" },
  NZD: { "zh-HK": "紐西蘭元", en: "New Zealand dollar" },
  MYR: { "zh-HK": "馬來西亞令吉", en: "Malaysian ringgit" },
  THB: { "zh-HK": "泰銖", en: "Thai baht" },
  PHP: { "zh-HK": "菲律賓披索", en: "Philippine peso" },
  KRW: { "zh-HK": "韓圜", en: "South Korean won" },
  SGD: { "zh-HK": "新加坡元", en: "Singapore dollar" },
  VND: { "zh-HK": "越南盾", en: "Vietnamese dong" },
} satisfies Record<Currency, Record<AppLanguage, string>>;

const currencyAliases: Partial<Record<Currency, readonly string[]>> = {
  HKD: ["港元"], MOP: ["澳門幣"], TWD: ["新臺幣", "台幣", "臺幣"], USD: ["美金"], JPY: ["日元", "日幣"],
  CAD: ["加拿大元"], AUD: ["澳幣"], NZD: ["紐元", "新西蘭元"], MYR: ["馬幣", "林吉特"], PHP: ["菲律賓比索"],
  KRW: ["韓元", "韓幣"], SGD: ["新加坡幣"], VND: ["Vietnamese đồng"],
};

export function searchCurrencies(query: string): Currency[] {
  const term = query.trim().toUpperCase();
  return (Object.keys(currencyLabels) as Currency[]).filter((code) => {
    const names = currencyLabels[code];
    return code.includes(term) || names.en.toUpperCase().includes(term) || names["zh-HK"].includes(term)
      || currencyAliases[code]?.some((alias) => alias.toUpperCase().includes(term));
  });
}

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
