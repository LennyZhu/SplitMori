# SplitMori 法律及支援網站

這是獨立的靜態網站，沒有執行時 JavaScript、表單、第三方字型或額外套件。每頁有繁體中文（香港）及 English 版本，可直接切換至同一頁的另一種語言。

## 本機預覽

```sh
cd site
npm run build
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

在瀏覽器開啟 `http://127.0.0.1:4173/`。本機輸出會標為審閱版本並加入 `noindex`。六頁及頁尾均顯示已確認的發行者 SHUNLI ZHU 和支援電郵 [lenny996@163.com](mailto:lenny996@163.com)。執行 `npm test` 可驗證雙語路由、聯絡資料及發佈檢查。

| 頁面 | 繁體中文（香港） | English |
| --- | --- | --- |
| 隱私政策 | `/zh-hk/privacy/` | `/en/privacy/` |
| 使用條款 | `/zh-hk/terms/` | `/en/terms/` |
| 支援 | `/zh-hk/support/` | `/en/support/` |

## 發佈資料與審閱

| 環境變數 | 開發者確認事項 |
| --- | --- |
| `SPLITMORI_SITE_ORIGIN` | 如已指定公開網域，填入不附路徑的 HTTPS origin。Vercel 正式環境可使用專案分配的網域。 |
| `SPLITMORI_POLICY_UPDATED` | 審定版本的實際更新日期，格式為 `YYYY-MM-DD` |
| `SPLITMORI_LEGAL_APPROVED` | 開發者完成下列審閱後才設為 `1` |
| `SPLITMORI_PUBLIC_ADDRESS`、`SPLITMORI_PUBLIC_PHONE` | 依上架地區要求提供公開地址和電話 |

發佈前由開發者審閱 [雙語政策與條款](./content.mjs)，確認以下事項。

- 確認各上架地區需要公開的發行者資料，以及支援電郵可收信。若當地要求地址或電話，提供核實資料。 [Apple Support URL 要求](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/)
- 核對網站託管請求記錄、支援郵件與附件的用途、服務供應商、留存安排，以及查閱、刪除及其他適用資料請求的處理方式。
- 審定授權、退款、消費者權利及責任條款，並確定雙語政策的更新日期。Apple 的標準 EULA 在未提供自訂 EULA 時適用。如要採用自訂 EULA，需另行審閱並在 App Store Connect 設定。 [Apple 授權協議設定](https://developer.apple.com/help/app-store-connect/manage-app-information/provide-a-custom-license-agreement/)

## Vercel 部署

1. 在 `homeypaw` 團隊的 `splitmori-site` 專案設定 **Root Directory** 為 `site`。設定檔使用 **Other**、建置指令 `npm run build:release`，輸出目錄 `dist`。 [Vercel 建置設定](https://vercel.com/docs/builds/configure-a-build)
2. 在環境變數設定中開啟 **System Environment Variables**。若尚未設定 `SPLITMORI_SITE_ORIGIN`，Production 建置可使用 Vercel 提供的 `VERCEL_PROJECT_PRODUCTION_URL` 建立正式連結。這是專案的正式網域，與個別部署的 `VERCEL_URL` 不同。若系統未提供，從專案的 **Settings → Domains** 核實分配的網域，再手動填入完整 HTTPS origin。 [Vercel 系統環境變數](https://vercel.com/docs/environment-variables/system-environment-variables)
3. 完成政策審閱後，在 Production 環境設定 `SPLITMORI_POLICY_UPDATED` 和 `SPLITMORI_LEGAL_APPROVED=1`。在儲存庫根目錄執行下列指令，確認連結至指定團隊和專案。新專案的第一次部署即使省略 `--prod` 仍可能是 Production。使用 `--skip-domain` 建置候選版本，將正式網域指派保留到人工驗收後。候選部署仍有獨立網址，如需限制存取，使用部署保護。 [Vercel CLI 部署](https://vercel.com/docs/cli/deploy) · [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)

   ```sh
   npx vercel@latest link --scope homeypaw --project splitmori-site
   npx vercel@latest deploy --scope homeypaw --prod --skip-domain
   ```

4. 使用 CLI 回傳的候選網址驗證六頁、語言切換及支援電郵。人工確認後，在 Vercel 控制台升級該部署，再用無痕視窗驗證正式網域下的六頁可在不登入的情況下開啟。 [Vercel 手動升級部署](https://vercel.com/docs/deployments/promoting-a-deployment)
5. App 從 `app.json` 的 `expo.extra.legalSiteOrigin` 讀取已核實的正式網址 `https://splitmori-site.vercel.app`。設定首頁會按 App 語言開啟相應網址。開發時若仍顯示「正式連結尚未提供」，請用目前 SplitMori Metro 終端機的 QR Code 重新開啟專案。若需重啟 Metro，在該終端機停止 Metro，從儲存庫根目錄執行 `npx expo start --dev-client --clear`，再掃描新的 QR Code。僅更新此網址並從 Metro 載入時，現有 Development Build 即可驗收。
6. 在 App Store Connect 填寫正式 **Privacy Policy URL** 和各語言的 **Support URL**，並在配置正式網址的 iPhone 版本驗證中英文入口。 [Apple App Privacy 設定](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
