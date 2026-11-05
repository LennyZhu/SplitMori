import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalances } from "../src/domain/balance.ts";
import { allocateCharges, calculateCharges } from "../src/domain/charges.ts";
import { previewExpenseCorrection } from "../src/domain/correction.ts";
import { formatAmount, parseAmount } from "../src/domain/money.ts";
import { suggestTransfers } from "../src/domain/settlement.ts";
import { splitCustom, splitEqual, splitIndividual, splitTreat } from "../src/domain/split.ts";

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

test("individual spending adds each member's share of the HKD common expense", () => {
  const total = valueOf(parseAmount("700", "HKD"));
  const spending = [
    { memberId: "a", personalMinor: 20_000 },
    { memberId: "b", personalMinor: 12_000 },
    { memberId: "c", personalMinor: 8_000 },
  ];
  const shared = { amountMinor: 30_000, memberIds: ["a", "b", "c"] };
  const value = assertShares(splitIndividual(total, spending, shared), [30_000, 22_000, 18_000], total);
  assert.deepEqual(value.allocations, [
    { memberId: "a", personalMinor: 20_000, sharedMinor: 10_000, amountMinor: 30_000 },
    { memberId: "b", personalMinor: 12_000, sharedMinor: 10_000, amountMinor: 22_000 },
    { memberId: "c", personalMinor: 8_000, sharedMinor: 10_000, amountMinor: 18_000 },
  ]);
});

test("the JPY common expense is split among selected members in snapshot order", () => {
  const total = { currency: "JPY", amountMinor: 35 };
  const spending = [
    { memberId: "c", personalMinor: 10 },
    { memberId: "a", personalMinor: 20 },
    { memberId: "b", personalMinor: 0 },
  ];
  const shared = { amountMinor: 5, memberIds: ["b", "c"] };
  const result = splitIndividual(total, spending, shared);
  const value = assertShares(result, [13, 20, 2], total);
  assert.deepEqual(value.allocations.map(({ sharedMinor }) => sharedMinor), [3, 0, 2]);
  assert.deepEqual(value.explanation, {
    kind: "individual",
    sharedTotalMinor: 5,
    sharedMemberIds: ["c", "b"],
    sharedSplit: { baseMinor: 2, extraMinorUnits: 1 },
  });
  assert.deepEqual(splitIndividual(total, spending, { ...shared, memberIds: ["c", "b"] }), result);
});

test("personal spending can cover the whole bill with no common expense", () => {
  const total = { currency: "USD", amountMinor: 1275 };
  const spending = [{ memberId: "a", personalMinor: 1275 }];
  const value = assertShares(splitIndividual(total, spending, { amountMinor: 0, memberIds: [] }), [1275], total);
  assert.equal(value.allocations[0].sharedMinor, 0);
});

test("individual splitting rejects invalid amounts, cumulative overflow and a mismatched bill", () => {
  const total = { currency: "JPY", amountMinor: 20 };
  const spending = [{ memberId: "a", personalMinor: 10 }];
  const shared = { amountMinor: 1, memberIds: ["a"] };
  assert.deepEqual(splitIndividual(total, spending, shared).error, { code: "TOTAL_MISMATCH", field: "total" });
  assert.deepEqual(splitIndividual(total, spending, { ...shared, amountMinor: 1.5 }).error, {
    code: "INVALID_AMOUNT", field: "sharedAmount",
  });
  assert.deepEqual(splitIndividual(total, [{ memberId: "a", personalMinor: -1 }], shared).error, {
    code: "NEGATIVE_AMOUNT", field: "personalSpending",
  });
  const max = { ...total, amountMinor: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(splitIndividual(max, [{ memberId: "a", personalMinor: max.amountMinor }], shared).error, {
    code: "AMOUNT_OVERFLOW", field: "total",
  });
});

test("individual splitting rejects missing, duplicate and unknown members for the common expense", () => {
  const total = { currency: "HKD", amountMinor: 20 };
  const spending = [{ memberId: "a", personalMinor: 10 }];
  for (const [memberIds, code] of [
    [[], "NO_PARTICIPANTS"],
    [["a", "a"], "DUPLICATE_MEMBER_ID"],
    [["b"], "MEMBER_NOT_PARTICIPATING"],
  ]) {
    const result = splitIndividual(total, spending, { amountMinor: 10, memberIds });
    assert.deepEqual(result.error, { code, field: "sharedMemberIds" });
  }
  assert.deepEqual(splitIndividual(total, [...spending, ...spending], { amountMinor: 0, memberIds: [] }).error, {
    code: "DUPLICATE_MEMBER_ID", field: "memberIds",
  });
});

test("one merchant payer fronts the full HKD bill and receives the other members' shares", () => {
  const memberIds = ["a", "b", "c", "d", "e"];
  const total = valueOf(parseAmount("1000", "HKD"));
  const expense = {
    id: "dinner",
    split: valueOf(splitEqual(total, memberIds)),
    merchantPayment: { memberId: "a", ...total },
  };
  const result = valueOf(calculateBalances("HKD", memberIds, [expense]));
  assert.deepEqual(result, {
    currency: "HKD",
    balances: [
      { memberId: "a", merchantPaidMinor: 100_000, allocatedMinor: 20_000, netBalanceMinor: 80_000 },
      ...memberIds.slice(1).map((memberId) => ({
        memberId, merchantPaidMinor: 0, allocatedMinor: 20_000, netBalanceMinor: -20_000,
      })),
    ],
  });
});

test("different members can front different expenses and the activity stays zero-sum", () => {
  const dinner = { currency: "HKD", amountMinor: 10_000 };
  const drinks = { currency: "HKD", amountMinor: 6000 };
  const expenses = [
    {
      id: "dinner",
      split: valueOf(splitEqual(dinner, ["a", "b"])),
      merchantPayment: { memberId: "c", ...dinner },
    },
    {
      id: "drinks",
      split: valueOf(splitIndividual(drinks, [
        { memberId: "b", personalMinor: 4000 },
        { memberId: "c", personalMinor: 2000 },
      ], { amountMinor: 0, memberIds: [] })),
      merchantPayment: { memberId: "a", ...drinks },
    },
  ];
  const { balances } = valueOf(calculateBalances("HKD", ["a", "b", "c", "d"], expenses));
  assert.deepEqual(balances, [
    { memberId: "a", merchantPaidMinor: 6000, allocatedMinor: 5000, netBalanceMinor: 1000 },
    { memberId: "b", merchantPaidMinor: 0, allocatedMinor: 9000, netBalanceMinor: -9000 },
    { memberId: "c", merchantPaidMinor: 10_000, allocatedMinor: 2000, netBalanceMinor: 8000 },
    { memberId: "d", merchantPaidMinor: 0, allocatedMinor: 0, netBalanceMinor: 0 },
  ]);
  assert.equal(balances.reduce((sum, { netBalanceMinor }) => sum + netBalanceMinor, 0), 0);
});

test("formal expenses reject missing, mismatched and invalid merchant payments", () => {
  const total = { currency: "HKD", amountMinor: 100 };
  const split = valueOf(splitEqual(total, ["a"]));
  const payment = { memberId: "a", ...total };
  for (const [merchantPayment, code] of [
    [undefined, "MISSING_MERCHANT_PAYMENT"],
    [{ ...payment, amountMinor: 99 }, "TOTAL_MISMATCH"],
    [{ ...payment, amountMinor: -1 }, "NEGATIVE_AMOUNT"],
    [{ ...payment, memberId: "outsider" }, "MEMBER_NOT_PARTICIPATING"],
    [{ ...payment, currency: "JPY" }, "CURRENCY_MISMATCH"],
  ]) {
    const result = calculateBalances("HKD", ["a"], [{ id: "dinner", split, merchantPayment }]);
    assert.deepEqual(result.error, { code, field: "merchantPayment" });
  }
});

test("activities reject invalid IDs, repeated expenses, mixed currencies and invalid allocations", () => {
  const total = { currency: "HKD", amountMinor: 100 };
  const split = valueOf(splitEqual(total, ["a"]));
  const expense = { id: "dinner", split, merchantPayment: { memberId: "a", ...total } };
  const yen = { currency: "JPY", amountMinor: 100 };
  const yenExpense = {
    id: "other",
    split: valueOf(splitEqual(yen, ["a"])),
    merchantPayment: { memberId: "a", ...yen },
  };
  for (const [memberIds, expenses, code, field] of [
    [["a", " "], [], "INVALID_MEMBER_ID", "memberIds"],
    [["a", "a"], [], "DUPLICATE_MEMBER_ID", "memberIds"],
    [["a"], [{ ...expense, id: " " }], "INVALID_EXPENSE_ID", "expenseId"],
    [["a"], [expense, expense], "DUPLICATE_EXPENSE_ID", "expenseId"],
    [["a"], [expense, yenExpense], "CURRENCY_MISMATCH", "currency"],
  ]) {
    const result = calculateBalances("HKD", memberIds, expenses);
    assert.deepEqual(result.error, { code, field });
  }
  for (const [allocations, code] of [
    [[{ memberId: "a", amountMinor: 99 }], "TOTAL_MISMATCH"],
    [[{ memberId: "b", amountMinor: 100 }], "MEMBER_NOT_PARTICIPATING"],
    [[{ memberId: "a", amountMinor: 50 }, { memberId: "a", amountMinor: 50 }], "DUPLICATE_MEMBER_ID"],
  ]) {
    const result = calculateBalances("HKD", ["a"], [{ ...expense, split: { ...split, allocations } }]);
    assert.deepEqual(result.error, { code, field: "allocations" });
  }
});

test("activity totals stay exact up to the safe integer limit and reject cumulative overflow", () => {
  const total = { currency: "JPY", amountMinor: Number.MAX_SAFE_INTEGER };
  const expense = {
    id: "large",
    split: valueOf(splitEqual(total, ["b"])),
    merchantPayment: { memberId: "a", ...total },
  };
  const { balances } = valueOf(calculateBalances("JPY", ["a", "b"], [expense]));
  assert.deepEqual(balances.map(({ netBalanceMinor }) => netBalanceMinor), [total.amountMinor, -total.amountMinor]);

  const extra = { currency: "JPY", amountMinor: 1 };
  const extraExpense = {
    id: "extra",
    split: valueOf(splitEqual(extra, ["a"])),
    merchantPayment: { memberId: "b", ...extra },
  };
  const result = calculateBalances("JPY", ["a", "b"], [expense, extraExpense]);
  assert.deepEqual(result.error, { code: "AMOUNT_OVERFLOW", field: "total" });
});

function repaymentFixture() {
  const memberIds = ["a", "b"];
  const total = { currency: "HKD", amountMinor: 10_000 };
  const expense = {
    id: "dinner",
    split: valueOf(splitEqual(total, memberIds)),
    merchantPayment: { memberId: "a", ...total },
  };
  const refund = {
    kind: "merchantRefund",
    id: "refund-1",
    expenseId: expense.id,
    recipientId: "a",
    currency: "HKD",
    amountMinor: 2000,
    reductions: [{ memberId: "a", amountMinor: 1000 }, { memberId: "b", amountMinor: 1000 }],
  };
  const transfer = {
    kind: "memberTransfer",
    id: "transfer-1",
    fromMemberId: "b",
    toMemberId: "a",
    currency: "HKD",
    amountMinor: 5000,
  };
  return { memberIds, expense, refund, transfer };
}

function assertNetBalances(result, expected) {
  const value = valueOf(result);
  const netAmounts = value.balances.map(({ netBalanceMinor }) => netBalanceMinor);
  assert.deepEqual(netAmounts, expected);
  assert.equal(netAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n), 0n);
  return value;
}

test("a partial merchant refund reduces the effective expense and preserves the original records", () => {
  const { memberIds, expense, refund } = repaymentFixture();
  const inputs = { expenses: [expense], events: [refund] };
  const originalInputs = structuredClone(inputs);
  const value = assertNetBalances(
    calculateBalances("HKD", memberIds, inputs.expenses, inputs.events),
    [4000, -4000],
  );
  assert.deepEqual(value.effectiveExpenses, [{ expenseId: "dinner", effectiveTotalMinor: 8000 }]);
  assert.deepEqual(value.balances.map(({ allocatedMinor }) => allocatedMinor), [4000, 4000]);
  assert.equal(value.balances[0].merchantPaidMinor, 10_000);
  assert.equal(value.balances[0].merchantRefundReceivedMinor, 2000);
  assert.deepEqual(inputs, originalInputs);
});

test("a member who did not pay the merchant can receive the refund", () => {
  const { memberIds, expense, refund } = repaymentFixture();
  const result = calculateBalances("HKD", memberIds, [expense], [{ ...refund, recipientId: "b" }]);
  const value = assertNetBalances(result, [6000, -6000]);
  assert.deepEqual(value.balances.map(({ merchantPaidMinor }) => merchantPaidMinor), [10_000, 0]);
  assert.deepEqual(value.balances.map(({ merchantRefundReceivedMinor }) => merchantRefundReceivedMinor), [0, 2000]);
  assert.deepEqual(value.balances.map(({ allocatedMinor }) => allocatedMinor), [4000, 4000]);
  assert.deepEqual(value.effectiveExpenses, [{ expenseId: "dinner", effectiveTotalMinor: 8000 }]);
});

test("a later refund can reverse settled balances and allow a repayment in the other direction", () => {
  const { memberIds, expense, refund, transfer } = repaymentFixture();
  assertNetBalances(calculateBalances("HKD", memberIds, [expense], [transfer]), [0, 0]);
  const value = assertNetBalances(
    calculateBalances("HKD", memberIds, [expense], [transfer, refund]),
    [-1000, 1000],
  );
  assert.equal(value.balances[1].transferSentMinor, 5000);
  assert.equal(value.balances[0].transferReceivedMinor, 5000);

  const reverse = { ...transfer, id: "transfer-2", fromMemberId: "a", toMemberId: "b", amountMinor: 1000 };
  assertNetBalances(calculateBalances("HKD", memberIds, [expense], [transfer, refund, reverse]), [0, 0]);
});

test("refunds conserve reductions and cap both cumulative refunds and each expense share", () => {
  const { memberIds, expense, refund } = repaymentFixture();
  const larger = {
    ...refund,
    amountMinor: 6000,
    reductions: [{ memberId: "a", amountMinor: 3000 }, { memberId: "b", amountMinor: 3000 }],
  };
  const extra = { ...larger, id: "refund-2" };
  const fullyRefunded = {
    ...refund,
    amountMinor: 10_000,
    reductions: expense.split.allocations,
  };
  const full = assertNetBalances(calculateBalances("HKD", memberIds, [expense], [fullyRefunded]), [0, 0]);
  assert.deepEqual(full.effectiveExpenses, [{ expenseId: "dinner", effectiveTotalMinor: 0 }]);

  for (const [events, code, field] of [
    [[larger, extra], "REFUND_EXCEEDS_EXPENSE", "merchantRefund"],
    [[{ ...refund, amountMinor: 1999 }], "TOTAL_MISMATCH", "refundReductions"],
    [[larger, { ...extra, amountMinor: 2001, reductions: [{ memberId: "a", amountMinor: 2001 }] }],
      "REFUND_REDUCTION_EXCEEDS_ALLOCATION", "refundReductions"],
    [[{ ...refund, amountMinor: 0 }], "NON_POSITIVE_AMOUNT", "merchantRefund"],
  ]) {
    const result = calculateBalances("HKD", memberIds, [expense], events);
    assert.deepEqual(result.error, { code, field });
  }
});

test("refunds reject duplicate event IDs and incorrect expense or member associations", () => {
  const { expense, refund, transfer } = repaymentFixture();
  const otherExpense = {
    ...expense,
    id: "drinks",
    split: valueOf(splitEqual(expense.split.total, ["c"])),
  };
  for (const [events, code, field] of [
    [[refund, refund], "DUPLICATE_EVENT_ID", "eventId"],
    [[refund, { ...transfer, id: refund.id }], "DUPLICATE_EVENT_ID", "eventId"],
    [[{ ...refund, expenseId: "missing" }], "EXPENSE_NOT_FOUND", "expenseId"],
    [[{ ...refund, recipientId: "outsider" }], "MEMBER_NOT_PARTICIPATING", "merchantRefund"],
    [[{ ...refund, reductions: [{ memberId: "c", amountMinor: 2000 }] }],
      "MEMBER_NOT_PARTICIPATING", "refundReductions"],
  ]) {
    const result = calculateBalances("HKD", ["a", "b", "c"], [expense, otherExpense], events);
    assert.deepEqual(result.error, { code, field });
  }
});

test("repayments require valid members and can only reduce the current debt and credit", () => {
  const { memberIds, expense, transfer } = repaymentFixture();
  const partial = { ...transfer, amountMinor: 3000 };
  assertNetBalances(calculateBalances("HKD", memberIds, [expense], [partial]), [2000, -2000]);
  for (const [events, code, field] of [
    [[partial, { ...partial, id: "transfer-2" }], "TRANSFER_EXCEEDS_BALANCE", "memberTransfer"],
    [[{ ...transfer, fromMemberId: "a", toMemberId: "b" }], "TRANSFER_EXCEEDS_BALANCE", "memberTransfer"],
    [[{ ...transfer, fromMemberId: "a" }], "SELF_TRANSFER", "memberTransfer"],
    [[{ ...transfer, toMemberId: "outsider" }], "MEMBER_NOT_PARTICIPATING", "memberTransfer"],
    [[{ ...transfer, amountMinor: 0 }], "NON_POSITIVE_AMOUNT", "memberTransfer"],
    [[{ ...transfer, currency: "JPY" }], "CURRENCY_MISMATCH", "memberTransfer"],
    [[partial, partial], "DUPLICATE_EVENT_ID", "eventId"],
  ]) {
    const result = calculateBalances("HKD", memberIds, [expense], events);
    assert.deepEqual(result.error, { code, field });
  }
});

test("a later expense is applied after an earlier repayment in the supplied sequence", () => {
  const { memberIds, expense, transfer } = repaymentFixture();
  const later = {
    ...expense,
    id: "later",
    merchantPayment: { ...expense.merchantPayment, memberId: "b" },
  };
  assertNetBalances(
    calculateBalances("HKD", memberIds, [expense], [transfer, { kind: "expense", expense: later }]),
    [-5000, 5000],
  );
});

test("one merchant payer receives direct suggestions from every debtor", () => {
  const memberIds = ["e", "b", "a", "d", "c"];
  const total = { currency: "HKD", amountMinor: 100_000 };
  const expense = {
    id: "dinner",
    split: valueOf(splitEqual(total, memberIds)),
    merchantPayment: { memberId: "a", ...total },
  };
  const balances = valueOf(calculateBalances("HKD", [...memberIds, "idle"], [expense]));
  const original = structuredClone(balances);

  assert.deepEqual(valueOf(suggestTransfers(balances)), ["b", "c", "d", "e"].map((fromMemberId) => ({
    fromMemberId,
    toMemberId: "a",
    currency: "HKD",
    amountMinor: 20_000,
  })));
  assert.deepEqual(balances, original);
});

test("multiple debtors and creditors match by remaining balance then stable ID", () => {
  const balances = [
    { memberId: "d2", netBalanceMinor: -9 },
    { memberId: "d1", netBalanceMinor: -9 },
    { memberId: "d3", netBalanceMinor: -4 },
    { memberId: "c2", netBalanceMinor: 7 },
    { memberId: "c1", netBalanceMinor: 7 },
    { memberId: "c3", netBalanceMinor: 5 },
    { memberId: "c4", netBalanceMinor: 3 },
  ];
  const input = { currency: "JPY", balances };
  const suggestions = valueOf(suggestTransfers(input));
  assert.deepEqual(suggestions.map(({ fromMemberId, toMemberId, amountMinor }) => [
    fromMemberId, toMemberId, amountMinor,
  ]), [
    ["d1", "c1", 7],
    ["d2", "c2", 7],
    ["d3", "c3", 4],
    ["d1", "c4", 2],
    ["d2", "c3", 1],
    ["d2", "c4", 1],
  ]);
  assert.deepEqual(valueOf(suggestTransfers({ ...input, balances: [...balances].reverse() })), suggestions);

  const remaining = new Map(balances.map(({ memberId, netBalanceMinor }) => [memberId, netBalanceMinor]));
  for (const { fromMemberId, toMemberId, amountMinor } of suggestions) {
    remaining.set(fromMemberId, remaining.get(fromMemberId) + amountMinor);
    remaining.set(toMemberId, remaining.get(toMemberId) - amountMinor);
  }
  assert.ok([...remaining.values()].every((amount) => amount === 0));
});

test("a fully settled activity returns no suggestions", () => {
  const { memberIds, expense, transfer } = repaymentFixture();
  const balances = valueOf(calculateBalances("HKD", memberIds, [expense], [transfer]));
  assert.deepEqual(valueOf(suggestTransfers(balances)), []);
});

test("a refund after repayment can produce a suggestion in the opposite direction", () => {
  const { memberIds, expense, refund, transfer } = repaymentFixture();
  const balances = valueOf(calculateBalances("HKD", memberIds, [expense], [transfer, refund]));
  assert.deepEqual(valueOf(suggestTransfers(balances)), [
    { fromMemberId: "a", toMemberId: "b", currency: "HKD", amountMinor: 1000 },
  ]);
});

test("settlement rejects invalid balances, duplicate members and conflicting currencies", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const debtor = { memberId: "a", netBalanceMinor: -max };
  const creditor = { memberId: "b", netBalanceMinor: max };
  const input = { currency: "JPY", balances: [debtor, creditor] };
  assert.equal(valueOf(suggestTransfers(input))[0].amountMinor, max);

  for (const [overrides, code, field] of [
    [{ currency: "EUR" }, "UNSUPPORTED_CURRENCY", "currency"],
    [{ balances: [debtor, { ...creditor, currency: "HKD" }] }, "CURRENCY_MISMATCH", "currency"],
    [{ balances: [debtor, { ...creditor, memberId: "a" }] }, "DUPLICATE_MEMBER_ID", "memberIds"],
    [{ balances: [{ ...debtor, netBalanceMinor: -1.5 }, creditor] }, "INVALID_AMOUNT", "netBalanceMinor"],
    [{ balances: [{ ...debtor, netBalanceMinor: Infinity }, creditor] }, "INVALID_AMOUNT", "netBalanceMinor"],
    [{ balances: [{ ...debtor, netBalanceMinor: -(max + 1) }, creditor] }, "AMOUNT_OVERFLOW", "netBalanceMinor"],
    [{ balances: [creditor, { memberId: "c", netBalanceMinor: 2 }, debtor, { memberId: "d", netBalanceMinor: -1 }] },
      "UNBALANCED_NET_BALANCES", "netBalanceMinor"],
  ]) {
    assert.deepEqual(suggestTransfers({ ...input, ...overrides }).error, { code, field });
  }
});

test("a final receipt amount is split as entered without adding a service fee", () => {
  const total = valueOf(parseAmount("1100", "HKD"));
  const calculated = valueOf(calculateCharges({ kind: "finalTotal", total }));
  assert.deepEqual(calculated, { kind: "finalTotal", total });
  assertShares(splitEqual(calculated.total, ["a", "b"]), [55_000, 55_000], total);
});

test("the 10% shortcut defaults to the pre-discount subtotal and rounds half up", () => {
  const details = {
    kind: "details",
    subtotal: { currency: "HKD", amountMinor: 90_000 },
    discountMinor: 5000,
    serviceFee: { kind: "quick10" },
  };
  const before = valueOf(calculateCharges({ ...details, receiptTotal: { currency: "HKD", amountMinor: 94_000 } }));
  assert.equal(before.serviceFeeMinor, 9000);
  assert.equal(before.total.amountMinor, 94_000);

  const after = valueOf(calculateCharges({ ...details, serviceFee: { kind: "quick10", basis: "afterDiscount" } }));
  assert.equal(after.serviceFeeMinor, 8500);
  assert.equal(after.total.amountMinor, 93_500);

  const half = valueOf(calculateCharges({ ...details, subtotal: { currency: "JPY", amountMinor: 5 }, discountMinor: 0 }));
  assert.equal(half.serviceFeeMinor, 1);
});

test("service fees and discounts follow original shares and preserve the final total", () => {
  const subtotal = { currency: "JPY", amountMinor: 10 };
  const base = valueOf(splitIndividual(subtotal, [
    { memberId: "a", personalMinor: 5 },
    { memberId: "b", personalMinor: 3 },
    { memberId: "c", personalMinor: 2 },
  ], { amountMinor: 0, memberIds: [] }));
  const result = allocateCharges(base, {
    kind: "details", subtotal, discountMinor: 4, serviceFee: { kind: "manual", amountMinor: 3 },
  });
  const value = assertShares(result, [4, 3, 2], { currency: "JPY", amountMinor: 9 });
  assert.deepEqual(value.allocations, [
    { memberId: "a", baseMinor: 5, serviceFeeMinor: 1, discountMinor: 2, amountMinor: 4 },
    { memberId: "b", baseMinor: 3, serviceFeeMinor: 1, discountMinor: 1, amountMinor: 3 },
    { memberId: "c", baseMinor: 2, serviceFeeMinor: 1, discountMinor: 1, amountMinor: 2 },
  ]);

  const equalSubtotal = { currency: "JPY", amountMinor: 3 };
  const equal = valueOf(splitEqual(equalSubtotal, ["c", "a", "b"]));
  const equalResult = allocateCharges(equal, {
    kind: "details", subtotal: equalSubtotal, discountMinor: 1, serviceFee: { kind: "manual", amountMinor: 2 },
  });
  const equalValue = assertShares(equalResult, [1, 2, 1], { currency: "JPY", amountMinor: 4 });
  assert.deepEqual(equalValue.allocations.map(({ discountMinor }) => discountMinor), [1, 0, 0]);
  assert.deepEqual(equalValue.allocations.map(({ serviceFeeMinor }) => serviceFeeMinor), [1, 1, 0]);
  assertShares(allocateCharges(equal, { kind: "details", subtotal: equalSubtotal, discountMinor: 3 }),
    [0, 0, 0], { currency: "JPY", amountMinor: 0 });
});

test("custom fixed allocations must match the final bill exactly", () => {
  const total = { currency: "HKD", amountMinor: 5000 };
  const options = { kind: "fixed", members: [
    { memberId: "b", amountMinor: 3000 }, { memberId: "a", amountMinor: 2000 },
  ] };
  const value = assertShares(splitCustom(total, options), [3000, 2000], total);
  assert.deepEqual(value.explanation, { kind: "custom", method: "fixed" });
  assert.deepEqual(splitCustom({ ...total, amountMinor: 5001 }, options).error,
    { code: "TOTAL_MISMATCH", field: "allocations" });
});

test("custom percentages and integer shares distribute remainders in snapshot order", () => {
  const total = { currency: "JPY", amountMinor: 102 };
  const percentage = { kind: "percentage", members: [
    { memberId: "b", basisPoints: 5000 }, { memberId: "c", basisPoints: 2500 }, { memberId: "a", basisPoints: 2500 },
  ] };
  const shares = { kind: "shares", members: [
    { memberId: "b", shares: 2 }, { memberId: "c", shares: 1 }, { memberId: "a", shares: 1 },
  ] };
  for (const options of [percentage, shares]) {
    const value = assertShares(splitCustom(total, options), [51, 26, 25], total);
    assert.deepEqual(value.allocations.map(({ memberId }) => memberId), ["b", "c", "a"]);
  }

  const max = { ...total, amountMinor: Number.MAX_SAFE_INTEGER };
  const largeShares = { kind: "shares", members: [
    { memberId: "b", shares: max.amountMinor }, { memberId: "a", shares: max.amountMinor },
  ] };
  assertShares(splitCustom(max, largeShares), [4_503_599_627_370_496, 4_503_599_627_370_495], max);
});

test("charge calculations reject conflicting fee sources, invalid amounts and receipt mismatches", () => {
  const details = { kind: "details", subtotal: { currency: "HKD", amountMinor: 100 } };
  for (const [overrides, code, field] of [
    [{ discountMinor: 101 }, "DISCOUNT_EXCEEDS_SUBTOTAL", "discount"],
    [{ serviceFee: { kind: "manual", amountMinor: -1 } }, "NEGATIVE_AMOUNT", "serviceFee"],
    [{ serviceFee: { kind: "quick10", amountMinor: 1 } }, "SERVICE_FEE_CONFLICT", "serviceFee"],
    [{ receiptTotal: { currency: "HKD", amountMinor: 99 } }, "TOTAL_MISMATCH", "receiptTotal"],
    [{ receiptTotal: { currency: "JPY", amountMinor: 100 } }, "CURRENCY_MISMATCH", "receiptTotal"],
    [{ subtotal: { currency: "HKD", amountMinor: Number.MAX_SAFE_INTEGER }, serviceFee: { kind: "quick10" } },
      "AMOUNT_OVERFLOW", "total"],
  ]) {
    assert.deepEqual(calculateCharges({ ...details, ...overrides }).error, { code, field });
  }
  const zero = { currency: "HKD", amountMinor: 0 };
  const zeroSplit = valueOf(splitEqual(zero, ["a", "b"]));
  const result = allocateCharges(zeroSplit, {
    ...details, subtotal: zero, serviceFee: { kind: "manual", amountMinor: 1 },
  });
  assert.deepEqual(result.error, { code: "NO_CHARGE_WEIGHTS", field: "charges" });
});

test("custom splits reject invalid amounts, percentages, shares and repeated members", () => {
  const total = { currency: "JPY", amountMinor: 100 };
  for (const [options, code, field] of [
    [{ kind: "percentage", members: [{ memberId: "a", basisPoints: 9999 }] }, "TOTAL_MISMATCH", "basisPoints"],
    [{ kind: "percentage", members: [{ memberId: "a", basisPoints: 9999.5 }] }, "INVALID_PERCENTAGE", "basisPoints"],
    [{ kind: "shares", members: [{ memberId: "a", shares: 0 }] }, "INVALID_SHARE_COUNT", "shares"],
    [{ kind: "shares", members: [{ memberId: "a", shares: 1 }, { memberId: "a", shares: 2 }] },
      "DUPLICATE_MEMBER_ID", "memberIds"],
    [{ kind: "fixed", members: [{ memberId: "a", amountMinor: -1 }] }, "NEGATIVE_AMOUNT", "allocations"],
    [{ kind: "fixed", members: [{ memberId: "a", amountMinor: Number.MAX_SAFE_INTEGER }, { memberId: "b", amountMinor: 1 }] },
      "AMOUNT_OVERFLOW", "allocations"],
  ]) {
    assert.deepEqual(splitCustom(total, options).error, { code, field });
  }
});

test("treat uses the final receipt without applying proportional charges to the host commitment", () => {
  const subtotal = { currency: "HKD", amountMinor: 90_000 };
  const details = { kind: "details", subtotal, serviceFee: { kind: "manual", amountMinor: 10_000 } };
  const base = valueOf(splitTreat(subtotal, group, fixed));
  assert.deepEqual(allocateCharges(base, details).error, { code: "CHARGE_ALLOCATION_UNSUPPORTED", field: "charges" });

  const { total } = valueOf(calculateCharges(details));
  const value = assertShares(splitTreat(total, group, fixed), [60_000, 10_000, 10_000, 10_000, 10_000], total);
  assert.equal(value.explanation.coveredMinor, 60_000);
});

function correctedEqualExpense(expense, amountMinor, memberId = expense.merchantPayment.memberId) {
  const total = { ...expense.split.total, amountMinor };
  const memberIds = expense.split.allocations.map((allocation) => allocation.memberId);
  return {
    ...expense,
    split: valueOf(splitEqual(total, memberIds)),
    merchantPayment: { memberId, ...total },
  };
}

test("reducing a paid-back expense preserves the historical transfer and reverses the suggestion", () => {
  const { memberIds, expense, transfer } = repaymentFixture();
  const proposed = correctedEqualExpense(expense, 7000);
  const preview = valueOf(previewExpenseCorrection({
    currency: "HKD", memberIds, expenses: [expense], events: [transfer], original: expense, proposed,
  }));
  assert.deepEqual(preview.memberChanges, [
    { memberId: "a", beforeNetBalanceMinor: 0, afterNetBalanceMinor: -1500, deltaMinor: -1500 },
    { memberId: "b", beforeNetBalanceMinor: 0, afterNetBalanceMinor: 1500, deltaMinor: 1500 },
  ]);
  assert.deepEqual(preview.after.balances.map(({ transferSentMinor, transferReceivedMinor }) => [
    transferSentMinor, transferReceivedMinor,
  ]), [[0, 5000], [5000, 0]]);
  assert.deepEqual(preview.suggestions, [
    { fromMemberId: "a", toMemberId: "b", currency: "HKD", amountMinor: 1500 },
  ]);
});

test("a corrected expense in the event timeline keeps its refund and repayment effects", () => {
  const { memberIds, expense, refund, transfer } = repaymentFixture();
  const proposed = correctedEqualExpense(expense, 8000);
  const preview = valueOf(previewExpenseCorrection({
    currency: "HKD", memberIds, expenses: [],
    events: [{ kind: "expense", expense }, transfer, refund], original: expense, proposed,
  }));
  assert.deepEqual(preview.expense, { before: expense, after: proposed, refunds: [refund] });
  assert.deepEqual(preview.before.effectiveExpenses, [{ expenseId: expense.id, effectiveTotalMinor: 8000 }]);
  assert.deepEqual(preview.after.effectiveExpenses, [{ expenseId: expense.id, effectiveTotalMinor: 6000 }]);
  assert.deepEqual(preview.after.balances.map(({ allocatedMinor }) => allocatedMinor), [3000, 3000]);
  assert.deepEqual(preview.after.balances.map(({ netBalanceMinor }) => netBalanceMinor), [-2000, 2000]);
});

test("a correction is rejected if preserved refunds exceed the new bill or a member share", () => {
  const { memberIds, expense, refund } = repaymentFixture();
  const secondRefund = { ...refund, id: "refund-2" };
  const input = { currency: "HKD", memberIds, expenses: [expense], events: [refund, secondRefund], original: expense };
  assert.deepEqual(previewExpenseCorrection({ ...input, proposed: correctedEqualExpense(expense, 3000) }).error,
    { code: "REFUND_EXCEEDS_EXPENSE", field: "merchantRefund" });

  const proposed = { ...expense, split: { ...expense.split, allocations: [
    { memberId: "a", amountMinor: 1500 }, { memberId: "b", amountMinor: 8500 },
  ] } };
  assert.deepEqual(previewExpenseCorrection({ ...input, proposed }).error,
    { code: "REFUND_REDUCTION_EXCEEDS_ALLOCATION", field: "refundReductions" });
});

test("correcting the merchant payer keeps a refund recorded for a different member", () => {
  const { expense, refund } = repaymentFixture();
  const receivedByB = { ...refund, recipientId: "b" };
  const preview = valueOf(previewExpenseCorrection({
    currency: "HKD", memberIds: ["a", "b", "c"], expenses: [expense], events: [receivedByB],
    original: expense, proposed: correctedEqualExpense(expense, 8000, "c"),
  }));
  assert.deepEqual(preview.expense.refunds, [receivedByB]);
  assert.deepEqual(preview.after.balances.map(({ merchantRefundReceivedMinor }) => merchantRefundReceivedMinor), [0, 2000, 0]);
  assert.deepEqual(preview.after.balances.map(({ netBalanceMinor }) => netBalanceMinor), [-3000, -5000, 8000]);
  assert.deepEqual(preview.suggestions, [
    { fromMemberId: "b", toMemberId: "c", currency: "HKD", amountMinor: 5000 },
    { fromMemberId: "a", toMemberId: "c", currency: "HKD", amountMinor: 3000 },
  ]);
});

test("correction previews are repeatable and leave all snapshots and events intact", () => {
  const { memberIds, expense, refund, transfer } = repaymentFixture();
  const input = {
    currency: "HKD", memberIds, expenses: [expense], events: [transfer, refund],
    original: structuredClone(expense), proposed: correctedEqualExpense(expense, 8000),
  };
  const originalInput = structuredClone(input);
  const first = valueOf(previewExpenseCorrection(input));
  assert.deepEqual(valueOf(previewExpenseCorrection(input)), first);
  assert.deepEqual(input, originalInput);
});

test("correction checks the source snapshot, stable expense ID and proposed totals", () => {
  const { memberIds, expense } = repaymentFixture();
  const proposed = correctedEqualExpense(expense, 8000);
  const input = { currency: "HKD", memberIds, expenses: [expense], original: expense, proposed };
  for (const [overrides, code, field] of [
    [{ proposed: { ...proposed, id: "different" } }, "EXPENSE_CORRECTION_ID_MISMATCH", "expenseId"],
    [{ original: correctedEqualExpense(expense, 9000) }, "EXPENSE_SNAPSHOT_MISMATCH", "expenseId"],
    [{ proposed: { ...proposed, merchantPayment: expense.merchantPayment } }, "TOTAL_MISMATCH", "merchantPayment"],
    [{ proposed: { ...proposed, split: { ...proposed.split, allocations: expense.split.allocations } } },
      "TOTAL_MISMATCH", "allocations"],
  ]) {
    assert.deepEqual(previewExpenseCorrection({ ...input, ...overrides }).error, { code, field });
  }
});
