import type { AppLanguage } from "./appPreferences.ts";

export const officialLinkPages = ["privacy", "terms", "support"] as const;

export function officialLink(origin: unknown, language: AppLanguage, page: typeof officialLinkPages[number]): string | undefined {
  if (typeof origin !== "string") return;
  const value = origin.trim();
  // Accept a public HTTPS origin with no path, credentials, port or query.
  const host = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\/?$/i.exec(value)?.[1];
  if (!host || /(?:^|\.)(?:localhost|invalid|test|example|local)$|(?:^|\.)example\.(?:com|net|org)$/i.test(host)) return;
  return `https://${host.toLowerCase()}/${language === "zh-HK" ? "zh-hk" : "en"}/${page}/`;
}
