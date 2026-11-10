import Constants from "expo-constants";
import { useContext, useState } from "react";
import { Text, View } from "react-native";
import type { Currency } from "../domain/money.ts";
import { currencyLabels, type AppLanguage, type AppPreferences, type LanguagePreference } from "../services/appPreferences.ts";
import { proEntitlement } from "../services/storeKitExpo.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";
import { OfficialLinkRows } from "./OfficialLinkRows.tsx";
import { usePro, useProSnapshot } from "./ProContext.ts";
import { isRestoreStatus, proCopy } from "./proCopy.ts";
import { SettingsBackupScreen } from "./SettingsBackupScreen.tsx";
import { languageNames, languageOptions, settingsCopy } from "./settingsCopy.ts";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, SettingsValue, settingsStyles as styles } from "./SettingsUi.tsx";

const config = Constants.expoConfig;
const name = config?.name ?? "SplitMori";
const version = config?.version;
const build = Constants.platform?.ios?.buildNumber ?? config?.ios?.buildNumber
  ?? Constants.platform?.android?.versionCode ?? config?.android?.versionCode;

export function SettingsScreen({ preferences, systemLanguage, saving, preferenceError, onSave, onBack, onRestored, restored, recoveryRequired, onReturnToSettings }: {
  preferences: AppPreferences; systemLanguage: AppLanguage; saving: boolean; preferenceError?: "load" | "save";
  onSave: (next: AppPreferences) => Promise<void>; onBack: () => void; onRestored: () => void;
  restored?: boolean; recoveryRequired?: boolean; onReturnToSettings: () => void;
}) {
  const language = useContext(AppLanguageContext);
  const copy = settingsCopy(language);
  const purchaseCopy = proCopy(language);
  const { openPro } = usePro();
  const { status, lastKnownPro, product, purchase } = useProSnapshot();
  const [page, setPage] = useState<"main" | "language" | "currency" | "backup" | "about">("main");
  const [restoreRequested, setRestoreRequested] = useState(false);
  const restoreUnavailable = product.status === "unsupported" || product.status === "unconfigured";
  const storeBusy = purchase === "purchasing" || purchase === "restoring";
  const restoreFeedback = restoreRequested && (isRestoreStatus(purchase) || purchase === "pending" || purchase === "finishPending")
    ? purchase : undefined;
  const main = () => setPage("main");
  const back = () => { if (!saving) page === "main" ? onBack() : main(); };
  const languageLabel = (preference: LanguagePreference) => preference === "system" ? copy.system : languageNames[preference];
  const currentCurrency = preferences.defaultCurrency;
  if (page === "backup" || restored || recoveryRequired) {
    return <SettingsBackupScreen language={language} onBack={restored || recoveryRequired ? onReturnToSettings : main}
      onRestored={onRestored} restored={restored} recoveryRequired={recoveryRequired} />;
  }

  return (
    <SettingsPage key={page} title={page === "main" ? copy.settings : copy[page]} backLabel={copy.back}
      onBack={back} busy={saving} busyLabel={copy.working}>
      {preferenceError && <SettingsNote alert>{preferenceError === "load" ? copy.loadPreferencesFailed : copy.savePreferencesFailed}</SettingsNote>}
      {page === "main" && <>
        <SettingsGroup title={copy.general}>
          <SettingsRow title={copy.language} icon="globe" detail={preferences.language === "system"
            ? `${copy.system} · ${languageNames[language]}` : languageLabel(preferences.language)} onPress={() => setPage("language")} />
          <SettingsRow title={copy.currency} icon="coins" detail={`${currentCurrency} · ${currencyLabels[currentCurrency][language]}`}
            onPress={() => setPage("currency")} divider />
        </SettingsGroup>
        <SettingsGroup title={copy.data}>
          <SettingsRow title={copy.backup} detail={copy.backupSubtitle} icon="database" onPress={() => setPage("backup")} />
        </SettingsGroup>
        <SettingsGroup title={copy.purchases}>
          <SettingsRow title={purchaseCopy.title} detail={lastKnownPro && (status === "loading" || status === "unknown")
            ? purchaseCopy.lastKnown : purchaseCopy[status]} icon="crown"
            onPress={() => { setRestoreRequested(false); openPro(); }} />
          <SettingsRow title={purchaseCopy.restore} icon="refresh" divider disabled={restoreUnavailable || storeBusy}
            detail={restoreUnavailable ? purchaseCopy[product.status] : undefined}
            onPress={() => { setRestoreRequested(true); void proEntitlement.restore(); }} />
        </SettingsGroup>
        {restoreFeedback && <View accessibilityLiveRegion="polite">
          <SettingsNote alert={restoreFeedback === "restoreFailed"}>{purchaseCopy[restoreFeedback]}</SettingsNote>
        </View>}
        <SettingsGroup title={copy.supportAndLegal}>
          <OfficialLinkRows />
          <SettingsRow title={copy.about} detail={version ? `${copy.appVersion} ${version}` : copy.aboutHint} icon="info"
            onPress={() => setPage("about")} divider />
        </SettingsGroup>
      </>}
      {page === "language" && <>
        <Text style={styles.body}>{copy.languageIntro}</Text>
        <SettingsGroup title={copy.displayLanguage}>
          {languageOptions.map((option, index) => <SettingsRow key={option} title={languageLabel(option)}
            detail={option === "system" ? `${copy.systemLanguage} · ${languageNames[systemLanguage]}`
              : undefined} divider={index > 0} selected={preferences.language === option}
            disabled={saving} onPress={() => { if (option !== preferences.language) void onSave({ ...preferences, language: option }); }} />)}
        </SettingsGroup>
        <SettingsNote>{copy.languageNote}</SettingsNote>
      </>}
      {page === "currency" && <>
        <Text style={styles.body}>{copy.currencyIntro}</Text>
        <SettingsGroup>
          {(Object.keys(currencyLabels) as Currency[]).map((currency, index) => <SettingsRow key={currency} title={currency}
            detail={currencyLabels[currency][language]} selected={currentCurrency === currency} divider={index > 0}
            compact horizontal disabled={saving} onPress={() => { if (currency !== currentCurrency) void onSave({ ...preferences, defaultCurrency: currency }); }} />)}
        </SettingsGroup>
        <SettingsNote>{copy.currencyNote}</SettingsNote>
      </>}
      {page === "about" && <>
        <View style={styles.inline}>
          <View style={styles.brandMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.brandLetter}>S</Text>
          </View>
          <View style={styles.copy}>
            <Text style={styles.headline}>{name}</Text>
            <Text style={styles.caption}>{copy.aboutSummary}</Text>
          </View>
        </View>
        <SettingsGroup>
          <SettingsValue label={copy.appVersion} value={version ?? copy.unavailable} />
          <SettingsValue label={copy.build} value={build == null ? copy.unavailable : String(build)} divider />
          <SettingsValue label={copy.storage} value={copy.localStorage} divider />
          <SettingsValue label={copy.account} value={copy.noAccount} divider />
        </SettingsGroup>
      </>}
    </SettingsPage>
  );
}
