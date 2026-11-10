import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { content } from "./content.mjs";

const pages = ["privacy", "terms", "support"];
const languages = Object.keys(content);
const output = new URL("./dist/", import.meta.url);
const vercelProduction = process.env.VERCEL_ENV === "production";
const release = process.argv.includes("--release") || vercelProduction;
const setting = (key) => process.env[`SPLITMORI_${key}`]?.trim() ?? "";
const publisher = "SHUNLI ZHU";
const email = "lenny996@163.com";
const address = setting("PUBLIC_ADDRESS");
const phone = setting("PUBLIC_PHONE");
const policyUpdated = setting("POLICY_UPDATED");
const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
const assignedOrigin = vercelProduction && productionDomain ? `https://${productionDomain}` : "";
const origin = (setting("SITE_ORIGIN") || assignedOrigin).replace(/\/$/, "");
const approved = setting("LEGAL_APPROVED") === "1";

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const reservedDomain = /(?:^|\.)(?:localhost|invalid|test|example|local)$|(?:^|\.)example\.(?:com|net|org)$/i;
const publicDomain = (domain) => domainPattern.test(domain) && !reservedDomain.test(domain);
const validOrigin = origin.startsWith("https://") && publicDomain(origin.slice("https://".length));
const validDate = /^\d{4}-\d{2}-\d{2}$/.test(policyUpdated) &&
  Number.isFinite(Date.parse(policyUpdated)) && new Date(policyUpdated).toISOString().slice(0, 10) === policyUpdated;

if (release) {
  const missing = [
    !validOrigin && "SPLITMORI_SITE_ORIGIN or VERCEL_PROJECT_PRODUCTION_URL",
    !validDate && "SPLITMORI_POLICY_UPDATED",
    !approved && "SPLITMORI_LEGAL_APPROVED=1",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Release requires a production site origin and reviewed policies. Check ${missing.join(", ")}.`);
}

const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const supportLink = `<a href="mailto:${email}">${email}</a>`;
const route = (language, page) => `/${language}/${page}/`;
const paragraph = (copy) => `<p>${escapeHtml(copy)}</p>`;
const appleEula = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const date = release ? policyUpdated : "2026-11-10";

function render(language, page) {
  const labels = content[language];
  const doc = labels[page];
  const other = language === "en" ? "zh-hk" : "en";
  const otherLabels = content[other];
  const localDate = new Intl.DateTimeFormat(labels.lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(date));
  const nav = pages.map((item) => `<a href="${route(language, item)}"${item === page ? ' aria-current="page"' : ""}>${labels[item].title}</a>`).join("");
  const toc = [...doc.sections.map(([heading]) => heading), doc.contact]
    .map((heading, index) => `<li><a href="#section-${index + 1}">${escapeHtml(heading)}</a></li>`).join("");
  const sections = doc.sections.map(([heading, paragraphs], index) => `<section aria-labelledby="section-${index + 1}">
    <h2 id="section-${index + 1}">${escapeHtml(heading)}</h2>
    ${paragraphs.map(paragraph).join("")}
    ${page === "terms" && index === doc.sections.length - 1 ? `<p><a href="${appleEula}">${language === "en" ? "Apple’s standard licence agreement" : "Apple 標準授權協議"}</a></p>` : ""}
  </section>`).join("\n");
  const contact = `<dl class="contact">
    <div><dt>${labels.publisher}</dt><dd>${escapeHtml(publisher)}</dd></div>
    <div><dt>${labels.email}</dt><dd>${supportLink}</dd></div>
    ${address ? `<div><dt>${labels.address}</dt><dd>${escapeHtml(address)}</dd></div>` : ""}
    ${phone ? `<div><dt>${labels.phone}</dt><dd>${escapeHtml(phone)}</dd></div>` : ""}
  </dl>`;

  return `<!doctype html>
<html lang="${labels.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(doc.intro)}">
  <meta name="author" content="${escapeHtml(publisher)}">
  ${!release || process.env.VERCEL_ENV === "preview" ? '<meta name="robots" content="noindex, nofollow">' : ""}
  ${release ? `<link rel="canonical" href="${origin}${route(language, page)}">
  ${languages.map((item) => `<link rel="alternate" hreflang="${content[item].lang}" href="${origin}${route(item, page)}">`).join("\n  ")}` : ""}
  <title>${doc.title} · SplitMori</title>
  <link rel="stylesheet" href="/site.css">
</head>
<body>
  <a class="skip" href="#main">${labels.skip}</a>
  <header class="header">
    <div class="frame header-inner">
      <a class="brand" href="${route(language, "support")}">SplitMori</a>
      <a class="language" href="${route(other, page)}" hreflang="${otherLabels.lang}" lang="${otherLabels.lang}">${otherLabels.language}</a>
      <nav class="nav" aria-label="${labels.navigation}">${nav}</nav>
    </div>
  </header>
  <main class="frame" id="main">
    <div class="intro">
      ${release ? "" : `<p class="preview">${labels.preview}</p>`}
      <h1>${doc.title}</h1>
      <p class="lead">${escapeHtml(doc.intro)}</p>
      <p class="date">${labels.updated} <time datetime="${date}">${localDate}</time></p>
    </div>
    <div class="body-layout">
      <nav class="toc" aria-label="${language === "en" ? "On this page" : "本頁目錄"}">
        <p>${language === "en" ? "On this page" : "本頁目錄"}</p>
        <ol>${toc}</ol>
      </nav>
      <div class="sections">
        ${sections}
        <section aria-labelledby="section-${doc.sections.length + 1}">
          <h2 id="section-${doc.sections.length + 1}">${doc.contact}</h2>
          ${doc.contactHint ? paragraph(doc.contactHint) : ""}
          ${contact}
        </section>
      </div>
    </div>
  </main>
  <footer class="footer">
    <div class="frame footer-inner">
      <div>
        <span>SplitMori</span>
        <div class="footer-contact">${escapeHtml(publisher)} · ${supportLink}</div>
      </div>
      <nav class="nav" aria-label="${language === "en" ? "Footer links" : "頁尾連結"}">${nav}</nav>
    </div>
  </footer>
</body>
</html>\n`;
}

await mkdir(output, { recursive: true });
await copyFile(new URL("./site.css", import.meta.url), new URL("site.css", output));
for (const language of languages) {
  for (const page of pages) {
    const directory = new URL(`${language}/${page}/`, output);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL("index.html", directory), render(language, page));
  }
}
await writeFile(new URL("index.html", output), render("en", "support"));
console.log(`Built six bilingual pages in ${fileURLToPath(output)} (${release ? "release" : "review"}).`);
