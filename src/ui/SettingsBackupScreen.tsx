import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppLanguage } from "../services/appPreferences.ts";
import { exportBackup, type BackupExportStage } from "../services/backup.ts";
import { logRestoreFile } from "../services/backupDiagnostics.ts";
import { prepareRestore, restoreBackup, type RestoreOutcome, type RestorePreview } from "../services/restore.ts";
import { describeExportFile, RestoreFileSelectionError, selectBackupFile, shareBackupFile } from "../services/settingsBackupFiles.ts";
import { ButtonPair } from "./FinanceReviewUi.tsx";
import { ConversionButton } from "./QuickSplitConversionScreen.tsx";
import { settingsCopy, type SettingsCopy } from "./settingsCopy.ts";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, SettingsValue, settingsStyles as styles } from "./SettingsUi.tsx";
import { colors, Icon } from "./visuals.tsx";

type PickedFile = NonNullable<Awaited<ReturnType<typeof selectBackupFile>>>;
type Review = { file: PickedFile; preview: RestorePreview };
type ReviewStep = "preview" | "acknowledged" | "confirm";
type Operation = "export" | "share" | "pick" | "restore";
type ValidationCode = Extract<RestoreOutcome, { status: "validation-failed" }>["code"];

const countKeys = ["activityCount", "expenseCount", "refundCount", "repaymentCount", "memberCount", "quickHistoryCount"] as const;

function validationMessage(code: ValidationCode, copy: SettingsCopy) {
  switch (code) {
    case "UNSUPPORTED_BACKUP_VERSION": return copy.unsupported;
    case "INVALID_CONFIRMATION":
    case "BACKUP_CHANGED":
    case "CURRENT_DATA_CHANGED": return copy.stale;
    case "INVALID_BACKUP_URI":
    case "INVALID_BACKUP_FORMAT": return copy.badFormat;
    case "BACKUP_FILE_NOT_FOUND":
    case "BACKUP_READ_FAILED": return copy.cacheReadFailed;
    default: return copy.badIntegrity;
  }
}

function exportFailureMessage(stage: BackupExportStage, copy: SettingsCopy) {
  switch (stage) {
    case "open-ledger": return copy.exportLedgerUnavailable;
    case "snapshot":
    case "snapshot-read": return copy.exportSnapshotFailed;
    case "validate":
    case "checksum": return copy.exportVerificationFailed;
    case "write":
    case "verify-output": return copy.exportWriteFailed;
    case "publish": return copy.exportPublishFailed;
    default: return copy.exportFailed;
  }
}

function RestoreSheet({ review, language, copy, acknowledged, confirming, busy, onAcknowledge, onContinue, onConfirm, onClose }: {
  review: Review; language: AppLanguage; copy: SettingsCopy; acknowledged: boolean; confirming: boolean; busy: boolean;
  onAcknowledge: () => void; onContinue: () => void; onConfirm: () => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { backup, current } = review.preview;
  const time = backup.manifest.createdAt;
  const date = time === null || !Number.isFinite(new Date(time).getTime()) ? copy.unavailable
    : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(time);

  return (
    <Modal visible transparent presentationStyle="overFullScreen" animationType="fade" onRequestClose={onClose}>
      <View style={[local.overlay, { paddingTop: insets.top + 12, paddingLeft: insets.left, paddingRight: insets.right }]}>
        <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[local.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <ScrollView key={confirming ? "confirm" : "preview"} style={local.scroll} contentContainerStyle={local.content}>
            <Text accessibilityRole="header" style={styles.headline}>{confirming ? copy.confirmRestore : copy.preview}</Text>
            {confirming ? <>
              <SettingsNote title={copy.confirmOverwrite}>{copy.confirmBody}</SettingsNote>
              <SettingsNote>{copy.safetyNote}</SettingsNote>
            </> : <>
              <SettingsGroup>
                <SettingsRow title={review.file.name} detail={`${copy.backupTime} · ${date}`} icon="file" />
                <SettingsValue label={copy.backupVersion} value={String(backup.manifest.formatVersion)} divider />
                <SettingsValue label={copy.schemaVersion} value={String(backup.manifest.schemaVersion)} divider />
              </SettingsGroup>
              <SettingsGroup title={copy.previewSummary}>
                <SettingsValue label={copy.dataType} value={copy.currentToBackup} />
                {countKeys.map((key) => <SettingsValue key={key} label={copy[key]} value={`${current[key]} → ${backup[key]}`} divider />)}
              </SettingsGroup>
              <SettingsNote title={copy.overwrite}>{copy.overwriteBody}</SettingsNote>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged }} onPress={onAcknowledge}
                style={({ pressed }) => [styles.card, styles.padded, styles.inline, pressed && styles.pressed]}>
                <View style={[styles.radio, acknowledged && styles.checked]}>
                  {acknowledged && <Icon name="check" size={15} color={colors.onPrimary} />}
                </View>
                <Text style={styles.body}>{copy.acknowledge}</Text>
              </Pressable>
            </>}
          </ScrollView>
          <View style={local.actions}>
            {busy && <View style={styles.progress} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.ink} /><Text style={styles.caption}>{copy.restoring}</Text>
            </View>}
            <ButtonPair secondary={{ label: copy.cancel, action: onClose, disabled: busy }}
              primary={{ label: confirming ? copy.confirmRestore : copy.continueRestore,
                action: confirming ? onConfirm : onContinue, disabled: busy || !acknowledged }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function SettingsBackupScreen({ language, onBack, onRestored, restored = false, recoveryRequired = false }: {
  language: AppLanguage; onBack: () => void; onRestored: () => void; restored?: boolean; recoveryRequired?: boolean;
}) {
  const copy = settingsCopy(language);
  const [review, setReview] = useState<Review>();
  const [retryUri, setRetryUri] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const [showRestored, setShowRestored] = useState(restored);
  const [needsRecovery, setNeedsRecovery] = useState(recoveryRequired);
  const [reviewStep, setReviewStep] = useState<ReviewStep>("preview");
  const [operation, setOperation] = useState<Operation>();
  const mounted = useRef(false);
  const pending = useRef(false);
  const currentReview = useRef<Review>(undefined);

  function releaseReview() {
    const current = currentReview.current;
    currentReview.current = undefined;
    if (!current) return;
    void restoreBackup({ confirmation: current.preview.confirmation, confirmed: false });
    current.file.discard();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!pending.current) releaseReview();
    };
  }, []);

  function dismissReview() {
    if (pending.current) return;
    releaseReview();
    setReview(undefined);
    setReviewStep("preview");
  }

  function back() {
    if (pending.current) return;
    if (currentReview.current) dismissReview();
    else onBack();
  }

  async function run(next: Operation, work: () => Promise<void>, fallback: string) {
    if (pending.current || needsRecovery) return;
    pending.current = true;
    setIssue(undefined);
    setShowRestored(false);
    setOperation(next);
    try {
      await work();
    } catch {
      if (mounted.current) setIssue(fallback);
    } finally {
      pending.current = false;
      if (mounted.current) setOperation(undefined);
      else releaseReview();
    }
  }

  const createAndShare = () => void run(retryUri ? "share" : "export", async () => {
    let uri = retryUri;
    if (!uri) {
      const result = await exportBackup();
      if (!mounted.current) return;
      if (!result.ok) { setIssue(exportFailureMessage(result.stage, copy)); return; }
      uri = result.value.uri;
    }
    try {
      describeExportFile(uri);
    } catch {
      setRetryUri(undefined);
      setIssue(copy.exportFileMissing);
      return;
    }
    setRetryUri(uri);
    setOperation("share");
    const shared = await shareBackupFile(uri, copy.export).catch(() => "failed" as const);
    if (!mounted.current) return;
    if (shared === "closed") setRetryUri(undefined);
    if (shared !== "closed") setIssue(shared === "unavailable" ? copy.shareUnavailable : copy.shareFailed);
  }, copy.exportFailed);

  function failRestore(result: RestoreOutcome) {
    if (result.status === "validation-failed") setIssue(validationMessage(result.code, copy));
    else if (result.status === "recovery-required") setNeedsRecovery(true);
    else if (result.status === "failed") setIssue(copy.originalPreserved);
    else if (result.status === "busy") setIssue(copy.restoreBusy);
  }

  const chooseAndValidate = () => void run("pick", async () => {
    const file = await selectBackupFile().catch((error: unknown) => {
      if (!(error instanceof RestoreFileSelectionError)) throw error;
      if (mounted.current) {
        switch (error.stage) {
          case "picker": setIssue(copy.pickerFailed); break;
          case "picker-result":
          case "source-file": setIssue(copy.sourceReadFailed); break;
          case "cache-copy": setIssue(copy.cacheCopyFailed); break;
          case "cache-read": setIssue(copy.cacheReadFailed); break;
        }
      }
      return null;
    });
    if (!file) return;
    try {
      if (!mounted.current) return;
      logRestoreFile("prepare-restore", "RESTORE_PREPARE_STARTED", { name: file.name, size: file.size });
      const result = await prepareRestore(file.uri);
      const code = result.status === "validation-failed" ? result.code
        : result.status === "ready" ? "RESTORE_PREVIEW_READY"
        : result.status === "recovery-required" ? "RESTORE_RECOVERY_REQUIRED" : "RESTORE_PREPARE_FAILED";
      logRestoreFile("prepare-restore", code, { name: file.name, size: file.size, failed: result.status !== "ready" });
      if (result.status === "ready") {
        const ready = { file, preview: result.preview };
        currentReview.current = ready;
        if (mounted.current) {
          setReviewStep("preview");
          setReview(ready);
        }
      } else if (mounted.current) {
        failRestore(result);
      }
    } finally {
      if (currentReview.current?.file !== file) file.discard();
    }
  }, copy.sourceReadFailed);

  const commit = () => {
    if (reviewStep !== "confirm" || !review || currentReview.current !== review) return;
    void run("restore", async () => {
      // The explicit final action is the only path that submits the one-time confirmation.
      currentReview.current = undefined;
      const result = await restoreBackup({ confirmation: review.preview.confirmation, confirmed: true })
        .catch(() => ({ status: "recovery-required" } as const));
      review.file.discard();
      if (!mounted.current) return;
      setReview(undefined);
      setReviewStep("preview");
      if (result.status === "restored") onRestored();
      else failRestore(result);
    }, copy.recoveryHint);
  };

  const busy = operation !== undefined;
  return (
    <>
      <SettingsPage title={copy.backup} backLabel={copy.back} onBack={back}
        busy={busy && !review && operation !== "share"} busyLabel={copy.working}>
        <Text style={styles.body}>{copy.backupIntro}</Text>
        <ConversionButton label={retryUri ? copy.retryBackupShare : copy.createExport} onPress={createAndShare}
          disabled={busy || needsRecovery} />
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || needsRecovery }} onPress={chooseAndValidate}
          disabled={busy || needsRecovery} style={({ pressed }) => [local.secondary, (pressed || busy || needsRecovery) && styles.pressed]}>
          <Text style={styles.rowTitle}>{copy.import}</Text>
        </Pressable>
        {needsRecovery && <SettingsNote title={copy.recoveryTitle} alert>{copy.recoveryHint}</SettingsNote>}
        {issue && <SettingsNote alert>{issue}</SettingsNote>}
        {showRestored && <View accessibilityLiveRegion="polite"><SettingsNote>{copy.restoredHint}</SettingsNote></View>}
        <SettingsNote>{copy.backupPrivacy}</SettingsNote>
      </SettingsPage>
      {review && <RestoreSheet review={review} language={language} copy={copy} acknowledged={reviewStep !== "preview"}
        confirming={reviewStep === "confirm"} busy={operation === "restore"}
        onAcknowledge={() => {
          if (currentReview.current !== review || pending.current) return;
          setReviewStep((step) => step === "preview" ? "acknowledged" : "preview");
        }}
        onContinue={() => {
          if (currentReview.current === review && !pending.current && reviewStep === "acknowledged") setReviewStep("confirm");
        }}
        onConfirm={commit} onClose={dismissReview} />}
    </>
  );
}

const local = StyleSheet.create({
  secondary: { minHeight: 50, borderRadius: 13, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
    padding: 12, justifyContent: "center", alignItems: "center" },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(40, 40, 40, 0.32)" },
  sheet: { width: "100%", maxWidth: 620, maxHeight: "100%", flexShrink: 1, alignSelf: "center", backgroundColor: colors.surface,
    borderTopLeftRadius: 27, borderTopRightRadius: 27 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { padding: 20, gap: 14 },
  actions: { paddingHorizontal: 20, paddingTop: 8, gap: 8 },
});
