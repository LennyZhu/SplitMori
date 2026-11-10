# SplitMori 1.0 資料處理審計

本次查核 SplitMori `develop` 的原始碼、Expo 設定、套件鎖檔、安裝套件及兩個本機 Swift 模組。正式 iOS 封裝、App Store Connect 後台及日後使用的支援信箱與網站記錄仍需由開發者確認。

| 項目 | 核對結果 |
| --- | --- |
| 本機帳本 | [databaseHost.ts](../src/data/databaseHost.ts) 與 [databaseExpo.ts](../src/data/databaseExpo.ts) 透過 Expo SQLite 使用 `splitmori.db`。活動、成員、費用、退款、還款、快速分帳草稿及歷史在裝置內處理。 |
| 偏好設定及識別碼 | [useAppPreferences.ts](../src/ui/useAppPreferences.ts) 在裝置上讀取系統語言，另存語言及幣別偏好於 `splitmori-preferences.db`。App 的記錄 ID 和暫存檔名稱用於本機操作。原始碼未發現讀取廣告 ID、IDFV 或使用持久裝置 ID 辨識使用者的程式路徑。 |
| 備份與還原 | [backup.ts](../src/services/backup.ts)、[restore.ts](../src/services/restore.ts) 和 [settingsBackupFiles.ts](../src/services/settingsBackupFiles.ts) 建立本機 SQLite 快照、驗證並由使用者透過系統介面匯出或選檔還原。`.splitmori-backup` 包含帳本，具 SHA-256 完整性校驗，App 未加密備份。整庫還原須明確確認，偏好及 StoreKit 權益在帳本備份範圍之外。 |
| Photos、Files 及分享 | [saveSharePngToPhotos.ts](../src/services/saveSharePngToPhotos.ts) 使用 iOS 加入相片權限。[localSharePng.ts](../src/services/localSharePng.ts)、[activitySettlementExportExpo.ts](../src/services/activitySettlementExportExpo.ts) 及 [SplitMoriDocumentShareModule.swift](../modules/splitmori-document-share/ios/SplitMoriDocumentShareModule.swift) 建立本機匯出檔案並交由系統分享。外部副本由使用者選定的服務或收件人處理。 |
| StoreKit 2 | [LifetimeStore.swift](../modules/splitmori-storekit/ios/LifetimeStore.swift) 與 [SplitMoriStoreKitModule.swift](../modules/splitmori-storekit/ios/SplitMoriStoreKitModule.swift) 向 Apple 取得商品、購買及同步，使用已驗證的交易狀態，並處理尚待完成的交易 ID。[storeKitExpo.ts](../src/services/storeKitExpo.ts) 只把上次核實狀態的顯示用快取存到 `splitmori-storekit-ui.db`。未發現把收據或交易資料送往開發者伺服器的程式路徑。App 未取得 Apple 帳號憑證或付款卡資料。 |
| 遠端服務、帳號及 SDK | App 原始碼未發現自有後端、使用者登入、帳本上傳、分析、廣告、追蹤或崩潰回報整合。已安裝套件中的 11 份 `.xcprivacy` 均宣告無追蹤及無收集類型，其中 10 份列出 required-reason API。套件鎖檔包含 Expo 開發客戶端及其開發工具依賴。正式封裝的 native framework、privacy manifest、權限及 App Store 端診斷設定仍需核對。 |
| 網站及支援 | 靜態網頁沒有資料表單、分析指令碼或廣告；網站託管商仍會處理網站請求。使用者主動寄出的支援電郵會交給開發者及其電郵服務供應商。部署後須確認託管記錄、電郵保留、診斷資料及可用的刪除請求渠道。 |

## App Store Connect App Privacy 填寫建議

- 若正式 iOS 版本及內嵌 SDK 的行為與本次審計一致，並確認開發者及合作方沒有可保留存取的 App 資料，**可考慮「Data Not Collected」**。這項建議依 Apple 對資料收集的定義，並非網站、使用者主動分享或 Apple 購買都沒有資料處理。 [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- 本機帳本、語言和幣別偏好、記錄 ID 不需因在裝置上儲存而列為收集。系統分享的目的地由使用者選擇，依本次查核未送往開發者。Apple 代為處理付款，App 不取得付款資料；開發者須另外核對正式版本及營運流程有否收集購買歷史或交易識別資料。 [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- 確認支援電郵、診斷或附件實際如何取得、是否保留及誰可存取。若某項資料須申報，按實際內容填 Contact Info、User Content 或 Diagnostics 等類別及用途。只有在符合 Apple 所有條件時才採用選擇性披露豁免。網站託管與 App 資料流應分開審核。 [Apple 選擇性披露條件](https://developer.apple.com/app-store/app-privacy-details/#optional-disclosure)
- 本次未發現追蹤用途。提交前核對正式封裝的所有第三方元件及 privacy manifest，並填寫可公開存取的隱私政策網址。若日後改變資料流或新增 SDK，應同步更新政策及 App Privacy。 [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#privacy)
