import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuickSplit } from "../src/domain/quickSplit.ts";
import { splitItemized, splitMultiTreat } from "../src/domain/split.ts";
import { calculateQuickSplitEditor, createQuickSplitEditor, hydrateQuickSplitDraft, serializeQuickSplitDraft } from "../src/services/quickSplitEditor.ts";
import { describeQuickSplitResult } from "../src/services/quickSplitResult.ts";

const ids = ["z", "a", "b"];
const money = (amountMinor) => ({ currency: "HKD", amountMinor });
const amounts = ({ split }) => split.allocations.map(({ amountMinor }) => amountMinor);
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

test("Batch A editor uses existing custom fixed amounts, percentages and shares and restores an unfinished draft", () => {
  const base = { ...createQuickSplitEditor(), mode: "custom", finalTotal: "100.01" };
  const draft = { ...base, customKind: "percentage", customValues: { "member-1": "50", "member-2": "50" } };
  const restored = hydrateQuickSplitDraft(JSON.parse(JSON.stringify(serializeQuickSplitDraft(draft))));
  assert.deepEqual(amounts(value(calculateQuickSplitEditor(restored)).snapshot), [5001, 5000]);
  assert.equal(calculateQuickSplitEditor(restored, false).error.code, "PRO_REQUIRED");
  assert.equal(calculateQuickSplitEditor({ ...draft, customValues: { ...draft.customValues, "member-2": "49.99" } }).error.code, "TOTAL_MISMATCH");
  assert.deepEqual(amounts(value(calculateQuickSplitEditor({
    ...base, customKind: "fixed", customValues: { "member-1": "40.01", "member-2": "60" },
  })).snapshot), [4001, 6000]);
  assert.deepEqual(amounts(value(calculateQuickSplitEditor({
    ...base, customKind: "shares", customValues: { "member-1": "1", "member-2": "2" },
  })).snapshot), [3334, 6667]);
});

test("Batch A hosts commit against the final total and the eligible members split the remaining cent", () => {
  const hosts = [
    { hostId: "z", cover: { kind: "fixed", amountMinor: 3000 } },
    { hostId: "a", cover: { kind: "percentage", basisPoints: 2000 }, includeHostInRemainder: true },
  ];
  const result = value(splitMultiTreat(money(10001), ids, hosts));
  assert.deepEqual(result.allocations.map(({ amountMinor }) => amountMinor), [3000, 4501, 2500]);
  assert.equal(splitMultiTreat(money(10001), ids, [hosts[0], hosts[0]]).error.code, "DUPLICATE_MEMBER_ID");
  assert.equal(splitMultiTreat(money(4000), ids, [{ ...hosts[0], cover: { kind: "fixed", amountMinor: 3500 } }, hosts[1]]).error.code, "COVER_EXCEEDS_TOTAL");
  assert.equal(splitMultiTreat(money(10001), ids.slice(0, 2), [hosts[0], { ...hosts[1], includeHostInRemainder: false }]).error.code,
    "NO_REMAINDER_PARTICIPANTS");
  const half = (hostId) => ({ hostId, cover: { kind: "percentage", basisPoints: 5000 } });
  assert.deepEqual(value(splitMultiTreat(money(1), ids.slice(0, 2), [half("a"), half("z")]))
    .allocations.map(({ amountMinor }) => amountMinor), [1, 0]);
});

test("Batch A item totals split per group and advanced charge allocations conserve the actual receipt", () => {
  const items = [
    { name: "Noodles", quantity: 2, amountMinor: 3001, memberIds: ["a", "z"] },
    { name: "Soup", quantity: 3, amountMinor: 7000, memberIds: ["b", "a"] },
  ];
  assert.deepEqual(value(splitItemized(money(10001), ids, items)).allocations.map(({ amountMinor }) => amountMinor), [1501, 5000, 3500]);
  const input = {
    members: ids.map((id) => ({ id, displayName: id })),
    method: { kind: "individual", memberIds: ids, items },
    charges: {
      kind: "details", subtotal: money(10001), discountMinor: 500,
      serviceFee: { kind: "manual", amountMinor: 1000 }, receiptTotal: money(10501),
      distribution: { serviceFee: { kind: "selected", memberIds: ["b"] }, discount: { kind: "selected", memberIds: ["a", "z"] } },
    },
  };
  const snapshot = value(calculateQuickSplit(input));
  assert.deepEqual(amounts(snapshot), [1251, 4750, 4500]);
  assert.equal(describeQuickSplitResult({ input, snapshot }).members[0].breakdown[0].label, "Noodles");
  assert.equal(splitItemized(money(10001), ids, [{ ...items[0], memberIds: [] }, items[1]]).error.code, "NO_PARTICIPANTS");
  assert.equal(splitItemized(money(10000), ids, items).error.code, "TOTAL_MISMATCH");
  assert.equal(calculateQuickSplit({ ...input, charges: {
    ...input.charges, discountMinor: 2000, receiptTotal: money(9001),
    distribution: { discount: { kind: "selected", memberIds: ["z"] } },
  } }).error.code, "CHARGE_SHARE_NEGATIVE");
  assert.deepEqual(amounts(value(calculateQuickSplit({ ...input, charges: {
    ...input.charges, distribution: { serviceFee: { kind: "equal" }, discount: { kind: "equal" } },
  } }))), [1668, 5166, 3667]);
});
