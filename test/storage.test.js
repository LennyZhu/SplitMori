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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 2);
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 2);
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

test("migration v2 preserves v1 activities and a saved expense survives reopening", withTestFile(async (path) => {
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 2);
    assert.deepEqual(valueOf(await reopened.listExpenses("trip")), [saved]);
    assert.deepEqual(valueOf(await reopened.getExpense("trip", "dinner")), { ...saved, refunds: [] });
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
