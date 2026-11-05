import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createActivityRepository } from "../src/data/activities.ts";
import { DatabaseInitializationError, initializeDatabase } from "../src/data/database.ts";
import { createFinanceRepository } from "../src/data/finance.ts";
import { migrations } from "../src/data/migrations.ts";
import { createQuickSplitRepository } from "../src/data/quickSplits.ts";
import { splitEqual } from "../src/domain/split.ts";

// Exercises the production SQL against a real file with Node's SQLite adapter.
function openTestConnection(path) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  return {
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...params) => db.prepare(sql).run(...params),
    getFirstAsync: async (sql, ...params) => {
      const row = db.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    getAllAsync: async (sql, ...params) => db.prepare(sql).all(...params).map((row) => ({ ...row })),
    close: () => db.close(),
  };
}

function withTestFile(task) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "splitmori-sqlite-"));
    try {
      await task(join(directory, "test.db"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("activity/member writes survive closing and reopening SQLite", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    const database = await initializeDatabase(connection);
    const repository = createActivityRepository(database);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 4);
    assert.equal((await connection.getFirstAsync("PRAGMA journal_mode")).journal_mode, "wal");
    assert.equal((await connection.getFirstAsync("PRAGMA foreign_keys")).foreign_keys, 1);

    await repository.createActivity({
      id: "dinner", name: "Dinner", currency: "HKD",
      members: [{ id: "z", displayName: "Alex" }],
    });
    await Promise.all([
      repository.addMember("dinner", { id: "a", displayName: "Alex" }),
      repository.addMember("dinner", { id: "b", displayName: "Bo" }),
    ]);
    await repository.renameActivity("dinner", "Friday dinner");
    assert.equal((await repository.completeActivity("dinner")).status, "completed");

    await assert.rejects(repository.createActivity({
      id: "failed", name: "Unfinished insert", currency: "HKD",
      members: [{ id: "unlinked", displayName: "Sam" }, { id: "z", displayName: "Alex" }],
    }), /UNIQUE constraint/);
    await assert.rejects(database.write((transaction) => transaction.runAsync(
      "INSERT INTO activity_members (activity_id, member_id, position) VALUES (?, ?, ?)", "dinner", "missing", 3,
    )), /FOREIGN KEY constraint/);
    assert.equal(await connection.getFirstAsync("SELECT id FROM members WHERE id = ?", "unlinked"), null);

    connection.close();
    connection = openTestConnection(path);
    const reopened = createActivityRepository(await initializeDatabase(connection));
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 4);
    assert.deepEqual((await reopened.listActivities()).map(({ id }) => id), ["dinner"]);
    const saved = await reopened.getActivity("dinner");
    assert.equal(saved.name, "Friday dinner");
    assert.equal(saved.currency, "HKD");
    assert.equal(saved.status, "completed");
    assert.deepEqual(saved.members.map(({ id, displayName, position }) => [id, displayName, position]), [
      ["z", "Alex", 0], ["a", "Alex", 1], ["b", "Bo", 2],
    ]);
    assert.deepEqual(await reopened.listMembers("dinner"), saved.members);
    assert.equal((await reopened.reopenActivity("dinner")).status, "active");
  } finally {
    connection.close();
  }
}));

test("failed and unsupported migrations leave existing data intact", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    await connection.execAsync("CREATE TABLE members (sentinel TEXT); INSERT INTO members VALUES ('keep');");
    const isMigrationError = (error) => error instanceof DatabaseInitializationError && error.stage === "migration";
    await assert.rejects(initializeDatabase(connection), isMigrationError);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 0);
    assert.equal(await connection.getFirstAsync("SELECT name FROM sqlite_schema WHERE name = 'activities'"), null);

    await connection.execAsync("PRAGMA user_version = 99");
    await assert.rejects(initializeDatabase(connection), isMigrationError);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 99);
    assert.deepEqual(await connection.getFirstAsync("SELECT sentinel FROM members"), { sentinel: "keep" });
  } finally {
    connection.close();
  }
}));

function valueOf(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function expense(id = "dinner", amountMinor = 10_000) {
  const total = { currency: "HKD", amountMinor };
  const split = valueOf(splitEqual(total, ["z", "a"]));
  return {
    id, split, merchantPayment: { memberId: "z", ...total },
    splitMode: split.explanation.kind, allocationVersion: split.allocationVersion,
  };
}

const refund = {
  id: "refund", expenseId: "dinner", recipientId: "z", currency: "HKD", amountMinor: 2000,
  reductions: [{ memberId: "z", amountMinor: 1000 }, { memberId: "a", amountMinor: 1000 }],
};
const repayment = { id: "repayment", fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 5000 };

function withFinance(task) {
  return withTestFile(async (path) => {
    let connection = openTestConnection(path);
    try {
      const database = await initializeDatabase(connection);
      const activities = createActivityRepository(database);
      await activities.createActivity({
        id: "trip", name: "Trip", currency: "HKD",
        members: [{ id: "z", displayName: "Alex" }, { id: "a", displayName: "Bo" }],
      });
      const reopen = async () => {
        connection.close();
        connection = openTestConnection(path);
        return createFinanceRepository(await initializeDatabase(connection));
      };
      await task(createFinanceRepository(database), activities, database, connection, reopen);
    } finally {
      connection.close();
    }
  });
}

test("forward migrations preserve v1 activities and a saved expense survives reopening", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    await connection.execAsync(migrations[0]);
    await connection.execAsync(`
      INSERT INTO activities VALUES ('trip', 'Trip', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('z', 'Alex', 1), ('a', 'Bo', 1);
      INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1);
      PRAGMA user_version = 1;
    `);
    const finance = createFinanceRepository(await initializeDatabase(connection));
    const original = expense("dinner", 10_001);
    const reversed = { ...original, split: { ...original.split, allocations: [...original.split.allocations].reverse() } };
    const saved = valueOf(await finance.createExpense("trip", 100, reversed));
    assert.deepEqual(saved.expense.split.allocations, [
      { memberId: "z", amountMinor: 5001 }, { memberId: "a", amountMinor: 5000 },
    ]);
    assert.equal((await connection.getFirstAsync("SELECT typeof(amount_minor) AS storageType FROM expenses")).storageType, "integer");

    connection.close();
    connection = openTestConnection(path);
    const reopened = createFinanceRepository(await initializeDatabase(connection));
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 4);
    assert.deepEqual(valueOf(await reopened.listExpenses("trip")), [{ ...saved, currentVersion: 1 }]);
    assert.deepEqual(valueOf(await reopened.getExpense("trip", "dinner")), { ...saved, currentVersion: 1, refunds: [] });
  } finally {
    connection.close();
  }
}));

test("a failure after inserting expense allocations rolls back the whole event", withFinance(async (finance, _activities, database, connection) => {
  await database.write((transaction) => transaction.execAsync(`
    CREATE TRIGGER reject_payment BEFORE INSERT ON merchant_payments
    BEGIN SELECT RAISE(ABORT, 'test payment write failure'); END;
  `));
  assert.deepEqual((await finance.createExpense("trip", 100, expense())).error,
    { code: "FINANCE_STORAGE_ERROR", field: "storage" });
  for (const table of ["financial_events", "expenses", "expense_allocations", "merchant_payments"]) {
    assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
  }
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_payment"));
  valueOf(await finance.createExpense("trip", 100, expense()));
}));

test("refunds and repayments are restored once and affect the reopened ledger", withFinance(async (finance, _activities, _database, _connection, reopen) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  const savedRefund = valueOf(await finance.recordMerchantRefund("trip", 300, refund));
  const reopened = await reopen();
  const detail = valueOf(await reopened.getExpense("trip", "dinner"));
  assert.deepEqual(detail.refunds, [savedRefund]);
  const ledger = valueOf(await reopened.getActivityLedger("trip"));
  assert.deepEqual(ledger.balanceSnapshot.balances.map((balance) => balance.netBalanceMinor), [-1000, 1000]);
  assert.deepEqual(ledger.suggestions, [{ fromMemberId: "z", toMemberId: "a", currency: "HKD", amountMinor: 1000 }]);
  assert.deepEqual(ledger.events.map((event) => event.kind), ["expense", "memberTransfer", "merchantRefund"]);
}));

test("event retries are idempotent and different IDs can represent equal repayments", withFinance(async (finance) => {
  const original = expense();
  const saved = valueOf(await finance.createExpense("trip", 100, original));
  assert.deepEqual(valueOf(await finance.createExpense("trip", 100, original)), saved);
  const partial = { ...repayment, amountMinor: 1000 };
  const [first, retry] = await Promise.all([
    finance.recordMemberTransfer("trip", 200, partial), finance.recordMemberTransfer("trip", 200, partial),
  ]);
  assert.deepEqual(valueOf(first), valueOf(retry));
  assert.deepEqual((await finance.recordMemberTransfer("trip", 200, { ...partial, amountMinor: 999 })).error,
    { code: "EVENT_ID_CONFLICT", field: "eventId" });
  valueOf(await finance.recordMemberTransfer("trip", 200, { ...partial, id: "another" }));
  const savedRefund = valueOf(await finance.recordMerchantRefund("trip", 300, refund));
  assert.deepEqual(valueOf(await finance.recordMerchantRefund("trip", 300, refund)), savedRefund);
  assert.deepEqual((await finance.recordMerchantRefund("trip", 300, { ...refund, id: partial.id })).error,
    { code: "EVENT_ID_CONFLICT", field: "eventId" });
  const events = valueOf(await finance.listEvents("trip"));
  assert.deepEqual(events.map((event) => event.kind === "expense" ? event.expense.id : event.id),
    ["dinner", "repayment", "another", "refund"]);
}));

test("membership and payment constraints are enforced and completed activities accept only repayments", withFinance(async (finance, activities, database) => {
  const original = expense();
  const invalid = { ...original, merchantPayment: { ...original.merchantPayment, memberId: "outsider" } };
  assert.deepEqual((await finance.createExpense("trip", 100, invalid)).error,
    { code: "MEMBER_NOT_PARTICIPATING", field: "merchantPayment" });
  valueOf(await finance.createExpense("trip", 100, original));
  await assert.rejects(database.write((transaction) => transaction.runAsync(`
    UPDATE activities SET currency = 'JPY' WHERE id = 'trip'
  `)), /FOREIGN KEY constraint/);
  await assert.rejects(database.write((transaction) => transaction.runAsync(`
    INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'a', 0)
  `)), /UNIQUE constraint/);
  await activities.completeActivity("trip");
  assert.deepEqual((await finance.createExpense("trip", 200, expense("later"))).error,
    { code: "ACTIVITY_COMPLETED", field: "activityId" });
  assert.deepEqual((await finance.recordMerchantRefund("trip", 300, refund)).error,
    { code: "ACTIVITY_COMPLETED", field: "activityId" });
  valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  valueOf(await finance.createExpense("trip", 100, original));
  await activities.reopenActivity("trip");
  valueOf(await finance.recordMerchantRefund("trip", 300, refund));
}));

test("financial history sorts by occurrence time and then insertion sequence", withFinance(async (finance) => {
  const later = valueOf(await finance.createExpense("trip", 300, expense("later", 3000)));
  const earlier = valueOf(await finance.createExpense("trip", 100, expense()));
  assert.deepEqual((await finance.recordMerchantRefund("trip", 99, refund)).error,
    { code: "EXPENSE_NOT_FOUND", field: "expenseId" });
  const tied = valueOf(await finance.recordMerchantRefund("trip", 100, refund));
  const transfer = valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, amountMinor: 4000 }));
  const ledger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(ledger.events, [earlier, tied, transfer, later]);
  assert.deepEqual(ledger.balanceSnapshot.balances.map((balance) => balance.netBalanceMinor), [1500, -1500]);
}));

function correction(amountMinor, overrides = {}) {
  return {
    expenseId: "dinner", revisionId: "correction-1", expectedVersion: 1, occurredAt: 300,
    proposed: expense("dinner", amountMinor), ...overrides,
  };
}

test("a committed correction preserves earlier repayments and supports a later reverse payment", withFinance(async (finance) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  const originalEvents = valueOf(await finance.listEvents("trip"));
  const request = correction(7000);
  const preview = valueOf(await finance.previewExpenseCorrection("trip", "dinner", request.proposed));
  assert.equal(preview.currentVersion, 1);
  assert.deepEqual(preview.memberChanges.map((change) => change.deltaMinor), [-1500, 1500]);

  const saved = valueOf(await finance.commitExpenseCorrection("trip", request));
  assert.equal(saved.version, 2);
  const ledger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(ledger.events, originalEvents);
  assert.deepEqual(ledger.balanceSnapshot, preview.after);
  assert.deepEqual(ledger.suggestions, [{ fromMemberId: "z", toMemberId: "a", currency: "HKD", amountMinor: 1500 }]);

  const reverse = valueOf(await finance.recordMemberTransfer("trip", 300, {
    id: "reverse", fromMemberId: "z", toMemberId: "a", currency: "HKD", amountMinor: 1500,
  }));
  assert.ok(reverse.sequence > saved.sequence);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).suggestions, []);
}));

test("a valid correction keeps reviewed refunds and permits later refunds on revised shares", withFinance(async (finance, activities) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const originalRefund = valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  await activities.addMember("trip", { id: "c", displayName: "Sam" });
  const proposed = expense("dinner", 8000);
  proposed.split = { ...proposed.split, allocations: [
    { memberId: "z", amountMinor: 3000 }, { memberId: "a", amountMinor: 3000 }, { memberId: "c", amountMinor: 2000 },
  ] };
  const request = correction(8000, { proposed });
  assert.deepEqual((await finance.commitExpenseCorrection("trip", request)).error,
    { code: "REFUND_REVIEW_REQUIRED", field: "reviewedRefundIds" });
  valueOf(await finance.commitExpenseCorrection("trip", { ...request, reviewedRefundIds: [refund.id] }));

  const later = valueOf(await finance.recordMerchantRefund("trip", 400, {
    ...refund, id: "later-refund", recipientId: "c", amountMinor: 500, reductions: [{ memberId: "c", amountMinor: 500 }],
  }));
  const detail = valueOf(await finance.getExpense("trip", "dinner"));
  assert.deepEqual(detail.refunds, [originalRefund, later]);
  assert.equal(detail.currentVersion, 2);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).balanceSnapshot.effectiveExpenses,
    [{ expenseId: "dinner", effectiveTotalMinor: 5500 }]);
}));

test("correction commit revalidates new refunds and rolls back a failed allocation insert", withFinance(async (finance, _activities, database, connection) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const tooSmall = correction(1500);
  valueOf(await finance.previewExpenseCorrection("trip", "dinner", tooSmall.proposed));
  valueOf(await finance.recordMerchantRefund("trip", 200, refund));
  const originalLedger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual((await finance.commitExpenseCorrection("trip", tooSmall)).error,
    { code: "REFUND_EXCEEDS_EXPENSE", field: "merchantRefund" });
  assert.deepEqual((await finance.commitExpenseCorrection("trip", correction(1500, {
    proposed: { ...expense(), split: { ...expense().split, allocations: [
      { memberId: "z", amountMinor: 500 }, { memberId: "a", amountMinor: 9500 },
    ] } },
  }))).error, { code: "REFUND_REDUCTION_EXCEEDS_ALLOCATION", field: "refundReductions" });

  await database.write((transaction) => transaction.execAsync(`
    CREATE TRIGGER reject_revision_allocation BEFORE INSERT ON expense_revision_allocations WHEN NEW.position = 1
    BEGIN SELECT RAISE(ABORT, 'test revision failure'); END;
  `));
  const valid = correction(8000, { reviewedRefundIds: [refund.id] });
  assert.deepEqual((await finance.commitExpenseCorrection("trip", valid)).error,
    { code: "FINANCE_STORAGE_ERROR", field: "storage" });
  for (const table of ["expense_revisions", "expense_revision_allocations"]) {
    assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
  }
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), originalLedger);
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_revision_allocation"));
  assert.equal(valueOf(await finance.commitExpenseCorrection("trip", valid)).version, 2);
}));

test("revision IDs are idempotent, conflicts are explicit and stale versions cannot overwrite", withFinance(async (finance) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const first = correction(8000);
  const saved = valueOf(await finance.commitExpenseCorrection("trip", first));
  assert.deepEqual(valueOf(await finance.commitExpenseCorrection("trip", first)), saved);
  assert.deepEqual((await finance.commitExpenseCorrection("trip", correction(8100))).error,
    { code: "REVISION_ID_CONFLICT", field: "revisionId" });
  assert.deepEqual((await finance.commitExpenseCorrection("trip", correction(8100, { revisionId: "stale" }))).error,
    { code: "EXPENSE_VERSION_CONFLICT", field: "expectedVersion" });
  valueOf(await finance.commitExpenseCorrection("trip", correction(9000, { revisionId: "newer", expectedVersion: 2 })));
  assert.deepEqual(valueOf(await finance.commitExpenseCorrection("trip", first)), saved);
  assert.deepEqual(valueOf(await finance.listExpenseRevisions("trip", "dinner")).map(({ version }) => version), [1, 2, 3]);
}));

test("v2 expenses form version one and corrected history survives reopening SQLite", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    await connection.execAsync(migrations[0]);
    await connection.execAsync(migrations[1]);
    await connection.execAsync(`
      INSERT INTO activities VALUES ('trip', 'Trip', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('z', 'Alex', 1), ('a', 'Bo', 1);
      INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1);
      INSERT INTO financial_events VALUES (1, 'dinner', 'trip', 'expense', 100),
        (2, 'repayment', 'trip', 'memberTransfer', 150), (3, 'refund', 'trip', 'merchantRefund', 200);
      INSERT INTO expenses VALUES ('dinner', 'trip', 'HKD', 10000, 'equal', 1);
      INSERT INTO expense_allocations VALUES ('trip', 'dinner', 'z', 5000, 0), ('trip', 'dinner', 'a', 5000, 1);
      INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'z', 10000);
      INSERT INTO member_transfers VALUES ('repayment', 'trip', 'a', 'z', 5000);
      INSERT INTO merchant_refunds VALUES ('refund', 'trip', 'dinner', 'z', 2000);
      INSERT INTO refund_reductions VALUES ('trip', 'dinner', 'refund', 'z', 1000), ('trip', 'dinner', 'refund', 'a', 1000);
      PRAGMA user_version = 2;
    `);
    const finance = createFinanceRepository(await initializeDatabase(connection));
    const [baseline] = valueOf(await finance.listExpenseRevisions("trip", "dinner"));
    assert.equal(baseline.version, 1);
    assert.equal(baseline.expense.merchantPayment.amountMinor, 10_000);
    const revised = valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));

    connection.close();
    connection = openTestConnection(path);
    const reopened = createFinanceRepository(await initializeDatabase(connection));
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 4);
    assert.deepEqual(valueOf(await reopened.listExpenseRevisions("trip", "dinner")), [baseline, revised]);
    const ledger = valueOf(await reopened.getActivityLedger("trip"));
    assert.deepEqual(ledger.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [-2000, 2000]);
    assert.deepEqual(ledger.suggestions, [{ fromMemberId: "z", toMemberId: "a", currency: "HKD", amountMinor: 2000 }]);
  } finally {
    connection.close();
  }
}));

test("corrections require an open activity, an append time and a balanced replacement", withFinance(async (finance, activities) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  await activities.completeActivity("trip");
  assert.deepEqual((await finance.commitExpenseCorrection("trip", correction(7000))).error,
    { code: "ACTIVITY_COMPLETED", field: "activityId" });
  await activities.reopenActivity("trip");
  assert.deepEqual((await finance.commitExpenseCorrection("trip", correction(7000, { occurredAt: 99 }))).error,
    { code: "REVISION_OUT_OF_ORDER", field: "occurredAt" });
  const proposed = { ...expense("dinner", 7000), merchantPayment: expense().merchantPayment };
  assert.deepEqual((await finance.commitExpenseCorrection("trip", correction(7000, { proposed }))).error,
    { code: "TOTAL_MISMATCH", field: "merchantPayment" });
  assert.equal(valueOf(await finance.getExpense("trip", "dinner")).currentVersion, 1);
}));

function quickInput() {
  return {
    members: [{ id: "z", displayName: "Alex" }, { id: "a", displayName: "Bo" }],
    charges: { kind: "finalTotal", total: { currency: "HKD", amountMinor: 10_001 } },
    method: { kind: "equal", memberIds: ["z", "a"] },
  };
}

test("one quick draft preserves incomplete input and rejects a stale replacement", withFinance(async (_finance, _activities, database, connection) => {
  const quick = createQuickSplitRepository(database);
  assert.equal(valueOf(await quick.getQuickDraft()), null);
  const partial = { currency: "HKD", mode: "treat", members: [{ id: "z" }], parameters: { total: "12.", cover: "" } };
  const first = valueOf(await quick.saveQuickDraft("draft-1", partial, 100));
  assert.deepEqual(first.input, partial);
  assert.deepEqual(valueOf(await quick.saveQuickDraft("draft-1", partial, 100)), first);
  assert.deepEqual((await quick.saveQuickDraft("draft-1", {}, 100)).error,
    { code: "QUICK_RECORD_ID_CONFLICT", field: "quickRecordId" });

  const second = valueOf(await quick.saveQuickDraft("draft-2", { mode: "equal" }, 200));
  assert.equal(second.createdAt, 100);
  assert.equal(second.updatedAt, 200);
  assert.deepEqual((await quick.saveQuickDraft("draft-1", partial, 100)).error,
    { code: "STALE_QUICK_DRAFT", field: "occurredAt" });
  assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS count FROM quick_draft")).count, 1);
  assert.deepEqual(valueOf(await quick.getQuickDraft()), second);
  assert.equal(valueOf(await quick.clearQuickDraft()), true);
  assert.equal(valueOf(await quick.getQuickDraft()), null);
}));

test("v4 quick snapshots retain members, rounding and draft inputs after reopening", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    for (const sql of migrations.slice(0, 3)) await connection.execAsync(sql);
    await connection.execAsync("PRAGMA user_version = 3");
    const quick = createQuickSplitRepository(await initializeDatabase(connection));
    const input = quickInput();
    const saved = valueOf(await quick.saveQuickHistory("history", input));
    const draft = valueOf(await quick.saveQuickDraft("draft", { parameters: { total: "-" } }, 100));
    input.members[0].displayName = "Renamed";

    connection.close();
    connection = openTestConnection(path);
    const reopened = createQuickSplitRepository(await initializeDatabase(connection));
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 4);
    assert.deepEqual(valueOf(await reopened.getQuickDraft()), draft);
    assert.deepEqual(valueOf(await reopened.getQuickHistory("history")), saved);
    assert.equal(saved.input.members[0].displayName, "Alex");
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.snapshot.split.allocationVersion, 1);
    assert.deepEqual(saved.snapshot.split.allocations, [
      { memberId: "z", amountMinor: 5001 }, { memberId: "a", amountMinor: 5000 },
    ]);
    assert.deepEqual(saved.snapshot.suggestions, []);
  } finally {
    connection.close();
  }
}));

test("manual quick history keeps more than 100 records independently of the draft", withFinance(async (_finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  const input = quickInput();
  for (let i = 0; i < 101; i += 1) valueOf(await quick.saveQuickHistory(`history-${i}`, input));
  valueOf(await quick.saveQuickDraft("draft-1", {}, 100));
  valueOf(await quick.saveQuickDraft("draft-2", { mode: "equal" }, 200));
  valueOf(await quick.clearQuickDraft());
  assert.equal(valueOf(await quick.listQuickHistory()).length, 101);
  assert.ok(valueOf(await quick.getQuickHistory("history-0")));
  assert.equal(valueOf(await quick.deleteQuickHistory("history-50")), true);
  assert.equal(valueOf(await quick.listQuickHistory()).length, 100);
  assert.equal(valueOf(await quick.getQuickHistory("history-50")), null);
}));

test("manual quick history IDs are idempotent and conflicting content is rejected", withFinance(async (_finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  const input = quickInput();
  const [first, retry] = await Promise.all([
    quick.saveQuickHistory("same", input),
    quick.saveQuickHistory("same", { method: input.method, charges: input.charges, members: input.members }),
  ]);
  assert.deepEqual(valueOf(first), valueOf(retry));
  assert.deepEqual((await quick.saveQuickHistory("same", { ...input, merchantPayerId: "z" })).error,
    { code: "QUICK_RECORD_ID_CONFLICT", field: "quickRecordId" });
  valueOf(await quick.saveQuickHistory("different", input));
  assert.equal(valueOf(await quick.listQuickHistory()).length, 2);
}));

test("manual history uses the split engine and rejects nonconserving or invalid inputs", withFinance(async (_finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  const input = quickInput();
  const details = {
    ...input, charges: { kind: "details", subtotal: { currency: "HKD", amountMinor: 10_000 }, discountMinor: 1000 },
    method: { kind: "individual", personalSpending: [{ memberId: "z", personalMinor: 8000 }, { memberId: "a", personalMinor: 2000 }],
      shared: { amountMinor: 0, memberIds: [] } },
  };
  const valid = valueOf(await quick.saveQuickHistory("details", details));
  assert.equal(valid.snapshot.split.total.amountMinor, 9000);
  assert.deepEqual(valid.snapshot.split.allocations.map(({ amountMinor }) => amountMinor), [7200, 1800]);

  const badFixed = { kind: "custom", options: { kind: "fixed", members: [{ memberId: "z", amountMinor: 10_000 }] } };
  assert.deepEqual((await quick.saveQuickHistory("invalid", { ...input, method: badFixed })).error,
    { code: "TOTAL_MISMATCH", field: "allocations" });
  assert.deepEqual((await quick.saveQuickHistory("outside", { ...input, merchantPayerId: "unknown" })).error,
    { code: "MEMBER_NOT_PARTICIPATING", field: "merchantPayment" });
  assert.equal(valueOf(await quick.listQuickHistory()).length, 1);
}));

test("quick history with a payer creates suggestions without writing to the activity ledger", withFinance(async (finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const saved = valueOf(await quick.saveQuickHistory("dinner", { ...quickInput(), merchantPayerId: "z" }));
  assert.deepEqual(saved.snapshot.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 5000 }]);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  valueOf(await quick.deleteQuickHistory("dinner"));
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
}));
