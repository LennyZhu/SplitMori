import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "splitmori-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ["build.mjs", "content.mjs", "site.css"]) {
    await cp(new URL(file, import.meta.url), join(root, file));
  }
  return {
    build: (options = [], env = {}) => spawnSync(process.execPath, ["build.mjs", ...options], { cwd: root, env, encoding: "utf8" }),
    read: (file) => readFile(join(root, "dist", file), "utf8"),
  };
}

test("review build emits six bilingual documents with the confirmed publisher and support link", async (t) => {
  const { build, read } = await fixture(t);
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  for (const language of ["en", "zh-hk"]) {
    for (const page of ["privacy", "terms", "support"]) {
      const html = await read(`${language}/${page}/index.html`);
      assert.match(html, new RegExp(`<html lang="${language === "en" ? "en" : "zh-HK"}">`));
      assert.match(html, /<h1>[^<]+<\/h1>/);
      assert.match(html, /<time datetime="\d{4}-\d{2}-\d{2}">/);
      assert.match(html, /noindex/);
      assert.match(html, /<meta name="author" content="SHUNLI ZHU">/);
      assert.match(html, /<dd>SHUNLI ZHU<\/dd>/);
      assert.match(html, /<div class="footer-contact">SHUNLI ZHU/);
      assert.deepEqual(
        [...html.matchAll(/href="mailto:([^"]+)"/g)].map(([, email]) => email),
        ["lenny996@163.com", "lenny996@163.com"],
      );
      assert.doesNotMatch(html, /rel="canonical"|<script|<form|Official contact details have not been published|正式聯絡方式尚未公佈/);
      if (page === "terms") {
        assert.match(html, language === "en" ? /single, non-consumable App Store purchase/ : /一次性非消耗型購買/);
      } else {
        assert.match(html, language === "en" ? /not encrypted|does not encrypt/ : /不會為.*加密/);
        assert.match(html, language === "en" ? /system share sheet/ : /系統分享面板/);
      }
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (href.startsWith("#")) assert.ok(html.includes(`id="${href.slice(1)}"`), href);
        if (href.startsWith("/")) await read(href.endsWith("/") ? `${href.slice(1)}index.html` : href.slice(1));
      }
    }
  }
});

test("release needs approval and a valid date and origin, even when Vercel supplies a hostname", async (t) => {
  const { build, read } = await fixture(t);
  const vercel = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "splitmori-build-fixture.com" };
  const missing = build([], vercel);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SPLITMORI_LEGAL_APPROVED/);
  assert.match(missing.stderr, /SPLITMORI_POLICY_UPDATED/);
  const inputs = {
    SPLITMORI_POLICY_UPDATED: "2026-11-10",
    SPLITMORI_LEGAL_APPROVED: "1",
  };
  for (const invalid of [
    { SPLITMORI_SITE_ORIGIN: "https://example.org" },
    { SPLITMORI_POLICY_UPDATED: "2026-02-30" },
    { VERCEL_PROJECT_PRODUCTION_URL: "splitmori-build-fixture.com/path" },
  ]) {
    assert.notEqual(build(["--release"], { ...vercel, ...inputs, ...invalid }).status, 0);
  }
  assert.notEqual(build(["--release"], { ...inputs, VERCEL_URL: vercel.VERCEL_PROJECT_PRODUCTION_URL }).status, 0);
  const result = build(["--release"], { ...vercel, ...inputs });
  assert.equal(result.status, 0, result.stderr);
  const html = await read("zh-hk/support/index.html");
  assert.match(html, /<meta name="author" content="SHUNLI ZHU">/);
  assert.match(html, /href="mailto:lenny996@163\.com"/);
  assert.match(html, /hreflang="en" href="https:\/\/splitmori-build-fixture\.com\/en\/support\/"/);
  assert.doesNotMatch(html, /noindex|政策須完成最終審閱/);

  const explicit = build(["--release"], { ...vercel, ...inputs, SPLITMORI_SITE_ORIGIN: "https://explicit-build-fixture.com/" });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(await read("zh-hk/support/index.html"), /rel="canonical" href="https:\/\/explicit-build-fixture\.com\/zh-hk\/support\/"/);
});
