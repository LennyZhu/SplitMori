import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuickSplit } from "../src/domain/quickSplit.ts";
import { describeQuickSplitResult, formatResultMoney } from "../src/services/quickSplitResult.ts";

const members = [
  { id: "b", displayName: "阿寶" },
  { id: "a", displayName: "阿明" },
  { id: "c", displayName: "阿辰" },
];

function resultFor(input) {
  const calculated = calculateQuickSplit(input);
  assert.equal(calculated.ok, true, JSON.stringify(calculated));
  return describeQuickSplitResult({ input, snapshot: calculated.value });
}

test("quick result shows real suggestions for a merchant payer outside the split", () => {
  const result = resultFor({
    members,
    charges: { kind: "finalTotal", total: { currency: "HKD", amountMinor: 10001 } },
    method: { kind: "equal", memberIds: ["b", "a"] },
    merchantPayerId: "c",
  });

  assert.equal(result.payerName, "阿辰");
  assert.deepEqual(result.members.map(({ id, name, amountMinor }) => [id, name, amountMinor]), [
    ["b", "阿寶", 5001],
    ["a", "阿明", 5000],
  ]);
  assert.deepEqual(result.suggestions.map(({ fromMemberId, toMemberId, fromName, toName, amountMinor }) =>
    [fromMemberId, toMemberId, fromName, toName, amountMinor]), [
    ["b", "c", "阿寶", "阿辰", 5001],
    ["a", "c", "阿明", "阿辰", 5000],
  ]);
  assert.equal(result.allocatedMinor, 10001n);
  assert.equal(result.balanced, true);
});

test("quick result without a payer preserves a whole-yen remainder and shows no routes", () => {
  const result = resultFor({
    members: members.slice(0, 2),
    charges: { kind: "finalTotal", total: { currency: "JPY", amountMinor: 10001 } },
    method: { kind: "equal", memberIds: ["b", "a"] },
  });

  assert.equal(result.payerName, undefined);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.balanced, true);
  assert.equal(formatResultMoney(result.currency, result.allocatedMinor), "JPY 10,001");
  assert.deepEqual(result.members.map(({ amountMinor }) => formatResultMoney(result.currency, amountMinor)), [
    "JPY 5,001", "JPY 5,000",
  ]);
  assert.ok(result.roundingNote);

  for (const currency of ["HKD", "CNY", "MOP", "TWD", "USD"]) {
    assert.equal(formatResultMoney(currency, Number.MAX_SAFE_INTEGER), `${currency} 90,071,992,547,409.91`);
  }
});

test("charged individual details preserve each base, fee and discount and conserve the receipt", () => {
  const result = resultFor({
    members: members.slice(0, 2),
    charges: {
      kind: "details",
      subtotal: { currency: "HKD", amountMinor: 10001 },
      serviceFee: { kind: "manual", amountMinor: 701 },
      discountMinor: 300,
    },
    method: {
      kind: "individual",
      personalSpending: [{ memberId: "b", personalMinor: 4000 }, { memberId: "a", personalMinor: 4000 }],
      shared: { amountMinor: 2001, memberIds: ["b", "a"] },
    },
  });

  assert.equal(result.totalMinor, 10402);
  assert.equal(result.allocatedMinor, 10402n);
  assert.equal(result.balanced, true);
  assert.deepEqual(result.members.map(({ amountMinor }) => amountMinor), [5202, 5200]);
  assert.deepEqual(result.members.map(({ breakdown }) =>
    breakdown.map(({ amountMinor, deduction }) => deduction ? -amountMinor : amountMinor)), [
    [4000, 1001, 351, -150],
    [4000, 1000, 350, -150],
  ]);
  for (const { amountMinor, breakdown } of result.members) {
    assert.equal(breakdown.reduce((total, row) => total + (row.deduction ? -row.amountMinor : row.amountMinor), 0), amountMinor);
  }
});

test("treat details separate the host's commitment from the remainder", () => {
  const result = resultFor({
    members,
    charges: {
      kind: "details",
      subtotal: { currency: "TWD", amountMinor: 10001 },
      serviceFee: { kind: "manual", amountMinor: 701 },
      discountMinor: 300,
    },
    method: {
      kind: "treat",
      memberIds: ["b", "a", "c"],
      options: { hostId: "a", cover: { kind: "fixed", amountMinor: 4000 }, includeHostInRemainder: true },
    },
  });

  assert.equal(result.balanced, true);
  assert.deepEqual(result.chargeBreakdown.map(({ amountMinor, deduction }) => deduction ? -amountMinor : amountMinor),
    [10001, 701, -300]);
  assert.deepEqual(result.members.map(({ amountMinor, breakdown }) =>
    [amountMinor, breakdown.map((row) => row.amountMinor)]), [
    [2134, [2134]],
    [6134, [4000, 2134]],
    [2134, [2134]],
  ]);
});
