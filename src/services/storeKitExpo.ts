import { requireOptionalNativeModule, type EventSubscription } from "expo";
import Constants from "expo-constants";
import { SQLiteStorage } from "expo-sqlite/kv-store";
import { Platform } from "react-native";
import { createProEntitlement, type StoreKitAdapter, type TransactionChange } from "./proEntitlement.ts";

type StoreKitModule = Omit<StoreKitAdapter, "subscribe"> & {
  addListener(event: "transactionChanged", listener: (event: TransactionChange) => void): EventSubscription;
};
const native = Platform.OS === "ios" ? requireOptionalNativeModule<StoreKitModule>("SplitMoriStoreKit") : null;
const configuredProduct = Constants.expoConfig?.extra?.lifetimeProProductId;
const productId = typeof configuredProduct === "string" ? configuredProduct.trim() : "";
const cache = new SQLiteStorage("splitmori-storekit-ui.db");

const adapter: StoreKitAdapter | null = native && {
  getProduct: async (id) => await native.getProduct(id) ?? null,
  readEntitlement: (id) => native.readEntitlement(id),
  purchase: (id) => native.purchase(id),
  syncPurchases: () => native.syncPurchases(),
  unfinished: (id) => native.unfinished(id),
  finish: (id, transactionId) => native.finish(id, transactionId),
  subscribe(listener) {
    const subscription = native.addListener("transactionChanged", listener);
    return () => subscription.remove();
  },
};

// This database is outside the ledger export. Its cache is used only for display before StoreKit verification.
export const proEntitlement = createProEntitlement(adapter, productId, {
  load: async (id) => await cache.getItem(id) === "pro",
  save: (id, wasPro) => cache.setItem(id, wasPro ? "pro" : "free"),
});

// High-risk new multi-payer writes require current confirmation, not the session fallback.
export const hasVerifiedProAccess = () => proEntitlement.getSnapshot().status === "pro";
