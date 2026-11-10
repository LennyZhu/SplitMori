export type EntitlementStatus = "loading" | "free" | "pro" | "unknown" | "error";
export type StoreEntitlement = "free" | "pro" | "unverified";
export type PurchaseResult = "verified" | "unverified" | "pending" | "cancelled";
export type PurchaseStatus = "idle" | "purchasing" | "pending" | "cancelled" | "purchased" | "failed"
  | "verificationFailed" | "finishPending" | "restoring" | "restored" | "restoreNone" | "restoreFailed";
type Product = { status: "loading" | "unsupported" | "unconfigured" | "unavailable" | "failed" }
  | { status: "available"; displayPrice: string };
type Snapshot = {
  status: EntitlementStatus;
  product: Product;
  purchase: PurchaseStatus;
  lastKnownPro: boolean;
  hasProAccess: boolean;
  awaitingApproval: boolean;
};

export type TransactionChange = { productId: string; revoked: boolean };
export type StoreKitAdapter = {
  getProduct(productId: string): Promise<string | null>;
  readEntitlement(productId: string): Promise<StoreEntitlement>;
  purchase(productId: string): Promise<PurchaseResult>;
  syncPurchases(): Promise<void>;
  unfinished(productId: string): Promise<readonly string[]>;
  finish(productId: string, transactionId: string): Promise<void>;
  subscribe(listener: (event: TransactionChange) => void): () => void;
};

export type EntitlementDisplayCache = {
  load(productId: string): Promise<boolean>;
  save(productId: string, wasPro: boolean): Promise<void>;
};

export type ProAccess = () => boolean;
export const freeAccess: ProAccess = () => false;

export function createProEntitlement(store: StoreKitAdapter | null, productId: string, cache: EntitlementDisplayCache) {
  let state: Snapshot = {
    status: store && productId ? "loading" : "unknown",
    product: { status: !store ? "unsupported" : !productId ? "unconfigured" : "loading" },
    purchase: "idle", lastKnownPro: false, hasProAccess: false, awaitingApproval: false,
  };
  const listeners = new Set<() => void>();
  const finished = new Set<string>();
  let lastVerifiedPro = false;
  let persisted: boolean | undefined;
  let revision = 0;
  let tail = Promise.resolve();
  let disconnect: (() => void) | undefined;
  let loadingProduct: Promise<void> | undefined;
  let operationInProgress = false;

  function update(next: Partial<typeof state>) {
    state = { ...state, ...next, hasProAccess: lastVerifiedPro };
    listeners.forEach((listener) => listener());
  }

  function enqueue(work: () => Promise<void>) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }

  async function confirmEntitlement(): Promise<"pro" | "free" | "finishPending" | undefined> {
    if (!store || !productId) return;
    const readRevision = revision;
    let result: StoreEntitlement;
    try {
      result = await store.readEntitlement(productId);
    } catch {
      update({ status: "unknown" });
      return;
    }
    if (readRevision !== revision) return;
    if (result !== "pro" && result !== "free") {
      lastVerifiedPro = false;
      update({ status: "error" });
      return;
    }

    lastVerifiedPro = result === "pro";
    const confirmedPro = lastVerifiedPro;
    const noLongerPro = !confirmedPro && (state.purchase === "purchased" || state.purchase === "restored" || state.purchase === "finishPending");
    update({ status: result, lastKnownPro: confirmedPro, awaitingApproval: !confirmedPro && state.awaitingApproval,
      ...(noLongerPro ? { purchase: "idle" as const } : {}) });
    let canFinish = true;
    if (persisted !== confirmedPro) {
      try {
        await cache.save(productId, confirmedPro);
        persisted = confirmedPro;
      } catch {
        canFinish = false;
      }
    }
    if (readRevision !== revision) return;
    if (confirmedPro) {
      try {
        const outstanding = await store.unfinished(productId);
        if (!canFinish && outstanding.length) return readRevision === revision ? "finishPending" : undefined;
        for (const id of outstanding) {
          if (readRevision !== revision) return;
          if (finished.has(id)) continue;
          await store.finish(productId, id);
          finished.add(id);
        }
      } catch {
        return readRevision === revision ? "finishPending" : undefined;
      }
    }
    return readRevision === revision ? result : undefined;
  }

  const refresh = () => enqueue(async () => {
    const retrying = state.awaitingApproval || state.purchase === "finishPending" || state.purchase === "verificationFailed";
    const result = await confirmEntitlement();
    if (!operationInProgress) {
      if (result === "finishPending") update({ purchase: result });
      else if (result === "pro" && retrying) update({ purchase: "purchased" });
    }
  });

  return {
    getSnapshot: () => state,
    hasProAccess: () => lastVerifiedPro,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (!store || !productId || disconnect) return;
      disconnect = store.subscribe(({ productId: changedProduct, revoked }) => {
        if (changedProduct !== productId) return;
        if (revoked) {
          revision++;
          lastVerifiedPro = false;
          update({ status: "unknown", lastKnownPro: false,
            ...(!operationInProgress ? { purchase: "idle" as const } : {}) });
        }
        void refresh();
      });
      void enqueue(async () => {
        try {
          const wasPro = await cache.load(productId);
          if (state.status === "loading") update({ lastKnownPro: wasPro });
        } catch {
          // StoreKit is authoritative even when display storage is unavailable.
        }
      });
      void refresh();
    },
    stop() {
      disconnect?.();
      disconnect = undefined;
    },
    refresh,
    loadProduct() {
      if (!store || !productId) return Promise.resolve();
      if (loadingProduct) return loadingProduct;
      update({ product: { status: "loading" } });
      loadingProduct = (async () => {
        try {
          const displayPrice = await store.getProduct(productId);
          update({ product: displayPrice ? { status: "available", displayPrice } : { status: "unavailable" } });
        } catch {
          update({ product: { status: "failed" } });
        }
      })().finally(() => { loadingProduct = undefined; });
      return loadingProduct;
    },
    purchase() {
      if (!store || !productId || state.product.status !== "available" || operationInProgress
        || state.awaitingApproval || state.status !== "free") return Promise.resolve();
      operationInProgress = true;
      update({ purchase: "purchasing" });
      return enqueue(async () => {
        if (state.status !== "free") { update({ purchase: "idle" }); return; }
        try {
          const result = await store.purchase(productId);
          if (result === "cancelled" || result === "pending") {
            update({ purchase: result, awaitingApproval: result === "pending" });
            return;
          }
          if (result === "unverified") {
            update({ status: "error", purchase: "verificationFailed" });
            return;
          }
          const confirmed = await confirmEntitlement();
          if (confirmed === "free") update({ status: "unknown" });
          update({ purchase: confirmed === "finishPending" ? confirmed : confirmed === "pro" ? "purchased" : "verificationFailed" });
        } catch {
          update({ purchase: "failed" });
        }
      }).finally(() => { operationInProgress = false; });
    },
    restore() {
      if (!store || !productId || operationInProgress) return Promise.resolve();
      operationInProgress = true;
      update({ purchase: "restoring" });
      return enqueue(async () => {
        try {
          await store.syncPurchases();
          const confirmed = await confirmEntitlement();
          update({
            purchase: confirmed === "finishPending" ? confirmed : confirmed === "pro" ? "restored" : confirmed === "free"
              ? state.awaitingApproval ? "pending" : "restoreNone" : "restoreFailed",
          });
        } catch {
          update({ purchase: "restoreFailed" });
        }
      }).finally(() => { operationInProgress = false; });
    },
  };
}
