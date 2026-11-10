import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { officialLink, officialLinkPages } from "../src/services/officialLinks.ts";

test("official links follow the App language for all three published routes", () => {
  const origin = "https://splitmori-build-fixture.com";
  for (const page of officialLinkPages) {
    assert.equal(officialLink(origin, "en", page), `${origin}/en/${page}/`);
    assert.equal(officialLink(`${origin.toUpperCase()}/`, "zh-HK", page), `${origin}/zh-hk/${page}/`);
  }
});

test("the shipped Expo config opens the six routes on the verified production site", () => {
  const { expo } = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const origin = "https://splitmori-site.vercel.app";
  assert.equal(expo.extra?.legalSiteOrigin, origin);
  assert.deepEqual(officialLinkPages.map((page) => officialLink(expo.extra.legalSiteOrigin, "zh-HK", page)), [
    `${origin}/zh-hk/privacy/`,
    `${origin}/zh-hk/terms/`,
    `${origin}/zh-hk/support/`,
  ]);
  assert.deepEqual(officialLinkPages.map((page) => officialLink(expo.extra.legalSiteOrigin, "en", page)), [
    `${origin}/en/privacy/`,
    `${origin}/en/terms/`,
    `${origin}/en/support/`,
  ]);
});

test("missing, insecure and placeholder site origins leave links unavailable", () => {
  for (const origin of [undefined, "", null, "http://host.com", "https://example.com", "https://host.test",
    "https://localhost", "https://host.com/extra", "https://host.com?", "https://host.com/#section",
    "https://user@host.com", "https://host.com:443", "mailto:support@host.com", "https://-host.com"]) {
    assert.equal(officialLink(origin, "en", "privacy"), undefined, String(origin));
  }
});
