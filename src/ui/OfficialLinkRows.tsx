import Constants from "expo-constants";
import { useContext, useState } from "react";
import { Linking } from "react-native";
import { officialLink } from "../services/officialLinks.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";
import { settingsCopy } from "./settingsCopy.ts";
import { SettingsNote, SettingsRow } from "./SettingsUi.tsx";

const links = [
  { page: "support", icon: "help" },
  { page: "privacy", icon: "shield" },
  { page: "terms", icon: "file" },
] as const;

export function OfficialLinkRows() {
  const language = useContext(AppLanguageContext);
  const copy = settingsCopy(language);
  const [failed, setFailed] = useState(false);

  async function open(url: string) {
    setFailed(false);
    try {
      await Linking.openURL(url);
    } catch {
      setFailed(true);
    }
  }

  return <>
    {links.map(({ page, icon }, index) => {
      const url = officialLink(Constants.expoConfig?.extra?.legalSiteOrigin, language, page);
      return <SettingsRow key={page} title={copy[page]} icon={icon} divider={index > 0}
        disabled={!url} detail={url ? undefined : copy.unavailableLink}
        onPress={url ? () => { void open(url); } : undefined} />;
    })}
    {failed && <SettingsNote alert>{copy.openLinkFailed}</SettingsNote>}
  </>;
}
