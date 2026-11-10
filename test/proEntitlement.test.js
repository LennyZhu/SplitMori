import assert from "node:assert/strict";
import test from "node:test";
import { createProEntitlement } from "../src/services/proEntitlement.ts";
import { isRestoreStatus, proCopy } from "../src/ui/proCopy.ts";

const sku = "test.lifetime-pro";

function setup({ productId = sku, supported = true, cached = false } = {}) {
  const data = {
    price: "HK$ 38.00", current: "free", result: "verified", unfinished: [], updateEntitlementOnPurchase: true,
    productError: false, readError: false, syncError: false, finishError: false, cacheError: false, cached,
  };
  const calls = [];
  const observers = new Set();
  const adapter = {
    async getProduct(id) {
      calls.push(["product", id]);
      if (data.productError) throw new Error("store");
      return data.price;
    },
    async readEntitlement(id) {
      calls.push(["read", id]);
      if (data.readError) throw new Error("store");
      return data.current;
    },
    async purchase(id) {
      calls.push(["purchase", id]);
      if (data.result === "verified" && data.updateEntitlementOnPurchase) data.current = "pro";
      return data.result;
    },
    async syncPurchases() {
      calls.push(["sync"]);
      if (data.syncError) throw new Error("store");
    },
    async unfinished(id) {
      calls.push(["unfinished", id]);
      return data.unfinished;
    },
    async finish(id, transaction) {
      calls.push(["finish", id, transaction]);
      if (data.finishError) throw new Error("finish");
    },
    subscribe(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
  };
  const cache = {
    async load() { return data.cached; },
    async save(id, value) {
      calls.push(["cache", id, value]);
      if (data.cacheError) throw new Error("cache");
      data.cached = value;
    },
  };
  const service = createProEntitlement(supported ? adapter : null, productId, cache);
  const emit = (event = { productId: sku, revoked: false }) => observers.forEach((fn) => fn(event));
  return { service, data, calls, observers, emit, adapter, cache };
}

test("S12 loads the exact Apple display price and distinguishes unavailable, failed and unconfigured products", async () => {
  const { service, data } = setup();
  await service.loadProduct();
  assert.deepEqual(service.getSnapshot().product, { status: "available", displayPrice: data.price });
  data.price = null;
  await service.loadProduct();
  assert.equal(service.getSnapshot().product.status, "unavailable");
  data.productError = true;
  await service.loadProduct();
  assert.equal(service.getSnapshot().product.status, "failed");
  for (const [options, productStatus] of [[{ productId: "" }, "unconfigured"], [{ supported: false }, "unsupported"]]) {
    const { service, calls } = setup(options);
    service.start();
    await service.loadProduct();
    await service.purchase();
    await service.restore();
    assert.equal(service.getSnapshot().product.status, productStatus);
    assert.equal(service.getSnapshot().status, "unknown");
    assert.equal(service.hasProAccess(), false);
    assert.deepEqual(calls, []);
  }
});

test("S12 purchases once, confirms current entitlement, persists display and finishes each verified transaction once", async () => {
  const { service, data, calls, observers, emit } = setup();
  service.start();
  service.start();
  await service.refresh();
  await service.loadProduct();
  data.unfinished = ["123", "123"];
  await Promise.all([service.purchase(), service.purchase()]);
  assert.equal(service.getSnapshot().status, "pro");
  assert.equal(service.getSnapshot().purchase, "purchased");
  assert.equal(service.hasProAccess(), true);
  emit();
  emit();
  await service.refresh();
  assert.equal(observers.size, 1);
  assert.deepEqual(calls.filter(([kind]) => kind === "purchase" || kind === "finish"),
    [["purchase", sku], ["finish", sku, "123"]]);
  assert.ok(calls.findIndex(([kind, , value]) => kind === "cache" && value === true)
    < calls.findIndex(([kind]) => kind === "finish"));
  service.stop();
  assert.equal(observers.size, 0);
});

test("S12 cancellation and Ask to Buy do not grant access; only a matching verified update unlocks", async () => {
  const { service, data, emit, calls } = setup();
  service.start();
  await service.refresh();
  await service.loadProduct();
  data.result = "cancelled";
  await service.purchase();
  assert.equal(service.getSnapshot().purchase, "cancelled");
  assert.equal(service.hasProAccess(), false);
  data.result = "pending";
  await service.purchase();
  await service.purchase();
  assert.equal(service.getSnapshot().purchase, "pending");
  assert.equal(service.hasProAccess(), false);
  assert.equal(calls.filter(([kind]) => kind === "purchase").length, 2);
  const before = calls.length;
  emit({ productId: "other-product", revoked: false });
  assert.equal(calls.length, before);
  data.current = "pro";
  emit();
  await service.refresh();
  assert.equal(service.getSnapshot().purchase, "purchased");
  assert.equal(service.hasProAccess(), true);
});

test("S12 unverified purchases and unsigned display caches cannot unlock Pro", async () => {
  const { service, data, calls } = setup({ cached: true });
  data.readError = true;
  service.start();
  await service.refresh();
  assert.equal(service.getSnapshot().status, "unknown");
  assert.equal(service.getSnapshot().lastKnownPro, true);
  assert.equal(service.hasProAccess(), false);
  data.readError = false;
  await service.refresh();
  await service.loadProduct();
  data.result = "unverified";
  await service.purchase();
  assert.equal(service.getSnapshot().purchase, "verificationFailed");
  assert.equal(service.getSnapshot().status, "error");
  assert.equal(service.hasProAccess(), false);
  data.current = "unverified";
  await service.refresh();
  assert.equal(service.getSnapshot().status, "error");
  assert.equal(calls.some(([kind]) => kind === "finish"), false);
});

test("S12 waits for current entitlement even if the native purchase call returns a verified transaction", async () => {
  const { service, data, calls } = setup();
  service.start();
  await service.refresh();
  await service.loadProduct();
  data.updateEntitlementOnPurchase = false;
  data.unfinished = ["awaiting"];
  await service.purchase();
  assert.equal(service.getSnapshot().purchase, "verificationFailed");
  assert.equal(service.getSnapshot().status, "unknown");
  assert.equal(service.hasProAccess(), false);
  assert.equal(calls.some(([kind]) => kind === "finish"), false);
  data.current = "pro";
  await service.refresh();
  assert.equal(service.getSnapshot().purchase, "purchased");
  assert.equal(service.hasProAccess(), true);
});

test("S12 recovers an unfinished transaction after cache and finish failures and a fresh launch", async () => {
  const { service, data, adapter, cache, calls } = setup();
  await service.refresh();
  await service.loadProduct();
  data.unfinished = ["456"];
  data.cacheError = true;
  await service.purchase();
  assert.equal(service.getSnapshot().purchase, "finishPending");
  assert.equal(service.hasProAccess(), true);
  assert.equal(calls.filter(([kind]) => kind === "finish").length, 0);
  data.cacheError = false;
  data.finishError = true;
  await service.refresh();
  assert.equal(service.getSnapshot().purchase, "finishPending");
  const relaunched = createProEntitlement(adapter, sku, cache);
  data.finishError = false;
  relaunched.start();
  await relaunched.refresh();
  assert.equal(relaunched.getSnapshot().status, "pro");
  assert.equal(relaunched.hasProAccess(), true);
  assert.deepEqual(calls.filter(([kind]) => kind === "finish"), [["finish", sku, "456"], ["finish", sku, "456"]]);
  assert.equal(calls.some(([kind]) => kind === "sync"), false);
});

test("S12 distinguishes restore outcomes, retains prior access on read failure and honours revocation", async () => {
  const { service, data, emit } = setup();
  service.start();
  await service.restore();
  assert.equal(service.getSnapshot().purchase, "restoreNone");
  data.syncError = true;
  await service.restore();
  assert.equal(service.getSnapshot().purchase, "restoreFailed");
  data.syncError = false;
  data.current = "pro";
  await service.restore();
  await service.restore();
  assert.equal(service.getSnapshot().purchase, "restored");
  assert.equal(service.hasProAccess(), true);
  data.readError = true;
  await service.refresh();
  assert.equal(service.getSnapshot().status, "unknown");
  assert.equal(service.hasProAccess(), true);
  emit({ productId: sku, revoked: true });
  assert.equal(service.hasProAccess(), false);
  data.readError = false;
  data.current = "free";
  await service.refresh();
  assert.equal(service.getSnapshot().status, "free");
  assert.equal(service.getSnapshot().lastKnownPro, false);
});

test("S13 can restore from a Free session without loading the paywall price", async () => {
  const { service, data, calls } = setup();
  await service.refresh();
  assert.equal(service.getSnapshot().status, "free");
  data.current = "pro";

  const restoring = service.restore();
  assert.equal(service.getSnapshot().purchase, "restoring");
  await Promise.all([restoring, service.restore()]);

  assert.equal(service.getSnapshot().purchase, "restored");
  assert.equal(service.getSnapshot().product.status, "loading");
  assert.equal(service.hasProAccess(), true);
  assert.equal(calls.filter(([kind]) => kind === "sync").length, 1);
  assert.equal(calls.some(([kind]) => kind === "product" || kind === "purchase"), false);
});

test("S13 shows localized restore statuses separately from purchase notices", () => {
  for (const status of ["restoring", "restored", "restoreNone", "restoreFailed"]) {
    assert.equal(isRestoreStatus(status), true);
    assert.ok(proCopy("zh-HK")[status]);
    assert.ok(proCopy("en")[status]);
  }
  for (const status of ["purchasing", "purchased", "pending", "finishPending", "verificationFailed"]) {
    assert.equal(isRestoreStatus(status), false);
  }
});

test("S12 Paywall describes one-time billing and the real feature availability in both languages", () => {
  const zh = proCopy("zh-HK");
  const en = proCopy("en");
  assert.match(zh.terms, /一次性買斷.*非訂閱/);
  assert.match(en.terms, /one-time purchase.*no subscription/i);
  assert.match(zh.documentExport, /PDF 及 CSV/);
  assert.match(en.documentExport, /PDF and CSV/);
  assert.doesNotMatch(Object.values(zh).join(" "), /尚未開放|進階 PNG 樣式/);
  assert.doesNotMatch(Object.values(en).join(" "), /still in development|advanced PNG styles/i);
  assert.ok(zh.price("HK$ 38.00").includes("HK$ 38.00"));
  assert.ok(en.price("€4,99").includes("€4,99"));
});
