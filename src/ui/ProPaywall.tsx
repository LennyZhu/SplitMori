import { useContext } from "react";
import { Text } from "react-native";
import { proEntitlement } from "../services/storeKitExpo.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";
import { useProSnapshot } from "./ProContext.ts";
import { proCopy } from "./proCopy.ts";
import { ConversionButton } from "./QuickSplitConversionScreen.tsx";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, settingsStyles as styles } from "./SettingsUi.tsx";

export function ProPaywall({ onClose }: { onClose: () => void }) {
  const copy = proCopy(useContext(AppLanguageContext));
  const { product, purchase, status, lastKnownPro, hasProAccess, awaitingApproval } = useProSnapshot();
  const canConnect = product.status !== "unsupported" && product.status !== "unconfigured";
  const busy = purchase === "purchasing" || purchase === "restoring";
  const needsRetry = status === "unknown" || status === "error" || purchase === "finishPending"
    || product.status === "failed" || product.status === "unavailable";
  const productMessage = product.status === "available" ? undefined
    : product.status === "loading" ? copy.productLoading
    : product.status === "failed" ? copy.productFailed : copy[product.status];
  const statusMessage = lastKnownPro && (status === "unknown" || status === "loading") ? copy.lastKnown : copy[status];
  const footer = <>
    {!hasProAccess && <ConversionButton
      label={product.status === "available" ? copy.price(product.displayPrice) : copy.buy}
      disabled={product.status !== "available" || status !== "free" || busy || awaitingApproval}
      onPress={() => { void proEntitlement.purchase(); }} />}
    <SettingsRow icon="refresh" title={copy.restore} disabled={!canConnect || busy}
      onPress={() => { void proEntitlement.restore(); }} />
  </>;
  return (
    <SettingsPage title={copy.title} backLabel={copy.back} onBack={onClose} footer={footer}>
      <Text style={styles.headline}>{copy.subtitle}</Text>
      <SettingsGroup title={copy.availableNow}>
        <SettingsRow title={copy.multipleActivities} icon="check" />
        {copy.advancedSplits.map((feature) => <SettingsRow key={feature} title={feature} icon="check" divider compact />)}
        <SettingsRow title={copy.documentExport} icon="check" divider compact />
      </SettingsGroup>
      <SettingsGroup title={copy.planned}>
        {copy.upcoming.map((feature, index) => <SettingsRow key={feature} compact title={feature} divider={index > 0} />)}
      </SettingsGroup>
      <Text style={styles.caption}>{copy.plannedNote}</Text>
      <SettingsNote>{copy.freeSummary}</SettingsNote>
      <Text style={styles.caption}>{copy.terms}</Text>
      <Text accessibilityLiveRegion="polite" style={styles.rowTitle}>{statusMessage}</Text>
      {productMessage && (!hasProAccess || !canConnect) && <Text style={styles.caption}>{productMessage}</Text>}
      {awaitingApproval && purchase !== "pending" && <SettingsNote>{copy.pending}</SettingsNote>}
      {purchase !== "idle" && <SettingsNote alert={purchase === "failed" || purchase === "verificationFailed" || purchase === "restoreFailed"}>
        {copy[purchase]}
      </SettingsNote>}
      {canConnect && needsRetry && <SettingsRow icon="refresh" title={copy.retry} disabled={busy}
        onPress={() => { void proEntitlement.refresh(); void proEntitlement.loadProduct(); }} />}
    </SettingsPage>
  );
}
