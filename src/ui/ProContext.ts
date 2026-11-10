import { createContext, useContext, useSyncExternalStore } from "react";
import { freeAccess } from "../services/proEntitlement.ts";
import { proEntitlement } from "../services/storeKitExpo.ts";

export const ProContext = createContext({ hasProAccess: freeAccess, openPro: (_restore?: boolean) => {} });
export const usePro = () => useContext(ProContext);
export const useProSnapshot = () => useSyncExternalStore(proEntitlement.subscribe, proEntitlement.getSnapshot);
