import assert from "node:assert/strict";
import test from "node:test";
import { formatAmount, parseAmount } from "../src/domain/money.ts";
import { splitEqual, splitTreat } from "../src/domain/split.ts";

function valueOf(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function assertShares(result, expected, total) {
  const value = valueOf(result);
  assert.deepEqual(value.total, total);
  assert.deepEqual(value.allocations.map(({ amountMinor }) => amountMinor), expected);
  assert.equal(value.allocations.reduce((sum, share) => sum + share.amountMinor, 0), total.amountMinor);
  return value;
}

const group = ["host", "a", "b", "c", "d"];
const bill = { currency: "HKD", amountMinor: 100_000 };
const fixed = { hostId: "host", cover: { kind: "fixed", amountMinor: 60_000 } };

test("money round-trips exactly at the supported currency scales and safe integer boundary", () => {
  for (const currency of ["HKD", "CNY", "MOP", "TWD", "USD"]) {
    const amount = valueOf(parseAmount("0.1", currency));
    assert.deepEqual(amount, { currency, amountMinor: 10 });
    assert.equal(valueOf(formatAmount(amount)), "0.10");
  }
  assert.equal(valueOf(formatAmount(valueOf(parseAmount("100", "JPY")))), "100");
  const max = valueOf(parseAmount("90071992547409.91", "HKD"));
  assert.equal(max.amountMinor, Number.MAX_SAFE_INTEGER);
  assert.equal(valueOf(formatAmount(max)), "90071992547409.91");
});

test("money rejects invalid syntax, precision, negative amounts and overflow", () => {
  for (const [input, currency, code] of [
    ["1e3", "HKD", "INVALID_AMOUNT"],
    ["Infinity", "HKD", "INVALID_AMOUNT"],
    ["-0.01", "HKD", "NEGATIVE_AMOUNT"],
    ["0.001", "HKD", "INVALID_AMOUNT_PRECISION"],
    ["1.0", "JPY", "INVALID_AMOUNT_PRECISION"],
    ["90071992547409.92", "HKD", "AMOUNT_OVERFLOW"],
  ]) {
    assert.deepEqual(parseAmount(input, currency), { ok: false, error: { code, field: "amount" } });
  }
  assert.equal(formatAmount({ currency: "USD", amountMinor: Infinity }).error.code, "INVALID_AMOUNT");
});

test("HKD 100 splits into 33.34, 33.33, 33.33 in stable member order", () => {
  const total = valueOf(parseAmount("100", "HKD"));
  const memberIds = ["c", "a", "b"];
  const result = splitEqual(total, memberIds);
  const value = assertShares(result, [3334, 3333, 3333], total);
  assert.deepEqual(value.allocations.map(({ memberId }) => memberId), memberIds);
  assert.deepEqual(value.explanation, { kind: "equal", baseMinor: 3333, extraMinorUnits: 1 });
  assert.deepEqual(splitEqual(total, [...memberIds]), result);
});

test("JPY 100 splits into 34, 33, 33", () => {
  const total = valueOf(parseAmount("100", "JPY"));
  assertShares(splitEqual(total, ["a", "b", "c"]), [34, 33, 33], total);
});

test("a host covering HKD 600 of 1000 leaves four HKD 100 shares by default", () => {
  const value = assertShares(
    splitTreat(bill, group, fixed),
    [60_000, 10_000, 10_000, 10_000, 10_000],
    bill,
  );
  assert.equal(value.explanation.coveredMinor, 60_000);
  assert.equal(value.explanation.includeHostInRemainder, false);
});

test("including the host in the remainder raises their share to HKD 680", () => {
  const options = { ...fixed, includeHostInRemainder: true };
  assertShares(splitTreat(bill, group, options), [68_000, 8000, 8000, 8000, 8000], bill);
});

test("percentage cover rounds half up even at the maximum safe bill", () => {
  const total = { currency: "JPY", amountMinor: Number.MAX_SAFE_INTEGER };
  const options = { hostId: "host", cover: { kind: "percentage", basisPoints: 5000 } };
  const value = assertShares(
    splitTreat(total, ["a", "host"], options),
    [4_503_599_627_370_495, 4_503_599_627_370_496],
    total,
  );
  assert.equal(value.explanation.coveredMinor, 4_503_599_627_370_496);
});

test("treat rejects over-cover or an unallocated remainder and allows a fully covering solo host", () => {
  const options = { ...fixed, cover: { kind: "fixed", amountMinor: bill.amountMinor + 1 } };
  assert.equal(splitTreat(bill, group, options).error.code, "COVER_EXCEEDS_TOTAL");
  assert.equal(splitTreat(bill, ["host"], fixed).error.code, "NO_REMAINDER_PARTICIPANTS");
  const fullCover = { ...fixed, cover: { kind: "percentage", basisPoints: 10_000 } };
  assertShares(splitTreat(bill, ["host"], fullCover), [bill.amountMinor], bill);
});
