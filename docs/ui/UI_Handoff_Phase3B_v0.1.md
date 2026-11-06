# SplitMori — Phase 3B UI handoff v0.1

Status: provisional implementation reference, not final visual freeze. Reviewed with user through 2026-11-06.

## Design baseline

- V3.1 warm minimalist, professional and restrained: warm-white page, charcoal primary text/buttons, very small amounts of muted warm-brown, discreet outlines and generous whitespace.
- Home uses **text-only SplitMori wordmark**. Do not add letter S, dining utensils, restaurant icons, large promotional illustrations or an extra motto below the wordmark.
- Actual screen layouts, text sizes and rounded corners remain adjustable during implementation after user's manual review.
- The included PNGs are design references, **not exact product specifications**. When they conflict with frozen PRD, frozen accounting and permissions rules win.
- zh-HK Traditional Chinese for initial screen implementation; preserve localization-ready component design. Avoid mixing Simplified Chinese or inventing translations.

## Verified flow / information architecture

1. S01 Home: `開始分帳` -> S02 quick split editor; `建立活動` -> future S06, NOT implemented by merely invoking low-level repository; ongoing activities link to future S07; recent quick history -> future detail.
2. S02: **one page with vertical sections** (not step wizard). Section order: final payable total/currency, four mutually exclusive split methods, participants and mode-specific input, optionally expand fee/discount details, optional merchant payer, fixed bottom `查看結果`.
3. S04 results: accurate total and member obligations. With actual merchant payer, show settlement **suggestions**; without merchant payer, show obligations only, explanation and `補充付款人`. Never infer real payment from calculation.
4. S03 explanation: **read-only bottom Sheet opened from S04**; itemized breakdown per member and rounding explanation; no mutation/real transfer.
5. S04 follow-up actions are `分享結算`, `儲存計算記錄`, `加入活動`. Share/PNG and conversion need a real, tested implementation; don't present simulated success.

## S01 Home implementation contract (Phase 3B1 only)

- Recreate the two visual states in `S01_Home_V3_1.png`: active activity and empty-state. Reference is a **visual board**; use actual user SQLite data rather than copying example amounts/names.
- Text-only SplitMori header plus settings affordance; dark full-width `開始分帳`, lighter `建立活動`.
- Show `進行中活動` cards from actual Activity Repository (not hardcoded sample). Each card shows real name, member count, expense count, activity-currency total, settlement status. If a value is not available yet, explicitly omit it rather than fabricate data.
- `最近記錄` combines manually saved quick-split history and finished activities, sorted by actual timestamp, preserving each currency; no global aggregation across currencies. Use text empty state when no records.
- Tabs: `首頁`, `活動`, `記錄`. Only the home page design has been reviewed; do not create finished designs for unreviewed tabs or settings. Route buttons to clearly labeled temporary placeholders as needed; no inert controls and no fake successes.
- Handle loading/initialization error, no-data, re-foreground and manual refresh. Read-only home; do not introduce ad-hoc writes, entitlement bypass or auto-creation of activities.
- Free/Pro simultaneous active activity restrictions will be enforced in a later service layer, not by a non-atomic UI check or permanent DB UNIQUE index.
- Do not add IAP, service layer for new activities, backend, ads, tracking, or unrelated screens.

## S02 and S04 correctness guardrails (future phases; NOT Phase 3B1 work)

- Methods: `平均分攤` (Free), `請客` (single sponsor Free), `各自消費` (Free shared total), `自訂分攤` (Pro). A Pro feature should not silently work without entitlement; preserve draft and explain why if gated.
- Default final amount already includes service fee and discount. Switching to details requires user confirmation; never double-add 10%.
- Quick split can be performed without payer; a *formal expense* requires one. The quick history is distinct from activities, and manual saves do not consume the Free active activity quota.
- Fast preview never says `已付款` or `已結清` without actual recorded events. Suggestions do not transfer money.
- Sample: HKD 940 / 4 = 235 each; when payer 阿明 pays HKD 940, three suggested transfers of HKD 235 to 阿明; with no payer no transfer list.
- S03 must work for Free, remain read-only and explain small remainders using stable member snapshot order.

## Operational guidelines

- Work directly on `develop`; user manually handles ALL `git add`, `git commit`, `git push`, `git merge`.
- Codex should perform limited `npm run typecheck`, `npm test`, `git diff --check`, plus a Metro static bundle only if useful. No simulator or real-device operation by Codex.
- Do not implement screens beyond S01 until their next scoped task is given. Report changed files, real vs placeholder behaviors, test results, git status; stop without Git mutation.

## Design references included in this bundle

- `S01_Home_V3_1.png`: text-wordmark, accepted provisional home visual board.
- `S02_QuickSplit_VISUAL_ONLY.png`: illustration of overall visual direction; its mode/flow labels are **NOT** authoritative, PRD controls.
- `S03_DetailSheet_V3_1.png`: bottom-sheet explanation, provisional.
- `S04_Result_V3_1.png`: payer/no-payer result states, provisional.
