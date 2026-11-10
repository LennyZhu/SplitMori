import { useContext } from "react";
import { copyFor } from "../services/localizedCopy.ts";
import { AppLanguageContext } from "./AppLanguageContext.ts";

export function useCopy() {
  return copyFor(useContext(AppLanguageContext));
}
