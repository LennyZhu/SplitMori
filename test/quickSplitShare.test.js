import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuickSplit } from "../src/domain/quickSplit.ts";
import { describeQuickSplitResult } from "../src/services/quickSplitResult.ts";
import { buildQuickSplitShareCard } from "../src/services/quickSplitShare.ts";

const members = [
  { id: "m1", displayName: "阿明" },
  { id: "m2", displayName: "阿寶" },
  { id: "m3", displayName: "阿辰" },
];
const generatedAt = new Date("2026-11-06T10:35:00Z");

function makeCard(currency, amountMinor, merchantPayerId) {
  const input = {
    members,
    charges: { kind: "finalTotal", total: { currency, amountMinor } },
    method: { kind: "equal", memberIds: members.map(({ id }) => id) },
    merchantPayerId,
  };
  const calculated = calculateQuickSplit(input);
  assert.equal(calculated.ok, true);
  return buildQuickSplitShareCard(describeQuickSplitResult({ input, snapshot: calculated.value }), generatedAt);
}

test("share card uses the named merchant payer and actual snapshot suggestions", () => {
  const card = makeCard("HKD", 94000, "m1");
  assert.equal(card.total, "HKD 940.00");
  assert.equal(card.mode, "平均分攤");
  assert.equal(card.memberCount, 3);
  assert.equal(card.payment.payerName, "阿明");
  assert.deepEqual(card.payment.transfers.map(({ fromName, toName, amount }) => [fromName, toName, amount]), [
    ["阿寶", "阿明", "HKD 313.33"], ["阿辰", "阿明", "HKD 313.33"],
  ]);
  assert.match(card.generatedAt, /2026/);
});

test("share card omits the entire payment section when no merchant payer was entered", () => {
  const card = makeCard("JPY", 10000);
  assert.equal(card.payment, undefined);
  assert.deepEqual(card.members.map(({ name, amount }) => [name, amount]), [
    ["阿明", "JPY 3,334"], ["阿寶", "JPY 3,333"], ["阿辰", "JPY 3,333"],
  ]);
  assert.match(card.roundingNote, /JPY 1/);
});

test("share formatting preserves total and remainder without a floating point conversion", () => {
  const card = makeCard("USD", Number.MAX_SAFE_INTEGER);
  const minor = (amount) => BigInt(amount.replace(/[^0-9]/g, ""));
  assert.equal(card.total, "USD 90,071,992,547,409.91");
  assert.equal(card.members.reduce((sum, { amount }) => sum + minor(amount), 0n), minor(card.total));
});
