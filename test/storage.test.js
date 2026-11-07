import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ActiveActivityLimitError, createActivityRepository } from "../src/data/activities.ts";
import { backupSnapshotName, DatabaseInitializationError, initializeDatabase } from "../src/data/database.ts";
import { createDatabaseHost, databaseName, restoreFiles } from "../src/data/databaseHost.ts";
import { createFinanceRepository, validateStoredLedgers } from "../src/data/finance.ts";
import { migrations } from "../src/data/migrations.ts";
import { createQuickSplitRepository } from "../src/data/quickSplits.ts";
import { calculateQuickSplit } from "../src/domain/quickSplit.ts";
import { splitEqual } from "../src/domain/split.ts";
import { createBackupService, inspectBackupDatabase, inspectStandaloneBackup } from "../src/services/backup.ts";
import { loadActivityList } from "../src/services/activityList.ts";
import { loadActivityDetail } from "../src/services/activityDetail.ts";
import { createExpenseEditor, expenseDateInput, expenseDateTimestamp, prepareNewExpense } from "../src/services/expenseEditor.ts";
import { createQuickHistorySave } from "../src/services/quickHistorySave.ts";
import { createQuickSplitConversionService } from "../src/services/quickSplitConversion.ts";
import { createRestoreService } from "../src/services/restore.ts";

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
    closeAsync: async () => db.close(),
    async writeSnapshot(directory) {
      const target = join(directory, backupSnapshotName);
      await sqliteBackup(db, target);
      const snapshot = new DatabaseSync(target);
      try {
        assert.equal(snapshot.prepare("PRAGMA journal_mode = DELETE").get().journal_mode, "delete");
      } finally {
        snapshot.close();
      }
    },
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
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
      const database = await initializeDatabase(connection, connection.writeSnapshot);
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
      await task(createFinanceRepository(database), activities, database, connection, reopen, path);
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
    assert.deepEqual(valueOf(await reopened.listExpenses("trip")), [{ ...saved, currentVersion: 1 }]);
    assert.deepEqual(valueOf(await reopened.getExpense("trip", "dinner")), {
      ...saved, currentVersion: 1, refunds: [], refundVoids: [],
    });
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
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

test("quick result save can retry a failed write and coalesces repeated presses", withFinance(async (finance, _activities, database, connection) => {
  const quick = createQuickSplitRepository(database);
  const input = quickInput();
  const snapshot = valueOf(calculateQuickSplit(input));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const attempts = [];
  const save = createQuickHistorySave("result-1", input, (id, value) => {
    attempts.push(id);
    return quick.saveQuickHistory(id, value);
  });

  await connection.execAsync(`
    CREATE TEMP TRIGGER reject_history BEFORE INSERT ON quick_history
    BEGIN SELECT RAISE(ABORT, 'history write failed'); END;
  `);
  assert.deepEqual(await save(), { ok: false, error: { code: "QUICK_STORAGE_ERROR", field: "storage" } });
  assert.deepEqual(valueOf(await quick.listQuickHistory()), []);
  await connection.execAsync("DROP TRIGGER reject_history");

  const [first, repeated] = await Promise.all([save(), save()]);
  const saved = valueOf(first);
  assert.deepEqual(valueOf(repeated), saved);
  assert.deepEqual(valueOf(await save()), saved);
  assert.deepEqual(attempts, ["result-1", "result-1"]);
  assert.deepEqual(saved.input, input);
  assert.deepEqual(saved.snapshot, snapshot);
  assert.deepEqual(valueOf(await quick.listQuickHistory()), [saved]);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
}));

function conversionRequest(overrides = {}) {
  return {
    requestId: "convert-1", historyId: "history", activityId: "trip", occurredAt: 100,
    memberMapping: [{ quickMemberId: "z", activityMemberId: "a" }, { quickMemberId: "a", activityMemberId: "z" }],
    merchantPayment: { memberId: "z", currency: "HKD", amountMinor: 10_001 },
    ...overrides,
  };
}

test("conversion maps saved amounts by ID and keeps the original calculation and history", withFinance(async (finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  const input = quickInput();
  input.members[1].displayName = input.members[0].displayName;
  const history = valueOf(await quick.saveQuickHistory("history", input));
  const service = createQuickSplitConversionService(database);
  const receipt = valueOf(await service.convertQuickHistory(conversionRequest()));

  assert.equal(receipt.event.expense.id, "quick-conversion:convert-1");
  assert.deepEqual(receipt.event.expense.split.allocations, [
    { memberId: "z", amountMinor: 5000 }, { memberId: "a", amountMinor: 5001 },
  ]);
  assert.deepEqual(receipt.source.split, history.snapshot.split);
  assert.deepEqual(receipt.source.input, history.input);
  assert.deepEqual(valueOf(await quick.getQuickHistory("history")), history);
  assert.deepEqual(valueOf(await finance.listEvents("trip")), [receipt.event]);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).suggestions,
    [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 5001 }]);
}));

test("conversion requires explicit actual payment matching the saved total", withFinance(async (finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await quick.saveQuickHistory("history", { ...quickInput(), merchantPayerId: "a" }));
  const service = createQuickSplitConversionService(database);
  assert.deepEqual((await service.convertQuickHistory(conversionRequest({ merchantPayment: undefined }))).error,
    { code: "MISSING_MERCHANT_PAYMENT", field: "merchantPayment" });
  const request = conversionRequest();
  assert.deepEqual((await service.convertQuickHistory({ ...request, merchantPayment: { ...request.merchantPayment, amountMinor: 10_000 } })).error,
    { code: "TOTAL_MISMATCH", field: "merchantPayment" });
  assert.deepEqual(valueOf(await finance.listEvents("trip")), []);
}));

test("conversion rejects incomplete or merged mappings, wrong currency and completed activities", withFinance(async (finance, activities, database) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await quick.saveQuickHistory("history", quickInput()));
  const service = createQuickSplitConversionService(database);
  for (const memberMapping of [
    [{ quickMemberId: "a", activityMemberId: "z" }],
    [{ quickMemberId: "a", activityMemberId: "z" }, { quickMemberId: "z", activityMemberId: "z" }],
    [{ quickMemberId: "a", activityMemberId: "z" }, { quickMemberId: "z", activityMemberId: "missing" }],
  ]) {
    assert.deepEqual((await service.convertQuickHistory(conversionRequest({ memberMapping }))).error,
      { code: "INVALID_MEMBER_MAPPING", field: "memberMapping" });
  }
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "yen", name: "Yen trip", currency: "JPY", members: [{ id: "j", displayName: "Jo" }] });
  assert.deepEqual((await service.convertQuickHistory(conversionRequest({ activityId: "yen" }))).error,
    { code: "CURRENCY_MISMATCH", field: "currency" });
  assert.deepEqual((await service.convertQuickHistory(conversionRequest())).error,
    { code: "ACTIVITY_COMPLETED", field: "activityId" });
  assert.deepEqual(valueOf(await finance.listEvents("trip")), []);
  assert.deepEqual(valueOf(await finance.listEvents("yen")), []);
}));

test("conversion retries remain idempotent after deleting history and never double-post", withFinance(async (finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await quick.saveQuickHistory("history", quickInput()));
  const service = createQuickSplitConversionService(database);
  const request = conversionRequest();
  const [first, retry] = await Promise.all([
    service.convertQuickHistory(request),
    service.convertQuickHistory({ ...request, memberMapping: [...request.memberMapping].reverse() }),
  ]);
  const receipt = valueOf(first);
  assert.deepEqual(valueOf(retry), receipt);
  assert.deepEqual((await service.convertQuickHistory({ ...request, occurredAt: 101 })).error,
    { code: "CONVERSION_REQUEST_CONFLICT", field: "conversionRequestId" });
  assert.equal(valueOf(await quick.deleteQuickHistory("history")), true);
  assert.equal(valueOf(await quick.getQuickHistory("history")), null);
  assert.deepEqual(valueOf(await service.convertQuickHistory(request)), receipt);
  assert.deepEqual((await service.convertQuickHistory({ ...request, requestId: "other" })).error,
    { code: "QUICK_HISTORY_ALREADY_CONVERTED", field: "quickRecordId" });
  assert.deepEqual(valueOf(await finance.listEvents("trip")), [receipt.event]);
}));

test("conversion receipt failure rolls back the event, expense, allocations and payment", withFinance(async (finance, _activities, database, connection) => {
  const quick = createQuickSplitRepository(database);
  const history = valueOf(await quick.saveQuickHistory("history", quickInput()));
  const service = createQuickSplitConversionService(database);
  await database.write((transaction) => transaction.execAsync(`
    CREATE TRIGGER reject_conversion_receipt BEFORE INSERT ON quick_split_conversions
    BEGIN SELECT RAISE(ABORT, 'test conversion receipt failure'); END;
  `));
  const request = conversionRequest();
  assert.deepEqual((await service.convertQuickHistory(request)).error,
    { code: "QUICK_CONVERSION_STORAGE_ERROR", field: "storage" });
  for (const table of ["financial_events", "expenses", "expense_allocations", "merchant_payments", "quick_split_conversions"]) {
    assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
  }
  assert.deepEqual(valueOf(await quick.getQuickHistory("history")), history);
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_conversion_receipt"));
  const saved = valueOf(await service.convertQuickHistory(request));
  assert.deepEqual(valueOf(await finance.listEvents("trip")), [saved.event]);
}));

test("conversion rejects a missing or nonconserving saved snapshot", withFinance(async (finance, _activities, database) => {
  const service = createQuickSplitConversionService(database);
  assert.deepEqual((await service.convertQuickHistory(conversionRequest())).error,
    { code: "QUICK_HISTORY_NOT_FOUND", field: "quickRecordId" });
  const quick = createQuickSplitRepository(database);
  const history = valueOf(await quick.saveQuickHistory("history", quickInput()));
  const broken = structuredClone(history.snapshot);
  broken.split.allocations[0].amountMinor -= 1;
  await database.write((transaction) => transaction.runAsync(
    "UPDATE quick_history SET result_json = ? WHERE id = ?", JSON.stringify(broken), history.id,
  ));
  assert.deepEqual((await service.convertQuickHistory(conversionRequest())).error,
    { code: "TOTAL_MISMATCH", field: "allocations" });
  assert.deepEqual(valueOf(await finance.listEvents("trip")), []);
}));

test("voiding a repayment restores the debt and allows a corrected payment on a completed activity", withFinance(async (finance, activities) => {
  const original = valueOf(await finance.createExpense("trip", 100, expense()));
  const paid = valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  await activities.completeActivity("trip");
  const reversal = valueOf(await finance.voidMemberTransfer("trip", {
    id: "void-repayment", targetEventId: paid.id, occurredAt: 300, reason: "Incorrect amount",
  }));
  const restored = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(restored.events, [original, paid, reversal]);
  assert.deepEqual(restored.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [5000, -5000]);
  assert.deepEqual(restored.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 5000 }]);
  const corrected = valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, id: "corrected", amountMinor: 4000 }));
  assert.ok(corrected.sequence > reversal.sequence);
  assert.equal((await activities.getActivity("trip")).status, "completed");
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).suggestions,
    [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 1000 }]);
}));

test("voiding a refund restores revised shares and preserves repayments legal at the time", withFinance(async (finance, activities) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const savedRefund = valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 6000 }));
  valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));
  const request = { id: "void-refund", targetEventId: refund.id, occurredAt: 400 };
  await activities.completeActivity("trip");
  assert.deepEqual((await finance.voidMerchantRefund("trip", request)).error, { code: "ACTIVITY_COMPLETED", field: "activityId" });
  await activities.reopenActivity("trip");
  const reversal = valueOf(await finance.voidMerchantRefund("trip", request));

  const ledger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(ledger.balanceSnapshot.effectiveExpenses, [{ expenseId: "dinner", effectiveTotalMinor: 8000 }]);
  assert.deepEqual(ledger.balanceSnapshot.balances.map(({ allocatedMinor, netBalanceMinor, transferSentMinor }) => [
    allocatedMinor, netBalanceMinor, transferSentMinor,
  ]), [[4000, -2000, 0], [4000, 2000, 6000]]);
  assert.deepEqual(ledger.suggestions, [{ fromMemberId: "z", toMemberId: "a", currency: "HKD", amountMinor: 2000 }]);
  const detail = valueOf(await finance.getExpense("trip", "dinner"));
  assert.deepEqual(detail.refunds, [savedRefund]);
  assert.deepEqual(detail.refundVoids, [reversal]);
  const next = correction(1000, { revisionId: "after-void", expectedVersion: 2, occurredAt: 500 });
  const preview = valueOf(await finance.previewExpenseCorrection("trip", "dinner", next.proposed));
  assert.deepEqual(preview.expense.refunds, []);
  valueOf(await finance.commitExpenseCorrection("trip", next));
}));

test("void requests are idempotent and reject duplicate, invalid or backdated targets", withFinance(async (finance, activities) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "other", name: "Other", currency: "HKD", members: [{ id: "c", displayName: "Cy" }] });
  const request = { id: "void-repayment", targetEventId: repayment.id, occurredAt: 200, reason: "Duplicate entry" };
  for (const [result, code, field] of [
    [await finance.voidMerchantRefund("trip", request), "INVALID_VOID_TARGET", "targetEventId"],
    [await finance.voidMemberTransfer("trip", { ...request, targetEventId: "dinner" }), "INVALID_VOID_TARGET", "targetEventId"],
    [await finance.voidMemberTransfer("other", request), "INVALID_VOID_TARGET", "targetEventId"],
    [await finance.voidMemberTransfer("trip", { ...request, id: "dinner" }), "EVENT_ID_CONFLICT", "eventId"],
    [await finance.voidMemberTransfer("trip", { ...request, occurredAt: 199 }), "VOID_OUT_OF_ORDER", "occurredAt"],
  ]) assert.deepEqual(result.error, { code, field });

  const [first, retry] = await Promise.all([finance.voidMemberTransfer("trip", request), finance.voidMemberTransfer("trip", request)]);
  assert.deepEqual(valueOf(first), valueOf(retry));
  assert.deepEqual((await finance.voidMemberTransfer("trip", { ...request, reason: "Different" })).error,
    { code: "EVENT_ID_CONFLICT", field: "eventId" });
  assert.deepEqual((await finance.voidMemberTransfer("trip", { ...request, id: "another-void" })).error,
    { code: "EVENT_ALREADY_VOIDED", field: "targetEventId" });
  assert.equal(valueOf(await finance.listEvents("trip")).filter(({ kind }) => kind === "financialVoid").length, 1);
}));

test("a failed void insert rolls back and leaves the original ledger intact", withFinance(async (finance, _activities, database, connection) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMerchantRefund("trip", 200, refund));
  const before = valueOf(await finance.getActivityLedger("trip"));
  await database.write((transaction) => transaction.execAsync(`
    CREATE TRIGGER reject_void AFTER INSERT ON financial_voids
    BEGIN SELECT RAISE(FAIL, 'test void failure'); END;
  `));
  const request = { id: "void-refund", targetEventId: refund.id, occurredAt: 300 };
  assert.deepEqual((await finance.voidMerchantRefund("trip", request)).error, { code: "FINANCE_STORAGE_ERROR", field: "storage" });
  assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS count FROM financial_voids")).count, 0);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_void"));
  valueOf(await finance.voidMerchantRefund("trip", request));
}));

test("v6 migration and reopening preserve the original event and its void record", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    for (const sql of migrations.slice(0, 5)) await connection.execAsync(sql);
    await connection.execAsync(`
      INSERT INTO activities VALUES ('trip', 'Trip', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('z', 'Alex', 1), ('a', 'Bo', 1);
      INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1);
      INSERT INTO financial_events VALUES (1, 'dinner', 'trip', 'expense', 100), (2, 'repayment', 'trip', 'memberTransfer', 200);
      INSERT INTO expenses VALUES ('dinner', 'trip', 'HKD', 10000, 'equal', 1);
      INSERT INTO expense_allocations VALUES ('trip', 'dinner', 'z', 5000, 0), ('trip', 'dinner', 'a', 5000, 1);
      INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'z', 10000);
      INSERT INTO member_transfers VALUES ('repayment', 'trip', 'a', 'z', 5000);
      PRAGMA user_version = 5;
    `);
    const finance = createFinanceRepository(await initializeDatabase(connection));
    const original = valueOf(await finance.listEvents("trip"));
    const request = { id: "void-repayment", targetEventId: repayment.id, occurredAt: 300, reason: "Incorrect entry" };
    const reversal = valueOf(await finance.voidMemberTransfer("trip", request));
    connection.close();
    connection = openTestConnection(path);
    const reopened = createFinanceRepository(await initializeDatabase(connection));
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
    assert.deepEqual(valueOf(await reopened.listEvents("trip")), [...original, reversal]);
    assert.deepEqual(valueOf(await reopened.voidMemberTransfer("trip", request)), reversal);
    assert.deepEqual(valueOf(await reopened.getActivityLedger("trip")).balanceSnapshot.balances.map(
      ({ netBalanceMinor }) => netBalanceMinor,
    ), [5000, -5000]);
  } finally {
    connection.close();
  }
}));

test("a void that would overflow balances after revisions leaves the ledger unchanged", withFinance(async (finance) => {
  const max = Number.MAX_SAFE_INTEGER;
  const original = expense("dinner", max - 1);
  original.splitMode = "custom";
  original.split = { ...original.split, allocations: [{ memberId: "z", amountMinor: 1 }, { memberId: "a", amountMinor: max - 2 }] };
  original.merchantPayment = { ...original.merchantPayment, memberId: "a" };
  valueOf(await finance.createExpense("trip", 100, original));
  valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, id: "earlier", fromMemberId: "z", toMemberId: "a", amountMinor: 1 }));
  const first = { ...original, split: { ...original.split, allocations: [{ memberId: "a", amountMinor: max - 1 }] },
    merchantPayment: { ...original.merchantPayment, memberId: "z" } };
  valueOf(await finance.commitExpenseCorrection("trip", correction(max - 1, { proposed: first })));
  valueOf(await finance.recordMemberTransfer("trip", 400, { ...repayment, amountMinor: 1 }));
  const second = { ...first, split: { total: { currency: "HKD", amountMinor: max }, allocations: [{ memberId: "a", amountMinor: max }] },
    merchantPayment: { ...first.merchantPayment, amountMinor: max } };
  valueOf(await finance.commitExpenseCorrection("trip", correction(max, {
    proposed: second, revisionId: "correction-2", expectedVersion: 2, occurredAt: 500,
  })));
  const before = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual((await finance.voidMemberTransfer("trip", {
    id: "too-large", targetEventId: repayment.id, occurredAt: 600,
  })).error, { code: "AMOUNT_OVERFLOW", field: "total" });
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
}));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function backupFile(path) {
  return {
    uri: path,
    get exists() { return existsSync(path); },
    get size() { return statSync(path).size; },
    get modificationTime() { return Math.floor(statSync(path).mtimeMs); },
    create: () => writeFileSync(path, "", { flag: "wx" }),
    sha256: async () => sha256(readFileSync(path)),
    open(mode) {
      const fd = openSync(path, mode === "read" ? "r" : "r+");
      return {
        async readBytes(length) {
          const bytes = new Uint8Array(length);
          return bytes.subarray(0, readSync(fd, bytes, 0, length, null));
        },
        async writeBytes(bytes) {
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
        },
        close: () => closeSync(fd),
      };
    },
  };
}

function backupPlatform(path, overrides) {
  return {
    createWorkspace() {
      const directoryUri = mkdtempSync(join(dirname(path), "scratch-"));
      return {
        directoryUri, token: basename(directoryUri),
        file: (name) => backupFile(join(directoryUri, name)),
        remove: () => rmSync(directoryUri, { recursive: true, force: true }),
      };
    },
    file: (uri) => backupFile(uri.startsWith("file:") ? fileURLToPath(uri) : uri),
    openDatabase: async (name, directory) => openTestConnection(directory ? join(directory, name) : name),
    async publish(source, destination = dirname(path)) {
      const target = join(destination, basename(source));
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      return target;
    },
    ...overrides,
  };
}

function backupService(path, overrides) {
  return createBackupService(backupPlatform(path, overrides));
}

function unpackBackup(uri) {
  const bytes = readFileSync(uri);
  const first = bytes.indexOf(10);
  const second = bytes.indexOf(10, first + 1);
  return { manifest: JSON.parse(bytes.subarray(first + 1, second)), payload: bytes.subarray(second + 1) };
}

function writeBackup(uri, manifest, payload) {
  writeFileSync(uri, Buffer.concat([Buffer.from(`SplitMori Backup\n${JSON.stringify(manifest)}\n`), payload]));
}

test("WAL backup preserves every ledger and quick-split record without changing the source", withFinance(async (finance, activities, database, connection, _reopen, path) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await quick.saveQuickDraft("draft", { mode: "equal" }, 50));
  valueOf(await quick.saveQuickHistory("history", quickInput()));
  valueOf(await createQuickSplitConversionService(database).convertQuickHistory(conversionRequest()));
  valueOf(await finance.createExpense("trip", 110, expense()));
  valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 6000 }));
  valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));
  valueOf(await finance.voidMerchantRefund("trip", { id: "void-refund", targetEventId: refund.id, occurredAt: 400 }));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const sourceBytes = readFileSync(path);
  const walBytes = readFileSync(`${path}-wal`);
  assert.ok(walBytes.length > 32);

  const service = backupService(path);
  const { uri, manifest } = valueOf(await service.exportBackup(database, { destinationDirectoryUri: dirname(path) }));
  const exportedBytes = readFileSync(uri);
  assert.match(uri, /\.splitmori-backup$/);
  assert.equal(manifest.schemaVersion, migrations.length);
  const preview = valueOf(await service.previewBackup(uri));
  assert.deepEqual(preview.manifest, manifest);
  assert.ok(preview.fileModifiedAt > 0);
  assert.deepEqual(
    [preview.validationStatus, preview.activityCount, preview.memberCount, preview.expenseCount, preview.financialEventCount,
      preview.repaymentCount, preview.quickHistoryCount],
    ["valid", 1, 2, 2, 6, 1, 1],
  );
  assert.deepEqual(readFileSync(uri), exportedBytes);

  const snapshotPath = join(dirname(path), "exported.sqlite");
  writeFileSync(snapshotPath, unpackBackup(uri).payload);
  const snapshot = openTestConnection(snapshotPath);
  try {
    const tables = await connection.getAllAsync("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
    for (const { name } of tables) {
      assert.deepEqual(await snapshot.getAllAsync(`SELECT * FROM ${name}`), await connection.getAllAsync(`SELECT * FROM ${name}`), name);
    }
  } finally {
    snapshot.close();
  }
  assert.deepEqual(readFileSync(path), sourceBytes);
  assert.deepEqual(readFileSync(`${path}-wal`), walBytes);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  assert.equal((await activities.getActivity("trip")).name, "Trip");
}));

test("backup is serialized between database transactions", withFinance(async (_finance, activities, database, _connection, _reopen, path) => {
  const service = backupService(path);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const first = database.write(async (connection) => {
    await connection.runAsync("UPDATE activities SET name = 'Committed before backup' WHERE id = 'trip'");
    await wait;
  });
  const exporting = service.exportBackup(database);
  const later = activities.renameActivity("trip", "Committed after backup");
  release();
  const [, exported] = await Promise.all([first, exporting, later]);
  const { uri } = valueOf(exported);
  const snapshotPath = join(dirname(path), "ordered.sqlite");
  writeFileSync(snapshotPath, unpackBackup(uri).payload);
  const snapshot = openTestConnection(snapshotPath);
  try {
    assert.equal((await snapshot.getFirstAsync("SELECT name FROM activities")).name, "Committed before backup");
  } finally {
    snapshot.close();
  }
  assert.equal((await activities.getActivity("trip")).name, "Committed after backup");
}));

test("backup validation rejects corrupt and future files and can preview an older schema", withFinance(async (_finance, _activities, database, _connection, _reopen, path) => {
  const service = backupService(path);
  const invalid = join(dirname(path), "invalid.splitmori-backup");
  assert.equal((await service.validateBackup(invalid)).error.code, "BACKUP_FILE_NOT_FOUND");
  writeFileSync(invalid, "not a SplitMori backup");
  assert.equal((await service.validateBackup(invalid)).error.code, "INVALID_BACKUP_FORMAT");

  const { uri } = valueOf(await service.exportBackup(database));
  const { manifest, payload } = unpackBackup(uri);
  writeBackup(invalid, manifest, payload.subarray(0, -1));
  assert.equal((await service.validateBackup(invalid)).error.code, "BACKUP_CHECKSUM_MISMATCH");
  const damaged = Buffer.from(payload);
  damaged[damaged.length - 1] ^= 1;
  writeBackup(invalid, manifest, damaged);
  assert.equal((await service.validateBackup(invalid)).error.code, "BACKUP_CHECKSUM_MISMATCH");
  writeBackup(invalid, { ...manifest, formatVersion: 2 }, payload);
  assert.equal((await service.validateBackup(invalid)).error.code, "UNSUPPORTED_BACKUP_VERSION");
  writeBackup(invalid, { ...manifest, schemaVersion: migrations.length + 1 }, payload);
  assert.equal((await service.validateBackup(invalid)).error.code, "UNSUPPORTED_BACKUP_VERSION");
  damaged.fill(0);
  writeBackup(invalid, { ...manifest, sha256: sha256(damaged) }, damaged);
  assert.equal((await service.validateBackup(invalid)).error.code, "BACKUP_INTEGRITY_FAILED");

  const oldPath = join(dirname(path), "version-one.sqlite");
  const old = openTestConnection(oldPath);
  try {
    await old.execAsync(migrations[0]);
    await old.execAsync("PRAGMA user_version = 1");
  } finally {
    old.close();
  }
  const oldPayload = readFileSync(oldPath);
  writeBackup(invalid, {
    ...manifest, schemaVersion: 1, createdAt: undefined, byteLength: oldPayload.length, sha256: sha256(oldPayload),
  }, oldPayload);
  const preview = valueOf(await service.previewBackup(invalid));
  assert.equal(preview.manifest.schemaVersion, 1);
  assert.equal(preview.manifest.createdAt, null);
  assert.equal(preview.financialEventCount, 0);
}));

test("backup validation checks SQLite schema, foreign keys, and financial totals beyond the checksum", withFinance(async (finance, _activities, database, _connection, _reopen, path) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const service = backupService(path);
  const { uri } = valueOf(await service.exportBackup(database));
  const { manifest, payload } = unpackBackup(uri);
  const altered = join(dirname(path), "altered.sqlite");
  const invalid = join(dirname(path), "altered.splitmori-backup");
  for (const [sql, code] of [
    ["DROP TABLE quick_history", "BACKUP_SCHEMA_MISMATCH"],
    ["UPDATE merchant_payments SET member_id = 'missing'", "BACKUP_FOREIGN_KEYS_FAILED"],
    ["UPDATE expense_allocations SET amount_minor = 4999 WHERE member_id = 'a'", "BACKUP_LEDGER_INVALID"],
    [`PRAGMA user_version = ${migrations.length + 1}`, "UNSUPPORTED_BACKUP_VERSION"],
  ]) {
    writeFileSync(altered, payload);
    const connection = openTestConnection(altered);
    try {
      await connection.execAsync(sql);
    } finally {
      connection.close();
    }
    const newPayload = readFileSync(altered);
    writeBackup(invalid, { ...manifest, byteLength: newPayload.length, sha256: sha256(newPayload) }, newPayload);
    assert.equal((await service.validateBackup(invalid)).error?.code, code);
  }
}));

test("snapshot and publishing failures leave the current ledger usable", withFinance(async (finance, _activities, database, _connection, _reopen, path) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const service = backupService(path);
  assert.equal((await service.exportBackup(database, { destinationDirectoryUri: join(dirname(path), "missing") })).error.code,
    "BACKUP_EXPORT_FAILED");
  assert.equal((await service.exportBackup({
    ...database,
    async backupSnapshot(directory) {
      writeFileSync(join(directory, backupSnapshotName), "partial snapshot");
      throw new Error("Snapshot failed");
    },
  })).error.code, "BACKUP_EXPORT_FAILED");
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  assert.equal(valueOf(await finance.getActivityLedger("trip")).events.length, 2);
}));

function restoreHost(directoryUri, platform, faults = {}) {
  const opened = new Set();
  const host = createDatabaseHost({
    directoryUri,
    file(name, directory = directoryUri) {
      const uri = join(directory, name);
      return {
        uri,
        get exists() { return existsSync(uri); },
        sha256: async () => sha256(readFileSync(uri)),
        remove: () => rmSync(uri),
        rename(target) {
          faults.beforeRename?.(name, target);
          const destination = join(directory, target);
          assert.equal(existsSync(destination), false, "restore renames must not overwrite");
          renameSync(uri, destination);
        },
      };
    },
    async copy(source, name) {
      copyFileSync(source, join(directoryUri, name), constants.COPYFILE_EXCL);
    },
    async open(name) {
      const connection = openTestConnection(join(directoryUri, name));
      const close = connection.closeAsync;
      connection.closeAsync = async () => {
        await close();
        opened.delete(connection);
      };
      opened.add(connection);
      return connection;
    },
    backup: (connection, directory) => connection.writeSnapshot(directory),
    createWorkspace: platform.createWorkspace,
    async checkStandalone(name, directory) {
      assert.ok(existsSync(join(directory, name)));
      valueOf(await inspectStandaloneBackup(platform, name, directory));
    },
    async checkInitialized(connection) {
      await faults.beforeCheck?.();
      valueOf(await inspectBackupDatabase(platform, connection, migrations.length));
    },
  });
  return { host, opened, close: async () => { for (const connection of opened) await connection.closeAsync(); } };
}

function withRestore(task) {
  return withFinance(async (finance, _activities, source, sourceConnection, _reopen, path) => {
    const directory = join(dirname(path), "live");
    mkdirSync(directory);
    const platform = backupPlatform(path);
    const backups = createBackupService(platform);
    const faults = {};
    const managed = restoreHost(directory, platform, faults);
    try {
      const live = await managed.host.getDatabase();
      const activities = createActivityRepository(live);
      await activities.createActivity({
        id: "old", name: "Current data", currency: "HKD", members: [{ id: "owner", displayName: "Owner" }],
      });
      const service = createRestoreService(backups, managed.host);
      const exportSource = async () => valueOf(await backups.exportBackup(source)).uri;
      const prepare = async (file) => {
        const outcome = await service.prepareRestore(pathToFileURL(file).href);
        assert.equal(outcome.status, "ready", JSON.stringify(outcome));
        return outcome.preview;
      };
      await task({
        directory, platform, managed, faults, live, activities, finance, source, sourceConnection, service, exportSource, prepare,
      });
    } finally {
      await managed.close();
    }
  });
}

test("confirmed restore replaces the full database and retained repositories use the new connection", withRestore(async ({
  managed, faults, live, activities, finance, source, sourceConnection, service, exportSource, prepare,
}) => {
  const oldConnection = [...managed.opened][0];
  const quick = createQuickSplitRepository(source);
  valueOf(await quick.saveQuickDraft("draft", { mode: "equal" }, 50));
  valueOf(await quick.saveQuickHistory("history", quickInput()));
  valueOf(await createQuickSplitConversionService(source).convertQuickHistory(conversionRequest()));
  valueOf(await finance.createExpense("trip", 110, expense()));
  valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 6000 }));
  valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));
  valueOf(await finance.voidMerchantRefund("trip", { id: "void-refund", targetEventId: refund.id, occurredAt: 400 }));

  const preview = await prepare(await exportSource());
  assert.equal(preview.effect, "replace-all-local-data");
  assert.deepEqual([preview.current.activityCount, preview.current.expenseCount, preview.difference.expenseCount], [1, 0, 2]);
  faults.beforeCheck = async () => {
    await assert.rejects(activities.renameActivity("old", "Blocked during restore"), /restore in progress/);
  };
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }), { status: "restored" });
  assert.equal(await managed.host.getDatabase(), live);
  await assert.rejects(oldConnection.getFirstAsync("SELECT 1"), /not open/);
  assert.deepEqual((await activities.listActivities()).map(({ id }) => id), ["trip"]);

  const tables = await sourceConnection.getAllAsync("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
  for (const { name } of tables) {
    assert.deepEqual(await live.read((db) => db.getAllAsync(`SELECT * FROM ${name}`)),
      await sourceConnection.getAllAsync(`SELECT * FROM ${name}`), name);
  }
  assert.deepEqual(valueOf(await createFinanceRepository(live).getActivityLedger("trip")),
    valueOf(await finance.getActivityLedger("trip")));
  await activities.renameActivity("trip", "New connection works");
  assert.equal((await activities.getActivity("trip")).name, "New connection works");
}));

test("restore rejects invalid paths, damaged backups and a valid backup swapped after preview", withRestore(async ({
  directory, finance, service, activities, exportSource, prepare,
}) => {
  for (const uri of ["https://example.test/backup", "/tmp/backup", "file://host/tmp/a", "file:///tmp/%2e%2e/a"]) {
    assert.deepEqual(await service.prepareRestore(uri), { status: "validation-failed", code: "INVALID_BACKUP_URI" });
  }
  const bad = join(directory, "bad.splitmori-backup");
  writeFileSync(bad, "invalid");
  assert.deepEqual(await service.prepareRestore(pathToFileURL(bad).href), { status: "validation-failed", code: "INVALID_BACKUP_FORMAT" });
  const original = await exportSource();
  const { manifest, payload } = unpackBackup(original);
  writeBackup(bad, { ...manifest, schemaVersion: migrations.length + 1 }, payload);
  assert.deepEqual(await service.prepareRestore(pathToFileURL(bad).href),
    { status: "validation-failed", code: "UNSUPPORTED_BACKUP_VERSION" });
  const preview = await prepare(original);
  valueOf(await finance.createExpense("trip", 100, expense()));
  copyFileSync(await exportSource(), original);
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }),
    { status: "validation-failed", code: "BACKUP_CHANGED" });
  assert.deepEqual((await activities.listActivities()).map(({ id }) => id), ["old"]);
  assert.equal(existsSync(join(directory, restoreFiles.safety)), false);
}));

test("cancel consumes the confirmation and leaves both the main SQLite file and WAL unchanged", withRestore(async ({
  directory, service, exportSource, prepare,
}) => {
  const files = [databaseName, databaseName + "-wal"];
  const before = files.map((name) => readFileSync(join(directory, name)));
  const preview = await prepare(await exportSource());
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: false }), { status: "cancelled" });
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }),
    { status: "validation-failed", code: "INVALID_CONFIRMATION" });
  assert.deepEqual(files.map((name) => readFileSync(join(directory, name))), before);
}));

test("a stale confirmation is rejected and a fresh restore can migrate an older snapshot", withRestore(async ({
  directory, live, activities, service, exportSource, prepare,
}) => {
  const { manifest } = unpackBackup(await exportSource());
  const olderPath = join(directory, "legacy.sqlite");
  const older = openTestConnection(olderPath);
  try {
    await older.execAsync(migrations[0]);
    await older.execAsync(`
      PRAGMA user_version = 1;
      INSERT INTO activities VALUES ('legacy', 'Legacy', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('legacy-member', 'Member', 1);
      INSERT INTO activity_members VALUES ('legacy', 'legacy-member', 0);
    `);
  } finally {
    older.close();
  }
  const olderPayload = readFileSync(olderPath);
  const olderBackup = join(directory, "legacy.splitmori-backup");
  writeBackup(olderBackup, {
    ...manifest, schemaVersion: 1, byteLength: olderPayload.length, sha256: sha256(olderPayload),
  }, olderPayload);
  const preview = await prepare(olderBackup);
  await activities.renameActivity("old", "Edited after preview");
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }),
    { status: "validation-failed", code: "CURRENT_DATA_CHANGED" });
  assert.equal((await activities.getActivity("old")).name, "Edited after preview");
  const fresh = await prepare(olderBackup);
  assert.deepEqual(await service.restoreBackup({ confirmation: fresh.confirmation, confirmed: true }), { status: "restored" });
  assert.deepEqual((await activities.listActivities()).map(({ id }) => id), ["legacy"]);
  assert.equal((await live.read((db) => db.getFirstAsync("PRAGMA user_version"))).user_version, migrations.length);
  assert.deepEqual(unpackBackup(olderBackup).payload, olderPayload);
}));

test("a failure after switching to the new file rolls back and makes the original usable", withRestore(async ({
  directory, live, activities, managed, faults, service, exportSource, prepare,
}) => {
  const original = [...managed.opened][0];
  await activities.completeActivity("old");
  await activities.createActivity({
    id: "original-trip", name: "Original trip", currency: "HKD", members: quickInput().members,
  });
  const finance = createFinanceRepository(live);
  valueOf(await finance.createExpense("original-trip", 100, expense("original-expense")));
  const ledger = valueOf(await finance.getActivityLedger("original-trip"));
  const preview = await prepare(await exportSource());
  faults.beforeCheck = () => {
    assert.ok(existsSync(join(directory, restoreFiles.safety)));
    assert.ok(existsSync(join(directory, restoreFiles.displaced)));
    faults.beforeCheck = undefined;
    throw new Error("Injected check failure after opening the replacement");
  };
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }), { status: "failed" });
  assert.deepEqual((await activities.listActivities()).map(({ id }) => id).sort(), ["old", "original-trip"]);
  assert.deepEqual(valueOf(await finance.getActivityLedger("original-trip")), ledger);
  await assert.rejects(original.getFirstAsync("SELECT 1"), /not open/);
  assert.equal(existsSync(join(directory, restoreFiles.safety)), false);
  await activities.renameActivity("old", "Original remains writable");
}));

test("startup recovers a durable marker when switching and immediate rollback are interrupted", withRestore(async ({
  directory, platform, faults, service, activities, exportSource, prepare,
}) => {
  const preview = await prepare(await exportSource());
  faults.beforeRename = (name, target) => {
    if (name === restoreFiles.stage && target === databaseName) throw new Error("Injected interruption at SQLite rename");
  };
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }),
    { status: "recovery-required" });
  assert.equal(existsSync(join(directory, databaseName)), false);
  assert.ok(existsSync(join(directory, restoreFiles.safety)));
  await assert.rejects(activities.listActivities(), /recovery failed/);
  writeFileSync(join(directory, databaseName + "-wal"), "stale WAL");
  writeFileSync(join(directory, databaseName + "-shm"), "stale SHM");

  const restarted = restoreHost(directory, platform);
  try {
    const reopened = await restarted.host.getDatabase();
    assert.deepEqual((await createActivityRepository(reopened).listActivities()).map(({ id }) => id), ["old"]);
    assert.equal(existsSync(join(directory, restoreFiles.safety)), false);
    assert.equal((await reopened.read((db) => db.getFirstAsync("PRAGMA journal_mode"))).journal_mode, "wal");
  } finally {
    await restarted.close();
  }
}));

test("Free creation commits the first activity and leaves no records for a rejected second activity", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    const activities = createActivityRepository(await initializeDatabase(connection));
    assert.equal(await activities.getCreationBlocker(), null);
    const first = await activities.createActivity({
      id: "first", name: " Weekend dinner ", currency: "HKD", members: [{ id: "m1", displayName: " Sam " }],
    });
    assert.equal(first.name, "Weekend dinner");
    assert.equal(first.members[0].displayName, "Sam");
    assert.equal(first.status, "active");
    assert.equal(first.createdAt, first.updatedAt);
    assert.deepEqual(await activities.getCreationBlocker(), { id: "first", name: "Weekend dinner", activeCount: 1 });
    await assert.rejects(activities.createActivity({
      id: "second", name: "Second", currency: "JPY", members: [{ id: "m2", displayName: "Second" }],
    }), (error) => error instanceof ActiveActivityLimitError && error.blocker.id === "first");
    assert.equal(await activities.getActivity("second"), null);
    assert.equal(await connection.getFirstAsync("SELECT id FROM members WHERE id = 'm2'"), null);
    assert.equal(await connection.getFirstAsync("SELECT activity_id FROM activity_members WHERE activity_id = 'second'"), null);
  } finally {
    connection.close();
  }
}));

test("concurrent Free requests cannot bypass the active slot and completed activities stay readable", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    const database = await initializeDatabase(connection);
    const activities = createActivityRepository(database);
    const candidate = (id) => ({ id, name: id, currency: "HKD", members: [{ id: `member-${id}`, displayName: id }] });
    const [first, second] = await Promise.allSettled([
      activities.createActivity(candidate("a")), createActivityRepository(database).createActivity(candidate("b")),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.ok(second.reason instanceof ActiveActivityLimitError);
    await activities.completeActivity("a");
    assert.equal((await activities.createActivity(candidate("b"))).status, "active");
    await assert.rejects(activities.reopenActivity("a"), ActiveActivityLimitError);
    assert.equal((await activities.getActivity("a")).status, "completed");
    assert.equal((await activities.listActivities()).length, 2);
  } finally {
    connection.close();
  }
}));

test("activity list projects effective totals and outstanding balances for completed activities", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMerchantRefund("trip", 200, refund));
  await activities.completeActivity("trip");
  await activities.createActivity({
    id: "yen", name: "Yen trip", currency: "JPY", members: [{ id: "j", displayName: "Jo" }],
  });
  const rows = await loadActivityList(database);
  const completed = rows.find(({ id }) => id === "trip");
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.total, { currency: "HKD", amountMinor: 8000 });
  assert.deepEqual([completed.memberCount, completed.expenseCount, completed.hasOutstanding], [2, 1, true]);
  const active = rows.find(({ id }) => id === "yen");
  assert.deepEqual(active.total, { currency: "JPY", amountMinor: 0 });
  assert.deepEqual([active.memberCount, active.expenseCount, active.hasOutstanding], [1, 0, false]);
}));

test("new activity detail keeps all stable members with zero expense and outstanding totals", withFinance(async (_finance, _activities, database) => {
  assert.equal(await loadActivityDetail("missing", database), null);
  const detail = await loadActivityDetail("trip", database);
  assert.equal(detail.activity.status, "active");
  assert.deepEqual(detail.activity.members.map(({ id, displayName }) => [id, displayName]), [["z", "Alex"], ["a", "Bo"]]);
  assert.deepEqual(detail.expenses, []);
  assert.deepEqual(detail.history, []);
  assert.deepEqual([detail.grossMinor, detail.refundMinor, detail.effectiveMinor, detail.outstandingMinor], [0n, 0n, 0n, 0n]);
}));

test("S08 saves a named HKD 560 expense exactly once and refreshes the activity ledger", withFinance(async (finance, activities, database, _connection, reopen) => {
  const editor = { ...createExpenseEditor(await activities.getActivity("trip")), finalTotal: "560.00", merchantPayerId: "z" };
  const entry = valueOf(prepareNewExpense("dinner", " 晚餐 ", editor));
  const [saved, retry] = await Promise.all([finance.createExpense("trip", 100, entry), finance.createExpense("trip", 100, entry)]);
  assert.deepEqual(valueOf(saved), valueOf(retry));
  assert.equal((await finance.createExpense("trip", 100, { ...entry, name: "另一名稱" })).error.code, "EVENT_ID_CONFLICT");

  const detail = await loadActivityDetail("trip", database);
  assert.deepEqual(detail.expenses.map(({ name, payerName }) => [name, payerName]), [["晚餐", "Alex"]]);
  assert.equal(detail.effectiveMinor, 56_000n);
  assert.deepEqual([...detail.balances], [["z", 28_000], ["a", -28_000]]);
  const ledger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(ledger.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 28_000 }]);

  const request = correction(50_000);
  assert.equal(valueOf(await finance.previewExpenseCorrection("trip", "dinner", request.proposed)).expense.after.name, "晚餐");
  assert.equal(valueOf(await finance.commitExpenseCorrection("trip", request)).expense.name, "晚餐");
  const reopened = await reopen();
  assert.deepEqual(valueOf(await reopened.listExpenseRevisions("trip", "dinner")).map(({ expense }) => expense.name), ["晚餐", "晚餐"]);
  assert.equal(valueOf(await reopened.getExpense("trip", "dinner")).expense.name, "晚餐");
}));

test("S08 requires a merchant payer and accepts a payer outside the selected split", withFinance(async (finance, activities) => {
  const editor = { ...createExpenseEditor(await activities.getActivity("trip")), finalTotal: "560.00" };
  assert.equal(prepareNewExpense("dinner", "晚餐", editor).error.code, "MISSING_MERCHANT_PAYMENT");
  const entry = valueOf(prepareNewExpense("dinner", "晚餐", {
    ...editor, merchantPayerId: "z", members: editor.members.map((member) => ({ ...member, included: member.id === "a" })),
  }));
  assert.equal((await finance.createExpense("trip", 100, { ...entry, merchantPayment: undefined })).error.code, "MISSING_MERCHANT_PAYMENT");
  assert.equal((await finance.createExpense("trip", 100, { ...entry, merchantPayment: { ...entry.merchantPayment, memberId: "outside" } })).error.code, "MEMBER_NOT_PARTICIPATING");
  assert.deepEqual(valueOf(await finance.listExpenses("trip")), []);
  assert.deepEqual(valueOf(await finance.createExpense("trip", 100, entry)).expense.merchantPayment, {
    memberId: "z", currency: "HKD", amountMinor: 56_000,
  });
  assert.deepEqual(valueOf(await finance.listExpenses("trip"))[0].expense.split.allocations, [{ memberId: "a", amountMinor: 56_000 }]);
}));

test("S08 rejects a completed activity without writing a partial expense", withFinance(async (finance, activities, _database, connection) => {
  const editor = { ...createExpenseEditor(await activities.getActivity("trip")), finalTotal: "560", merchantPayerId: "z" };
  await activities.completeActivity("trip");
  assert.equal((await finance.createExpense("trip", 100, valueOf(prepareNewExpense("dinner", "晚餐", editor)))).error.code, "ACTIVITY_COMPLETED");
  for (const table of ["financial_events", "expenses", "expense_allocations", "merchant_payments"]) {
    assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
  }
}));

test("v7 migrates a v6 ledger with expense revisions and keeps the legacy display name fallback", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    for (const migration of migrations.slice(0, 6)) await connection.execAsync(migration);
    await connection.execAsync(`
      INSERT INTO activities VALUES ('trip', 'Trip', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('z', 'Alex', 1), ('a', 'Bo', 1);
      INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1);
      INSERT INTO financial_events VALUES (1, 'dinner', 'trip', 'expense', 100);
      INSERT INTO expenses VALUES ('dinner', 'trip', 'HKD', 10000, 'equal', 1);
      INSERT INTO expense_allocations VALUES ('trip', 'dinner', 'z', 5000, 0), ('trip', 'dinner', 'a', 5000, 1);
      INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'z', 10000);
      INSERT INTO expense_revisions VALUES (2, 'revision', 'trip', 'dinner', 2, 200, 'HKD', 8000, 'equal', 1, 'z', 8000, '[]');
      INSERT INTO expense_revision_allocations VALUES ('trip', 'revision', 'z', 4000, 0), ('trip', 'revision', 'a', 4000, 1);
      PRAGMA user_version = 6;
    `);
    assert.equal(valueOf(await validateStoredLedgers(connection, 6)), true);
    const database = await initializeDatabase(connection);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 7);
    const detail = await loadActivityDetail("trip", database);
    assert.deepEqual(detail.expenses.map(({ name, effectiveMinor }) => [name, effectiveMinor]), [["費用 1", 8000]]);
    assert.equal((await connection.getFirstAsync("SELECT name FROM expenses WHERE id = 'dinner'")).name, null);
    assert.equal(valueOf(await validateStoredLedgers(connection, 7)), true);
  } finally {
    connection.close();
  }
}));

test("S08 reuses the Free treat and individual calculations, validates charges, and handles local dates", withFinance(async (_finance, activities) => {
  const editor = { ...createExpenseEditor(await activities.getActivity("trip")), finalTotal: "55", merchantPayerId: "a" };
  const charges = { chargeMode: "details", subtotal: "60", discount: "10", serviceFeeMode: "quick10", serviceFeeBasis: "afterDiscount" };
  const treat = valueOf(prepareNewExpense("treat", "請客", {
    ...editor, ...charges, mode: "treat", hostId: "z", coverKind: "percentage", coverPercentage: "20",
  }));
  assert.deepEqual(treat.split.allocations.map(({ amountMinor }) => amountMinor), [1100, 4400]);
  const individual = valueOf(prepareNewExpense("individual", "各自消費", {
    ...editor, ...charges, mode: "individual", sharedAmount: "20",
    members: editor.members.map((member, index) => ({ ...member, personalAmount: index === 0 ? "30" : "10" })),
  }));
  assert.equal(individual.split.total.amountMinor, 5500);
  assert.equal(individual.split.allocations.reduce((sum, { amountMinor }) => sum + amountMinor, 0), 5500);
  assert.equal(prepareNewExpense("mismatch", "測試", { ...editor, ...charges, finalTotal: "56" }).error.code, "TOTAL_MISMATCH");
  const openedAt = new Date(2026, 10, 7, 14, 21);
  assert.equal(expenseDateTimestamp(expenseDateInput(openedAt), openedAt), openedAt.getTime());
  assert.equal(expenseDateTimestamp("2026-02-30", openedAt), undefined);
  assert.equal(expenseDateTimestamp("2026-11-06", openedAt), new Date(2026, 10, 6, 12).getTime());
}));

test("activity detail reads revised expenses, effective refunds and repayments from the ledger snapshot", withFinance(async (finance, _activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.createExpense("trip", 110, expense("second", 4000)));
  valueOf(await finance.recordMerchantRefund("trip", 200, refund));
  valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 3000 }));
  valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));
  valueOf(await finance.voidMerchantRefund("trip", { id: "void-refund", targetEventId: refund.id, occurredAt: 400 }));
  valueOf(await finance.recordMerchantRefund("trip", 450, {
    ...refund, id: "second-refund", expenseId: "second", amountMinor: 1000,
    reductions: [{ memberId: "z", amountMinor: 500 }, { memberId: "a", amountMinor: 500 }],
  }));

  const beforeVoid = await loadActivityDetail("trip", database);
  assert.deepEqual([beforeVoid.grossMinor, beforeVoid.refundMinor, beforeVoid.effectiveMinor], [12000n, 1000n, 11000n]);
  assert.equal(beforeVoid.outstandingMinor, 2500n);
  valueOf(await finance.voidMemberTransfer("trip", { id: "void-transfer", targetEventId: repayment.id, occurredAt: 500 }));
  const detail = await loadActivityDetail("trip", database);
  assert.deepEqual([detail.grossMinor, detail.refundMinor, detail.effectiveMinor, detail.outstandingMinor], [12000n, 1000n, 11000n, 5500n]);
  assert.deepEqual(detail.expenses.map(({ id, payerName, grossMinor, effectiveMinor, refundMinor }) =>
    [id, payerName, grossMinor, effectiveMinor, refundMinor]), [
    ["second", "Alex", 4000, 3000, 1000], ["dinner", "Alex", 8000, 8000, 0],
  ]);
  assert.deepEqual([...detail.balances], [["z", 5500], ["a", -5500]]);
  assert.equal(detail.history.find(({ id }) => id === "refund:refund").voided, true);
  assert.equal(detail.history.find(({ id }) => id === "transfer:repayment").voided, true);
}));

test("completing and reopening preserves the original finance ledger and an outstanding balance", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  await activities.completeActivity("trip");
  const completed = await loadActivityDetail("trip", database);
  assert.equal(completed.activity.status, "completed");
  assert.equal(completed.outstandingMinor, 5000n);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);

  await activities.reopenActivity("trip");
  const reopened = await loadActivityDetail("trip", database);
  assert.equal(reopened.activity.status, "active");
  assert.equal(reopened.outstandingMinor, completed.outstandingMinor);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
}));

test("reopen is rejected by the current Free slot while a completed ledger remains readable", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "active", name: "Other activity", currency: "JPY", members: [{ id: "new", displayName: "New" }] });
  const before = await loadActivityDetail("trip", database);
  await assert.rejects(activities.reopenActivity("trip"), (error) => error instanceof ActiveActivityLimitError && error.blocker.id === "active");
  assert.deepEqual(await loadActivityDetail("trip", database), before);
}));
