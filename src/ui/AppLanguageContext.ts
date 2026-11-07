import { createContext } from "react";
import type { AppLanguage } from "../services/appPreferences.ts";

export const AppLanguageContext = createContext<AppLanguage>("zh-HK");
