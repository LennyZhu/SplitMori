import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Image, PixelRatio, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import {
  buildSettlementPngCard, loadSettlementPngSnapshot, resolveSettlementPngLanguages, settlementPngLayout,
  type SettlementPngCard, type SettlementPngLanguage, type SettlementPngSnapshot,
} from "../services/activitySettlementPng.ts";
import { shareSettlementDocument, type SettlementDocumentFormat } from "../services/activitySettlementExport.ts";
import { settlementDocumentPlatform } from "../services/activitySettlementExportExpo.ts";
import { canShareLocalPng, captureLocalSharePng, presentLocalSharePng, type LocalSharePng } from "../services/localSharePng.ts";
import { saveSharePngToPhotos } from "../services/saveSharePngToPhotos.ts";
import { hasVerifiedProAccess } from "../services/storeKitExpo.ts";
import { ActivitySettlementPngReceipt, settlementReceiptWidth } from "./ActivitySettlementPngReceipt.tsx";
import { ButtonPair, Notice } from "./FinanceReviewUi.tsx";
import { usePro, useProSnapshot } from "./ProContext.ts";
import { ConversionButton, ConversionPage } from "./QuickSplitConversionScreen.tsx";
import { colors, Icon } from "./visuals.tsx";

type Job = { snapshot: SettlementPngSnapshot; card: SettlementPngCard };
type CapturedPng = { image: LocalSharePng; aspectRatio: number };
type Preview = Job & CapturedPng;
type Page = "preview" | "actions" | "saved";
type Busy = "generate" | "save" | "share" | "document";
type Issue = "readFailed" | "generateFailed" | "imageMissing" | "saveFailed" | "saveDenied" | "saveCancelled"
  | "photosUnavailable" | "shareUnavailable" | "shareFailed";
type DocumentOutcome = Awaited<ReturnType<typeof shareSettlementDocument>>;

const documentCopy = {
  "zh-HK": {
    heading: "進階匯出 · Pro", pdf: "匯出 PDF", csv: "匯出 CSV",
    pdfHint: "可分頁閱讀的結算報告", csvHint: "可在試算表開啟的結算資料",
    output: (language: string) => `使用目前預覽的結算資料 · ${language}`,
    locked: "使用 Lifetime Pro 解鎖", generating: "正在準備結算文件…",
    completed: "系統已完成所選的匯出操作。", cancelled: "已取消匯出。",
    proRequired: "目前未能確認 Pro 權益。你仍可使用基本 PNG。",
    documentUnavailable: "目前版本無法匯出此文件，請更新 App 後重試。",
    documentFailed: "未能建立結算文件，請重試。", shareFailed: "系統未能完成匯出，請重試。",
  },
  en: {
    heading: "Advanced export · Pro", pdf: "Export PDF", csv: "Export CSV",
    pdfHint: "Paginated settlement report", csvHint: "Settlement data for spreadsheets",
    output: (language: string) => `Uses the current settlement preview · ${language}`,
    locked: "Unlock with Lifetime Pro", generating: "Preparing settlement document…",
    completed: "The system completed the selected export action.", cancelled: "Export cancelled.",
    proRequired: "Pro access could not be confirmed. Basic PNG sharing is still available.",
    documentUnavailable: "This version cannot export this document. Update the app and try again.",
    documentFailed: "Couldn’t create the settlement document. Try again.", shareFailed: "The system couldn’t complete the export. Try again.",
  },
} as const;

function CaptureReceipt({ job, onCaptured }: { job: Job; onCaptured: (job: Job, captured?: CapturedPng) => void }) {
  const view = useRef<ComponentRef<typeof View>>(null);
  const [height, setHeight] = useState(0);
  const [bounds, setBounds] = useState<{ width: number; height: number }>();
  const pixels = PixelRatio.get();
  const frame = height > 0 ? settlementPngLayout(settlementReceiptWidth, height, pixels) : undefined;
  const ready = frame && bounds && Math.abs(frame.width - bounds.width) < 1 / pixels
    && Math.abs(frame.height - bounds.height) < 1 / pixels;

  useLayoutEffect(() => {
    if (!ready) return;
    let current = true;
    let pending: LocalSharePng | undefined;
    const request = requestAnimationFrame(() => {
      void (async () => {
        try {
          if (!view.current) throw new Error("Missing capture view");
          pending = await captureLocalSharePng(view.current, job.card.fileName);
          if (!current) { pending.discard(); return; }
          const { width, height: imageHeight } = await Image.getSize(pending.uri);
          if (!current) return;
          if (!(width > 0 && imageHeight > 0)) throw new Error("Invalid PNG size");
          const image = pending;
          pending = undefined;
          onCaptured(job, { image, aspectRatio: width / imageHeight });
        } catch {
          pending?.discard();
          pending = undefined;
          if (current) onCaptured(job);
        }
      })();
    });
    return () => {
      current = false;
      cancelAnimationFrame(request);
      pending?.discard();
    };
  }, [ready, job, onCaptured]);

  function measure(event: LayoutChangeEvent) {
    setHeight(event.nativeEvent.layout.height);
  }

  return (
    <View ref={view} collapsable={false} onLayout={({ nativeEvent }) => setBounds(nativeEvent.layout)}
      accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" pointerEvents="none"
      style={[styles.capture, { width: frame?.width ?? settlementReceiptWidth, height: frame?.height ?? 1 }]}>
      <View onLayout={measure} style={[styles.receipt, frame && { transform: [{ scale: frame.scale }] }]}>
        <ActivitySettlementPngReceipt card={job.card} />
      </View>
    </View>
  );
}

function ActionRow({ mark, label, caption, onPress, divider = false, disabled }: {
  mark: string; label: string; caption: string; onPress: () => void; divider?: boolean; disabled: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.actionRow, divider && styles.divider, pressed && styles.pressed]}>
      <View style={styles.actionMark}><Text accessible={false} style={[styles.mark, mark.length > 1 && styles.fileMark]}>{mark}</Text></View>
      <View style={styles.actionText}><Text style={styles.actionLabel}>{label}</Text><Text style={styles.caption}>{caption}</Text></View>
      <Icon name="next" size={16} color={colors.muted} />
    </Pressable>
  );
}

export function ActivitySettlementPngScreen({ activityId, appLocale, onBack }: { activityId: string; appLocale: string; onBack: () => void }) {
  const { openPro } = usePro();
  const { status: proStatus } = useProSnapshot();
  const [initialOutputLanguage] = useState(() => resolveSettlementPngLanguages({ appLocale }).outputLanguage);
  const [page, setPage] = useState<Page>("preview");
  const [busy, setBusy] = useState<Busy>();
  const [issue, setIssue] = useState<Issue>();
  const [documentOutcome, setDocumentOutcome] = useState<DocumentOutcome>();
  const [job, setJob] = useState<Job>();
  const [preview, setPreview] = useState<Preview>();
  const active = useRef(false);
  const operation = useRef<object | undefined>(undefined);
  const latest = useRef<Preview | undefined>(undefined);
  const usingImage = useRef<LocalSharePng | undefined>(undefined);
  const { appLanguage, copy, outputLanguage } = resolveSettlementPngLanguages({
    appLocale, selectedOutputLanguage: preview?.card.language ?? initialOutputLanguage,
  });
  const documents = documentCopy[appLanguage];

  const finish = useCallback(() => {
    operation.current = undefined;
    setBusy(undefined);
  }, []);

  const generate = useCallback(async (outputLanguage: SettlementPngLanguage, snapshot?: SettlementPngSnapshot) => {
    if (operation.current) return;
    const request = {};
    operation.current = request;
    setBusy("generate");
    setIssue(undefined);
    setDocumentOutcome(undefined);
    let current: SettlementPngSnapshot | null;
    try {
      current = snapshot ?? await loadSettlementPngSnapshot(activityId);
    } catch {
      current = null;
    }
    if (operation.current !== request) return;
    if (!current) {
      setIssue("readFailed");
      finish();
      return;
    }
    try {
      setJob({ snapshot: current, card: buildSettlementPngCard(current, outputLanguage) });
    } catch {
      setIssue("generateFailed");
      finish();
    }
  }, [activityId, finish]);

  useEffect(() => {
    active.current = true;
    void generate(initialOutputLanguage);
    return () => {
      active.current = false;
      operation.current = undefined;
      const image = latest.current?.image;
      if (image !== usingImage.current) image?.discard();
      latest.current = undefined;
    };
  }, [generate, initialOutputLanguage]);

  const onCaptured = useCallback((completed: Job, captured?: CapturedPng) => {
    if (!active.current) { captured?.image.discard(); return; }
    setJob(undefined);
    if (captured) {
      const next = { ...completed, ...captured };
      latest.current?.image.discard();
      latest.current = next;
      setPreview(next);
      setPage("preview");
    } else {
      setIssue("generateFailed");
    }
    finish();
  }, [finish]);

  function back() {
    if (operation.current && busy !== "generate") return;
    setIssue(undefined);
    setDocumentOutcome(undefined);
    if (page === "actions") setPage("preview");
    else onBack();
  }

  async function usePreview(action: "save" | "share") {
    if (operation.current || !preview || issue === "imageMissing") return;
    operation.current = {};
    setBusy(action);
    setIssue(undefined);
    setDocumentOutcome(undefined);
    const { image } = preview;
    usingImage.current = image;
    try {
      if (action === "save") {
        const outcome = await saveSharePngToPhotos(image.uri);
        if (!active.current) return;
        if (outcome === "saved") setPage("saved");
        else setIssue(({ unavailable: "photosUnavailable", cancelled: "saveCancelled", denied: "saveDenied", failed: "saveFailed" } as const)[outcome]);
      } else if (await canShareLocalPng()) {
        if (active.current) await presentLocalSharePng(image, copy.share);
      } else if (active.current) {
        setIssue("shareUnavailable");
      }
    } catch {
      if (active.current) setIssue(action === "save" ? "saveFailed" : "shareFailed");
    } finally {
      usingImage.current = undefined;
      if (active.current) finish();
      else image.discard();
    }
  }

  async function exportDocument(format: SettlementDocumentFormat) {
    if (operation.current || !preview || issue === "imageMissing") return;
    if (!hasVerifiedProAccess()) {
      openPro();
      return;
    }
    operation.current = {};
    setBusy("document");
    setIssue(undefined);
    setDocumentOutcome(undefined);
    try {
      const outcome = await shareSettlementDocument(preview, format, settlementDocumentPlatform, {
        hasVerifiedProAccess, isActive: () => active.current, title: documents[format],
        onPresenting: () => setBusy("share"),
      });
      if (active.current) setDocumentOutcome(outcome);
    } finally {
      if (active.current) finish();
    }
  }

  const changeLanguage = (next: SettlementPngLanguage) => {
    if (next !== outputLanguage && preview) void generate(next, preview.snapshot);
  };
  const regenerate = () => { void generate(outputLanguage); };
  const unavailable = issue === "imageMissing";
  const isBusy = busy !== undefined;
  const isPresenting = busy === "save" || busy === "share" || busy === "document";
  const showActions = () => {
    if (operation.current || unavailable) return;
    setIssue(undefined);
    setDocumentOutcome(undefined);
    setPage("actions");
  };
  const previewImage = (style: "previewImage" | "thumbnail" | "savedImage") => preview && (
    <Image key={preview.image.uri} accessibilityLabel={copy.imageLabel} source={{ uri: preview.image.uri }}
      resizeMode="contain" style={[styles[style], style !== "thumbnail" && { aspectRatio: preview.aspectRatio }]}
      onError={style === "previewImage" ? () => setIssue("imageMissing") : undefined} />
  );

  return (
    <View style={styles.screen}>
      {job && <CaptureReceipt job={job} onCaptured={onCaptured} />}
      <ConversionPage key={page} title={copy[page === "saved" ? "savedTitle" : page]}
        backLabel={page === "actions" ? copy.backToPreview : copy.backToSettlement} onBack={back} busy={isPresenting}
        footer={page === "preview" ? <ButtonPair secondary={{ label: copy.backToSettlement, action: back }}
          primary={{ label: preview && !unavailable ? copy.actions : copy.regenerate,
            action: preview && !unavailable ? showActions : regenerate, disabled: isBusy }} />
          : page === "actions" ? <Pressable accessibilityRole="button" disabled={isPresenting} onPress={back}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.actionLabel}>{copy.backToPreview}</Text></Pressable>
            : <ConversionButton label={copy.backToSettlement} onPress={onBack} />}>
        {busy === "generate" || busy === "save" || busy === "document" ? (
          <View style={styles.statusLine} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.ink} /><Text style={styles.caption}>{busy === "generate" ? copy.generating
              : busy === "save" ? copy.saving : documents.generating}</Text>
          </View>
        ) : null}
        {issue && <Notice alert={issue !== "saveCancelled"}>{copy[issue]}
          {preview && (issue === "readFailed" || issue === "generateFailed") ? ` ${copy.keepPrevious}` : ""}</Notice>}
        {page === "preview" && preview && <>
          <View style={styles.between}>
            <Text style={styles.caption}>{copy.snapshot}</Text>
            <Text style={styles.badge}>{preview.snapshot.status === "settled" ? copy.settledBadge
              : preview.snapshot.activityStatus === "completed" && preview.snapshot.status === "unsettled"
                ? copy.completedUnsettled : copy.template}</Text>
          </View>
          <View style={styles.previewMat}>{previewImage("previewImage")}</View>
          <Text style={[styles.caption, styles.center]}>{copy.previewNote}</Text>
          <View accessibilityLabel={copy.language} style={styles.language}>
            {(["zh-HK", "en"] as const).map((option) => (
              <Pressable key={option} accessibilityRole="button" accessibilityState={{ selected: option === outputLanguage, disabled: isBusy }}
                disabled={isBusy} onPress={() => changeLanguage(option)} style={styles.languageChoice}>
                <Text style={option === outputLanguage ? styles.selectedLanguage : styles.caption}>{option === "zh-HK" ? "繁體中文" : "English"}</Text>
              </Pressable>
            ))}
          </View>
        </>}
        {page === "actions" && preview && <>
          <View style={styles.between}><Text style={styles.caption}>{copy.chooseAction}</Text><Text style={styles.badge}>{copy.ready}</Text></View>
          <View style={[styles.card, styles.fileCard]}>
            {previewImage("thumbnail")}
            <View style={styles.actionText}><Text style={styles.actionLabel}>{preview.card.fileName}</Text>
              <Text style={styles.caption}>{copy.templateFile}</Text></View>
          </View>
          <View style={styles.card}>
            <ActionRow mark="↓" label={copy.save} caption={copy.saveHint} disabled={isBusy || unavailable} onPress={() => void usePreview("save")} />
            <ActionRow mark="⇧" label={copy.share} caption={copy.shareHint} disabled={isBusy || unavailable} onPress={() => void usePreview("share")} divider />
            <ActionRow mark="⟳" label={copy.regenerate} caption={copy.regenerateHint} disabled={isBusy} onPress={regenerate} divider />
          </View>
          <Notice>{copy.shareNote}</Notice>
          <View>
            <Text accessibilityRole="header" style={styles.actionLabel}>{documents.heading}</Text>
            <Text style={styles.caption}>{documents.output(outputLanguage === "zh-HK" ? "繁體中文" : "English")}</Text>
          </View>
          <View style={styles.card}>
            <ActionRow mark="PDF" label={documents.pdf} caption={proStatus === "free" ? documents.locked
              : proStatus === "pro" ? documents.pdfHint : documents.proRequired}
              disabled={isBusy || unavailable} onPress={() => void exportDocument("pdf")} />
            <ActionRow mark="CSV" label={documents.csv} caption={proStatus === "free" ? documents.locked
              : proStatus === "pro" ? documents.csvHint : documents.proRequired}
              disabled={isBusy || unavailable} onPress={() => void exportDocument("csv")} divider />
          </View>
          {documentOutcome && <View accessibilityLiveRegion="polite">
            <Notice alert={documentOutcome !== "completed" && documentOutcome !== "cancelled"}>{documents[documentOutcome]}</Notice>
          </View>}
        </>}
        {page === "saved" && (
          <View style={styles.success} accessibilityLiveRegion="polite">
            <View style={styles.successMark}><Icon name="check" size={48} /></View>
            <Text style={styles.successTitle}>{copy.saved}</Text><Text style={styles.caption}>{copy.savedHint}</Text>
            {previewImage("savedImage")}
          </View>
        )}
      </ConversionPage>
    </View>
  );
}

const card = { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 18 };
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  capture: { position: "absolute", top: 0, left: 0, backgroundColor: colors.surface },
  receipt: { position: "absolute", left: 0, top: 0, width: settlementReceiptWidth, transformOrigin: "top left" },
  statusLine: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, paddingVertical: 12 },
  between: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  badge: { color: colors.muted, ...card, borderRadius: 18, fontSize: 12, fontWeight: "700", paddingHorizontal: 10, paddingVertical: 5 },
  center: { textAlign: "center" },
  previewMat: { backgroundColor: colors.tile, borderRadius: 18, paddingHorizontal: 22, paddingVertical: 12 },
  previewImage: { width: "100%", backgroundColor: colors.surface },
  language: { flexDirection: "row", alignSelf: "center", gap: 12 },
  languageChoice: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  selectedLanguage: { color: colors.ink, fontWeight: "700", fontSize: 13 },
  card: { ...card, paddingHorizontal: 14 },
  fileCard: { flexDirection: "row", alignItems: "center", gap: 15, paddingVertical: 13 },
  thumbnail: { width: 64, height: 91, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 76, paddingVertical: 12 },
  divider: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  actionMark: { width: 37, height: 37, alignItems: "center", justifyContent: "center", backgroundColor: colors.tile, borderRadius: 10 },
  mark: { color: colors.ink, fontSize: 22, fontWeight: "500" },
  fileMark: { fontSize: 11, fontWeight: "700" },
  actionText: { flex: 1, gap: 4 },
  actionLabel: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  pressed: { opacity: 0.65 },
  secondary: { ...card, borderRadius: 13, minHeight: 52, alignItems: "center", justifyContent: "center" },
  success: { alignItems: "center", paddingTop: 64, gap: 16 },
  successMark: { width: 92, height: 92, borderRadius: 46, backgroundColor: colors.tile, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  successTitle: { fontSize: 25, fontWeight: "800", color: colors.ink, textAlign: "center" },
  savedImage: { width: 155, maxHeight: 220, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, marginTop: 20 },
});
