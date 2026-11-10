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
import { ActiveActivityLimitError, createActivityRepository, MemberManagementError, memberNameMaxLength } from "../src/data/activities.ts";
import { backupSnapshotName, DatabaseInitializationError, initializeDatabase } from "../src/data/database.ts";
import { createDatabaseHost, databaseName, restoreFiles } from "../src/data/databaseHost.ts";
import { createFinanceRepository, validateStoredLedgers } from "../src/data/finance.ts";
import { applyMigration, expandedCurrencySchemaVersion, migrations, multiPayerSchemaVersion } from "../src/data/migrations.ts";
import { createQuickSplitRepository } from "../src/data/quickSplits.ts";
import { calculateQuickSplit } from "../src/domain/quickSplit.ts";
import { splitEqual } from "../src/domain/split.ts";
import { createBackupService, inspectBackupDatabase, inspectStandaloneBackup } from "../src/services/backup.ts";
import { loadActivityList } from "../src/services/activityList.ts";
import { loadActivityDetail } from "../src/services/activityDetail.ts";
import { loadActivityMembers } from "../src/services/activityMembers.ts";
import { loadActivitySettlement } from "../src/services/activitySettlement.ts";
import { buildSettlementPngCard, loadSettlementPngSnapshot } from "../src/services/activitySettlementPng.ts";
import { buildSettlementDocument } from "../src/services/activitySettlementExport.ts";
import { createAppPreferencesStore, searchCurrencies } from "../src/services/appPreferences.ts";
import { loadExpenseCorrectionPreview, loadExpenseDetail, saveReviewedExpenseCorrection, summarizeCorrectionBalances } from "../src/services/expenseDetail.ts";
import { createExpenseEditor, expenseDateInput, expenseDateTimestamp, hydrateExpenseEditor, prepareExpenseEdit, prepareNewExpense } from "../src/services/expenseEditor.ts";
import { inspectRepaymentDraft } from "../src/services/memberRepayment.ts";
import { createProEntitlement } from "../src/services/proEntitlement.ts";
import {
  inspectMerchantRefundDraft, loadMerchantRefundPreview, loadMerchantRefundVoidPreview, saveReviewedMerchantRefund,
} from "../src/services/merchantRefund.ts";
import { createQuickHistorySave } from "../src/services/quickHistorySave.ts";
import { canSelectConversionTarget, createQuickSplitConversionService } from "../src/services/quickSplitConversion.ts";
import { calculateQuickSplitEditor, createQuickSplitEditor, hydrateQuickSplitDraft, serializeQuickSplitDraft } from "../src/services/quickSplitEditor.ts";
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
    INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'z', 0)
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

test("S02 starts a new draft in USD when the saved default is USD and SQLite has no draft", withFinance(async (_finance, _activities, database) => {
  const preferences = await createAppPreferencesStore({
    getItem: async () => JSON.stringify({ language: "system", defaultCurrency: "USD" }),
    setItem: async () => {},
  }).load();
  const quick = createQuickSplitRepository(database);
  assert.equal(valueOf(await quick.getQuickDraft()), null);
  const editor = createQuickSplitEditor(preferences.defaultCurrency);
  assert.equal(editor.currency, "USD");
  assert.equal(editor.finalTotal, "");
  valueOf(await quick.saveQuickDraft("usd-draft", serializeQuickSplitDraft({ ...editor, finalTotal: "20.50" }), 100));
  assert.equal(valueOf(await quick.getQuickDraft()).input.currency, "USD");
}));

test("S02 retains an HKD draft after changing the default to USD and uses USD after explicitly discarding it", withFinance(async (_finance, activities, database) => {
  let savedPreferences = null;
  const preferences = createAppPreferencesStore({
    getItem: async () => savedPreferences,
    setItem: async (_key, value) => { savedPreferences = value; },
  });
  const initial = await preferences.load();
  assert.equal(initial.defaultCurrency, "HKD");
  const quick = createQuickSplitRepository(database);
  const hkdDraft = serializeQuickSplitDraft({ ...createQuickSplitEditor(initial.defaultCurrency), finalTotal: "560.00" });
  const original = valueOf(await quick.saveQuickDraft("hkd-draft", hkdDraft, 100));
  const history = valueOf(await quick.saveQuickHistory("hkd-history", quickInput()));
  await preferences.save({ ...initial, defaultCurrency: "USD" });
  const current = await preferences.load();

  const stored = valueOf(await quick.getQuickDraft());
  assert.deepEqual(stored, original);
  const restored = hydrateQuickSplitDraft(stored.input);
  assert.deepEqual([restored.currency, restored.finalTotal], ["HKD", "560.00"]);
  assert.deepEqual(valueOf(await quick.getQuickDraft()), original);

  assert.equal(valueOf(await quick.clearQuickDraft()), true);
  assert.equal(valueOf(await quick.getQuickDraft()), null);
  const fresh = createQuickSplitEditor(current.defaultCurrency);
  assert.deepEqual([fresh.currency, fresh.finalTotal], ["USD", ""]);
  valueOf(await quick.saveQuickDraft("new-usd-draft", serializeQuickSplitDraft({ ...fresh, finalTotal: "5" }), 200));
  assert.equal(valueOf(await quick.getQuickDraft()).input.currency, "USD");
  assert.deepEqual(valueOf(await quick.getQuickHistory(history.id)), history);
  assert.equal((await activities.getActivity("trip")).currency, "HKD");
}));

test("S02 preserves a manually selected JPY currency when another field and the default are updated", withFinance(async (_finance, _activities, database) => {
  let savedPreferences = null;
  const preferences = createAppPreferencesStore({
    getItem: async () => savedPreferences,
    setItem: async (_key, value) => { savedPreferences = value; },
  });
  await preferences.save({ language: "system", defaultCurrency: "USD" });
  const quick = createQuickSplitRepository(database);
  const initial = createQuickSplitEditor((await preferences.load()).defaultCurrency);
  const selected = { ...initial, currency: "JPY" };
  valueOf(await quick.saveQuickDraft("selected-jpy", serializeQuickSplitDraft(selected), 100));
  await preferences.save({ language: "system", defaultCurrency: "HKD" });
  assert.equal((await preferences.load()).defaultCurrency, "HKD");
  const updated = { ...selected, finalTotal: "3000" };
  valueOf(await quick.saveQuickDraft("edited-jpy", serializeQuickSplitDraft(updated), 200));
  const restored = hydrateQuickSplitDraft(valueOf(await quick.getQuickDraft()).input);
  assert.deepEqual([restored.currency, restored.finalTotal], ["JPY", "3000"]);
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

test("conversion maps saved amounts by ID and persists the expense name and history link", withFinance(async (finance, _activities, database, _connection, reopen) => {
  const quick = createQuickSplitRepository(database);
  const input = quickInput();
  input.members[1].displayName = input.members[0].displayName;
  const history = valueOf(await quick.saveQuickHistory("history", input));
  const service = createQuickSplitConversionService(database);
  assert.deepEqual(await service.getSource("history"), { history, destination: null });
  const receipt = valueOf(await service.convertQuickHistory(conversionRequest({ expenseName: " 晚餐 " })));

  assert.equal(receipt.event.expense.id, "quick-conversion:convert-1");
  assert.equal(receipt.event.expense.name, "晚餐");
  assert.deepEqual(receipt.event.expense.split.allocations, [
    { memberId: "z", amountMinor: 5000 }, { memberId: "a", amountMinor: 5001 },
  ]);
  assert.deepEqual(receipt.source.split, history.snapshot.split);
  assert.deepEqual(receipt.source.input, history.input);
  assert.deepEqual(valueOf(await quick.getQuickHistory("history")), history);
  assert.deepEqual(valueOf(await finance.listEvents("trip")), [receipt.event]);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).suggestions,
    [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 5001 }]);
  assert.deepEqual(await service.getSource("history"), { history, destination: { activityId: "trip", activityName: "Trip" } });
  const detail = await loadActivityDetail("trip", database);
  assert.deepEqual(detail.expenses.map(({ name, effectiveMinor }) => [name, effectiveMinor]), [["晚餐", 10_001]]);
  const reopened = await reopen();
  assert.deepEqual(valueOf(await reopened.listEvents("trip")), [receipt.event]);
}));

test("conversion requires explicit actual payment matching the saved total", withFinance(async (finance, _activities, database) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await quick.saveQuickHistory("history", { ...quickInput(), merchantPayerId: "a" }));
  const service = createQuickSplitConversionService(database);
  assert.deepEqual((await service.convertQuickHistory(conversionRequest({ merchantPayment: undefined }))).error,
    { code: "MISSING_MERCHANT_PAYMENT", field: "merchantPayment" });
  const request = conversionRequest();
  assert.deepEqual((await service.convertQuickHistory(conversionRequest({ expenseName: "   " }))).error,
    { code: "INVALID_EXPENSE_NAME", field: "expenseName" });
  assert.deepEqual((await service.convertQuickHistory({ ...request, merchantPayment: { ...request.merchantPayment, amountMinor: 10_000 } })).error,
    { code: "TOTAL_MISMATCH", field: "merchantPayment" });
  assert.deepEqual((await service.convertQuickHistory({ ...request, merchantPayment: { ...request.merchantPayment, memberId: "outside" } })).error,
    { code: "MEMBER_NOT_PARTICIPATING", field: "merchantPayment" });
  assert.deepEqual(valueOf(await finance.listEvents("trip")), []);
}));

test("conversion rejects incomplete or merged mappings, wrong currency and completed activities", withFinance(async (finance, activities, database) => {
  const quick = createQuickSplitRepository(database);
  const history = valueOf(await quick.saveQuickHistory("history", quickInput()));
  const service = createQuickSplitConversionService(database);
  for (const memberMapping of [
    [{ quickMemberId: "a", activityMemberId: "z" }],
    [{ quickMemberId: "a", activityMemberId: "z" }, { quickMemberId: "z", activityMemberId: "z" }],
    [{ quickMemberId: "a", activityMemberId: "z" }, { quickMemberId: "z", activityMemberId: "missing" }],
  ]) {
    assert.deepEqual((await service.convertQuickHistory(conversionRequest({ memberMapping }))).error,
      { code: "INVALID_MEMBER_MAPPING", field: "memberMapping" });
  }
  assert.equal((await service.listTargets("HKD")).filter((row) => canSelectConversionTarget(row, history)).length, 1);
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "yen", name: "Yen trip", currency: "JPY", members: [{ id: "j", displayName: "Jo" }] });
  const targets = await service.listTargets("HKD");
  assert.deepEqual(targets.map(({ id, status }) => [id, status]), [["trip", "completed"]]);
  assert.equal(targets.some((row) => canSelectConversionTarget(row, history)), false);
  assert.deepEqual((await service.convertQuickHistory(conversionRequest({ activityId: "yen" }))).error,
    { code: "CURRENCY_MISMATCH", field: "currency" });
  assert.deepEqual((await service.convertQuickHistory(conversionRequest())).error,
    { code: "ACTIVITY_COMPLETED", field: "activityId" });
  assert.deepEqual(valueOf(await finance.listEvents("trip")), []);
  assert.deepEqual(valueOf(await finance.listEvents("yen")), []);
}));

test("conversion retries remain idempotent after deleting history and never double-post", withFinance(async (finance, activities, database) => {
  const quick = createQuickSplitRepository(database);
  valueOf(await quick.saveQuickHistory("history", quickInput()));
  const service = createQuickSplitConversionService(database);
  const request = conversionRequest({ expenseName: "晚餐" });
  const [first, retry] = await Promise.all([
    service.convertQuickHistory(request),
    service.convertQuickHistory({ ...request, expenseName: " 晚餐 ", memberMapping: [...request.memberMapping].reverse() }),
  ]);
  const receipt = valueOf(first);
  assert.deepEqual(valueOf(retry), receipt);
  assert.deepEqual((await service.convertQuickHistory({ ...request, occurredAt: 101 })).error,
    { code: "CONVERSION_REQUEST_CONFLICT", field: "conversionRequestId" });
  assert.deepEqual((await service.convertQuickHistory({ ...request, expenseName: "午餐" })).error,
    { code: "CONVERSION_REQUEST_CONFLICT", field: "conversionRequestId" });
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "other-trip", name: "Other trip", currency: "HKD", members: [{ id: "other", displayName: "Jo" }] });
  assert.equal((await service.convertQuickHistory({ ...request, requestId: "another", activityId: "other-trip" })).error.code,
    "QUICK_HISTORY_ALREADY_CONVERTED");
  assert.deepEqual(valueOf(await finance.listEvents("other-trip")), []);
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
  const request = conversionRequest({ expenseName: "晚餐" });
  assert.deepEqual((await service.convertQuickHistory(request)).error,
    { code: "QUICK_CONVERSION_STORAGE_ERROR", field: "storage" });
  for (const table of ["financial_events", "expenses", "expense_allocations", "merchant_payments", "quick_split_conversions"]) {
    assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
  }
  assert.deepEqual(valueOf(await quick.getQuickHistory("history")), history);
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_conversion_receipt"));
  const saved = valueOf(await service.convertQuickHistory(request));
  assert.equal(saved.event.expense.name, "晚餐");
  assert.deepEqual(valueOf(await finance.listEvents("trip")), [saved.event]);
}));

test("conversion maps even nonparticipants and allows a payer outside the original split", withFinance(async (finance, activities, database) => {
  await activities.addMember("trip", { id: "payer", displayName: "May" });
  const quick = createQuickSplitRepository(database);
  const input = { ...quickInput(), method: { kind: "equal", memberIds: ["a"] } };
  const history = valueOf(await quick.saveQuickHistory("history", input));
  const service = createQuickSplitConversionService(database);
  const request = conversionRequest({ expenseName: "晚餐", merchantPayment: { memberId: "payer", ...history.snapshot.split.total } });
  assert.equal((await service.convertQuickHistory({ ...request, memberMapping: [request.memberMapping[1]] })).error.code,
    "INVALID_MEMBER_MAPPING");
  const { event } = valueOf(await service.convertQuickHistory(request));
  assert.deepEqual(event.expense.split.allocations, [{ memberId: "z", amountMinor: 10_001 }]);
  assert.equal(event.expense.merchantPayment.memberId, "payer");
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).suggestions,
    [{ fromMemberId: "z", toMemberId: "payer", currency: "HKD", amountMinor: 10_001 }]);
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

test("a void that would overflow balances after revisions leaves the ledger unchanged", withFinance(async (_finance, _activities, database) => {
  const finance = createFinanceRepository(database, () => true);
  const withCustomInput = (entry) => ({
    ...entry,
    splitInput: {
      members: [{ id: "z", displayName: "Alex" }, { id: "a", displayName: "Bo" }],
      charges: { kind: "finalTotal", total: entry.split.total },
      method: { kind: "custom", options: { kind: "fixed", members: entry.split.allocations } },
    },
  });
  const max = Number.MAX_SAFE_INTEGER;
  const original = expense("dinner", max - 1);
  original.splitMode = "custom";
  original.split = { ...original.split, allocations: [{ memberId: "z", amountMinor: 1 }, { memberId: "a", amountMinor: max - 2 }] };
  original.merchantPayment = { ...original.merchantPayment, memberId: "a" };
  valueOf(await finance.createExpense("trip", 100, withCustomInput(original)));
  valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, id: "earlier", fromMemberId: "z", toMemberId: "a", amountMinor: 1 }));
  const first = { ...original, split: { ...original.split, allocations: [{ memberId: "a", amountMinor: max - 1 }] },
    merchantPayment: { ...original.merchantPayment, memberId: "z" } };
  valueOf(await finance.commitExpenseCorrection("trip", correction(max - 1, { proposed: withCustomInput(first) })));
  valueOf(await finance.recordMemberTransfer("trip", 400, { ...repayment, amountMinor: 1 }));
  const second = { ...first, split: { total: { currency: "HKD", amountMinor: max }, allocations: [{ memberId: "a", amountMinor: max }] },
    merchantPayment: { ...first.merchantPayment, amountMinor: max } };
  valueOf(await finance.commitExpenseCorrection("trip", correction(max, {
    proposed: withCustomInput(second), revisionId: "correction-2", expectedVersion: 2, occurredAt: 500,
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
  valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 6000, note: "FPS" }));
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
  assert.equal(sha256(unpackBackup(uri).payload), manifest.sha256);
  assert.ok(preview.fileModifiedAt > 0);
  assert.deepEqual(
    [preview.validationStatus, preview.activityCount, preview.memberCount, preview.expenseCount, preview.financialEventCount,
      preview.repaymentCount, preview.refundCount, preview.quickHistoryCount],
    ["valid", 1, 2, 2, 6, 1, 1, 1],
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

test("backup schema accepts the known early revision layouts and the canonical v13 and v14 schemas", withTestFile(async (path) => {
  const service = backupService(path);
  for (const version of [9, 10, 11, 12, 13, 14]) {
    for (const early of [false, true]) {
      const fixture = `${path}-${version}-${early}.sqlite`;
      const connection = openTestConnection(fixture);
      try {
        for (let index = 0; index < version; index += 1) {
          if (index === 2 && early) await connection.execAsync(migrations[2].replace("    reviewed_refund_ids TEXT NOT NULL,\n", ""));
          else await applyMigration(connection, index);
        }
        await connection.execAsync(`PRAGMA user_version = ${version}`);
      } finally {
        connection.close();
      }
      const payload = readFileSync(fixture);
      const uri = `${fixture}.splitmori-backup`;
      const manifest = { formatVersion: 1, schemaVersion: version, createdAt: null, byteLength: payload.length, sha256: sha256(payload), assets: [] };
      writeBackup(uri, manifest, payload);
      assert.deepEqual(valueOf(await service.previewBackup(uri)).manifest, manifest);
    }
  }
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
    ["DROP INDEX merchant_payments_by_activity", "BACKUP_SCHEMA_MISMATCH"],
    ["ALTER TABLE merchant_refunds DROP COLUMN recorded_at", "BACKUP_SCHEMA_MISMATCH"],
    ["CREATE INDEX unexpected_payment_index ON merchant_payments(member_id)", "BACKUP_SCHEMA_MISMATCH"],
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

async function seedLegacyPayments(connection, version) {
  await connection.execAsync("PRAGMA foreign_keys = ON");
  for (let index = 0; index < version; index += 1) await applyMigration(connection, index);
  await connection.execAsync(`
    INSERT INTO activities VALUES ('trip', 'Trip', 'HKD', 'active', 1, 1);
    INSERT INTO members VALUES ('z', 'Alex', 1), ('a', 'Bo', 1);
    INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1);
    INSERT INTO financial_events VALUES (1, 'dinner', 'trip', 'expense', 100),
      (2, 'refund', 'trip', 'merchantRefund', 200), (3, 'repayment', 'trip', 'memberTransfer', 300);
    INSERT INTO expenses (id, activity_id, currency, amount_minor, split_mode, allocation_version, name)
      VALUES ('dinner', 'trip', 'HKD', 10000, 'equal', 1, 'Dinner');
    INSERT INTO expense_allocations VALUES ('trip', 'dinner', 'z', 5000, 0), ('trip', 'dinner', 'a', 5000, 1);
    INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'z', 10000);
    INSERT INTO merchant_refunds (id, activity_id, expense_id, recipient_id, amount_minor, note)
      VALUES ('refund', 'trip', 'dinner', 'a', 2000, 'Refund receipt');
    INSERT INTO refund_reductions VALUES ('trip', 'dinner', 'refund', 'z', 1000), ('trip', 'dinner', 'refund', 'a', 1000);
    INSERT INTO member_transfers VALUES ('repayment', 'trip', 'a', 'z', 1000, 'FPS');
    INSERT INTO expense_revisions (sequence, id, activity_id, expense_id, version, occurred_at, currency,
      amount_minor, split_mode, allocation_version, payer_id, paid_minor, reviewed_refund_ids, name)
      VALUES (4, 'legacy-revision', 'trip', 'dinner', 2, 400, 'HKD', 8000, 'equal', 1, 'z', 8000, '["refund"]', 'Revised dinner');
    INSERT INTO expense_revision_allocations VALUES ('trip', 'legacy-revision', 'z', 4000, 0),
      ('trip', 'legacy-revision', 'a', 4000, 1);
    PRAGMA user_version = ${version};
  `);
}

async function seedV13Payments(connection) {
  await seedLegacyPayments(connection, 12);
  await applyMigration(connection, multiPayerSchemaVersion - 1);
  await connection.execAsync(`
    UPDATE merchant_payments SET amount_minor = 9000 WHERE expense_id = 'dinner';
    INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'a', 1000);
    UPDATE expense_revision_payments SET amount_minor = 7000 WHERE revision_id = 'legacy-revision';
    INSERT INTO expense_revision_payments VALUES ('trip', 'legacy-revision', 'a', 1000);
    PRAGMA user_version = 13;
  `);
}

test("v14 expands the activity currency constraint without changing any v13 ledger rows", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    await seedV13Payments(connection);
    const tables = ["activities", "members", "activity_members", "financial_events", "expenses", "expense_allocations",
      "merchant_payments", "merchant_refunds", "refund_reductions", "member_transfers", "expense_revisions",
      "expense_revision_allocations", "expense_revision_payments"];
    const snapshot = () => Promise.all(tables.map((name) => connection.getAllAsync(`SELECT * FROM ${name} ORDER BY rowid`)));
    const before = await snapshot();
    const database = await initializeDatabase(connection);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, expandedCurrencySchemaVersion);
    assert.equal((await connection.getFirstAsync("PRAGMA foreign_keys")).foreign_keys, 1);
    assert.equal(await connection.getFirstAsync("PRAGMA foreign_key_check"), null);
    const ledger = valueOf(await createFinanceRepository(database).getActivityLedger("trip"));
    assert.deepEqual(ledger.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [3000, -3000]);
    await assert.rejects(database.write((tx) => tx.execAsync(`
      UPDATE activities SET currency = 'CAD' WHERE id = 'trip';
    `)), /FOREIGN KEY constraint/);
    await assert.rejects(database.write((tx) => tx.execAsync(`
      INSERT INTO activities VALUES ('unsupported', 'Unsupported', 'EUR', 'active', 1, 1);
    `)), /CHECK constraint/);
  } finally {
    connection.close();
  }
}));

test("v14 rolls back the activity rebuild if the foreign key check fails", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    await seedV13Payments(connection);
    await connection.execAsync("PRAGMA foreign_keys = OFF; UPDATE merchant_payments SET member_id = 'missing' WHERE member_id = 'z';");
    const schema = () => connection.getFirstAsync("SELECT sql FROM sqlite_schema WHERE name = 'activities'");
    const before = await schema();
    await assert.rejects(initializeDatabase(connection), /Foreign key check failed after the currency migration/);
    assert.deepEqual(await schema(), before);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, multiPayerSchemaVersion);
    assert.equal((await connection.getFirstAsync("PRAGMA foreign_keys")).foreign_keys, 1);
    assert.equal((await connection.getFirstAsync("SELECT member_id FROM merchant_payments WHERE member_id = 'missing'")).member_id, "missing");
  } finally {
    connection.close();
  }
}));

test("Batch B migrates the S13 v11 index repair and preserves old single-payer revisions and cash flows", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    await seedLegacyPayments(connection, 11);
    assert.equal(valueOf(await validateStoredLedgers(connection, 11)), true);
    await connection.execAsync("DROP INDEX merchant_payments_single_payer");
    assert.equal((await inspectBackupDatabase(backupPlatform(path), connection, 11)).error?.code, "BACKUP_SCHEMA_MISMATCH");

    const database = await initializeDatabase(connection, connection.writeSnapshot);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
    const finance = createFinanceRepository(database);
    const [v1, v2] = valueOf(await finance.listExpenseRevisions("trip", "dinner"));
    assert.deepEqual([v1.expense.merchantPayment, v2.expense.merchantPayment], [
      { memberId: "z", currency: "HKD", amountMinor: 10_000 },
      { memberId: "z", currency: "HKD", amountMinor: 8000 },
    ]);
    assert.deepEqual([v2.id, v2.version, v2.expense.name], ["legacy-revision", 2, "Revised dinner"]);
    const ledger = valueOf(await finance.getActivityLedger("trip"));
    assert.deepEqual(ledger.events.slice(1).map(({ id, note }) => [id, note]),
      [["refund", "Refund receipt"], ["repayment", "FPS"]]);
    assert.deepEqual(ledger.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [4000, -4000]);

    const service = backupService(path);
    const { uri, manifest } = valueOf(await service.exportBackup(database));
    const preview = valueOf(await service.previewBackup(uri));
    assert.deepEqual([manifest.schemaVersion, preview.refundCount, preview.repaymentCount], [migrations.length, 1, 1]);
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), ledger);
  } finally {
    connection.close();
  }
}));

test("S13 v12 rolls back the index repair if a v11 expense has duplicate payers", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    await seedLegacyPayments(connection, 11);
    await connection.execAsync(`
      DROP INDEX merchant_payments_single_payer;
      INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'a', 1);
    `);
    const readPayments = () => connection.getAllAsync("SELECT * FROM merchant_payments ORDER BY member_id");
    const before = await readPayments();
    await assert.rejects(initializeDatabase(connection), (error) => error instanceof DatabaseInitializationError && error.stage === "migration");
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 11);
    assert.deepEqual(await readPayments(), before);
    assert.deepEqual(await connection.getFirstAsync("SELECT payer_id, paid_minor FROM expense_revisions"), { payer_id: "z", paid_minor: 8000 });
  } finally {
    connection.close();
  }
}));

test("Batch B rolls back the v13 revision table rebuild if migration cannot finish", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    await seedLegacyPayments(connection, 12);
    // An unexpected schema collision fails after the tables have been copied and the old index dropped.
    await connection.execAsync("CREATE INDEX merchant_payments_by_activity ON merchant_payments(member_id)");
    await assert.rejects(initializeDatabase(connection), (error) => error instanceof DatabaseInitializationError && error.stage === "migration");
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 12);
    assert.ok(await connection.getFirstAsync("SELECT name FROM sqlite_schema WHERE name = 'merchant_payments_single_payer'"));
    assert.equal(await connection.getFirstAsync("SELECT name FROM sqlite_schema WHERE name = 'expense_revision_payments'"), null);
    assert.deepEqual(await connection.getFirstAsync("SELECT payer_id, paid_minor FROM expense_revisions"), { payer_id: "z", paid_minor: 8000 });
    assert.equal(valueOf(await validateStoredLedgers(connection, 12)), true);
  } finally {
    connection.close();
  }
}));

test("snapshot and publishing failures leave the current ledger usable", withFinance(async (finance, _activities, database, _connection, _reopen, path) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const service = backupService(path);
  const publishFailure = await service.exportBackup(database, { destinationDirectoryUri: join(dirname(path), "missing") });
  assert.deepEqual([publishFailure.stage, publishFailure.error.code], ["publish", "BACKUP_EXPORT_FAILED"]);
  const snapshotFailure = await service.exportBackup({
    ...database,
    async backupSnapshot(directory) {
      writeFileSync(join(directory, backupSnapshotName), "partial snapshot");
      throw new Error("Snapshot failed");
    },
  });
  assert.deepEqual([snapshotFailure.stage, snapshotFailure.error.code], ["snapshot", "BACKUP_EXPORT_FAILED"]);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  valueOf(await finance.recordMemberTransfer("trip", 200, repayment));
  assert.equal(valueOf(await finance.getActivityLedger("trip")).events.length, 2);
}));

test("S13 refuses to export an inconsistent snapshot without altering the source", withFinance(async (finance, _activities, database, connection, _reopen, path) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  await database.write((tx) => tx.runAsync("UPDATE expense_allocations SET amount_minor = 4999 WHERE member_id = 'a'"));
  const original = await connection.getAllAsync("SELECT * FROM expense_allocations ORDER BY member_id");
  const result = await backupService(path).exportBackup(database);
  assert.deepEqual([result.stage, result.error?.code], ["validate", "BACKUP_LEDGER_INVALID"]);
  assert.deepEqual(await connection.getAllAsync("SELECT * FROM expense_allocations ORDER BY member_id"), original);
}));

test("S13 refuses to publish a truncated backup and can retry safely", withFinance(async (finance, _activities, database, _connection, _reopen, path) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const platform = backupPlatform(path);
  let published = false;
  const service = createBackupService({
    ...platform,
    createWorkspace() {
      const workspace = platform.createWorkspace();
      return {
        ...workspace,
        file(name) {
          const file = workspace.file(name);
          if (!name.endsWith(".splitmori-backup")) return file;
          return Object.assign(file, {
            open() {
              const handle = backupFile(file.uri).open("write");
              return { ...handle, writeBytes: (bytes) => handle.writeBytes(bytes.subarray(0, -1)) };
            },
          });
        },
      };
    },
    async publish() {
      published = true;
      throw new Error("Truncated output must never be published");
    },
  });
  const result = await service.exportBackup(database);
  assert.deepEqual([result.stage, result.error?.code], ["verify-output", "BACKUP_EXPORT_FAILED"]);
  assert.equal(published, false);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  const retry = createBackupService(platform);
  const exported = valueOf(await retry.exportBackup(database));
  assert.deepEqual(valueOf(await retry.previewBackup(exported.uri)).manifest, exported.manifest);
}));

test("S13 creates a new activity with the saved USD default and preserves the original HKD activity", withFinance(async (_finance, activities) => {
  const preferences = await createAppPreferencesStore({
    getItem: async () => JSON.stringify({ language: "en", defaultCurrency: "USD" }),
    setItem: async () => {},
  }).load();
  await activities.completeActivity("trip");
  const created = await activities.createActivity({
    id: "new-usd", name: "New activity", currency: preferences.defaultCurrency,
    members: [{ id: "new-member", displayName: "New member" }],
  });
  assert.equal(created.currency, "USD");
  assert.equal((await activities.getActivity("trip")).currency, "HKD");
}));

test("currency expansion persists all nine new activity currencies, quick records and formal expenses across reopening", withTestFile(async (path) => {
  const added = ["CAD", "AUD", "NZD", "MYR", "THB", "PHP", "KRW", "SGD", "VND"];
  let connection = openTestConnection(path);
  try {
    const database = await initializeDatabase(connection);
    const activities = createActivityRepository(database, () => true);
    const finance = createFinanceRepository(database, () => true);
    const quick = createQuickSplitRepository(database);
    for (const [index, currency] of added.entries()) {
      assert.deepEqual(searchCurrencies(currency), [currency]);
      const activity = await activities.createActivity({
        id: currency, name: currency, currency, members: [{ id: `${currency}-owner`, displayName: "Owner" }],
      });
      const editor = { ...createExpenseEditor(activity), finalTotal: "100", merchantPayerId: activity.members[0].id };
      const expense = valueOf(prepareNewExpense(`bill-${currency}`, "Dinner", editor));
      valueOf(await finance.createExpense(activity.id, 100, expense));
      const trial = { ...createQuickSplitEditor(currency), finalTotal: "100" };
      const draft = valueOf(await quick.saveQuickDraft(`draft-${currency}`, serializeQuickSplitDraft(trial), index + 1));
      assert.equal(hydrateQuickSplitDraft(draft.input).currency, currency);
      valueOf(await quick.saveQuickHistory(`quick-${currency}`, valueOf(calculateQuickSplitEditor(trial)).input));
    }
    connection.close();
    connection = openTestConnection(path);
    const reopened = await initializeDatabase(connection);
    const savedActivities = createActivityRepository(reopened);
    const savedFinance = createFinanceRepository(reopened);
    const savedQuick = createQuickSplitRepository(reopened);
    for (const currency of added) {
      const total = { currency, amountMinor: ["KRW", "VND"].includes(currency) ? 100 : 10_000 };
      assert.equal((await savedActivities.getActivity(currency)).currency, currency);
      assert.deepEqual(valueOf(await savedFinance.getExpense(currency, `bill-${currency}`)).expense.split.total, total);
      assert.deepEqual(valueOf(await savedQuick.getQuickHistory(`quick-${currency}`)).snapshot.split.total, total);
    }
    const latest = valueOf(await savedQuick.getQuickDraft());
    assert.deepEqual([latest.input.currency, hydrateQuickSplitDraft(latest.input).finalTotal], ["VND", "100"]);
  } finally {
    connection.close();
  }
}));

test("currency expansion applies the saved CAD default to new S02/S06 forms while an HKD draft keeps its currency and amount", withFinance(
  async (_finance, activities, database) => {
    let rawPreferences = null;
    const preferences = createAppPreferencesStore({
      getItem: async () => rawPreferences,
      setItem: async (_key, value) => { rawPreferences = value; },
    });
    const quick = createQuickSplitRepository(database);
    const oldEditor = { ...createQuickSplitEditor((await preferences.load()).defaultCurrency), finalTotal: "560.00" };
    valueOf(await quick.saveQuickDraft("old", serializeQuickSplitDraft(oldEditor), 100));
    await preferences.save({ language: "en", defaultCurrency: "CAD" });
    const { defaultCurrency } = await preferences.load();
    await activities.completeActivity("trip");
    const created = await activities.createActivity({
      id: "canada", name: "Canada", currency: defaultCurrency, members: [{ id: "cad-member", displayName: "Member" }],
    });
    assert.equal(created.currency, "CAD");
    assert.equal((await activities.getActivity("trip")).currency, "HKD");
    const restored = hydrateQuickSplitDraft(valueOf(await quick.getQuickDraft()).input);
    assert.deepEqual([restored.currency, restored.finalTotal], ["HKD", "560.00"]);
    assert.equal(valueOf(await quick.clearQuickDraft()), true);
    assert.equal(createQuickSplitEditor(defaultCurrency).currency, "CAD");
  },
));

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
  assert.deepEqual([preview.current.refundCount, preview.current.repaymentCount], [0, 0]);
  assert.deepEqual([preview.backup.refundCount, preview.backup.repaymentCount], [1, 1]);
  assert.deepEqual([preview.difference.refundCount, preview.difference.repaymentCount], [1, 1]);
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
  const restoredSettlement = await loadActivitySettlement("trip", live);
  assert.equal(restoredSettlement.expenseCount, preview.backup.expenseCount);
  assert.equal(await loadActivitySettlement("old", live), null);
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
  // An empty ZIP with the backup extension still fails the SplitMori format check.
  writeFileSync(bad, Buffer.from("504b0506" + "00".repeat(18), "hex"));
  assert.deepEqual(await service.prepareRestore(pathToFileURL(bad).href), { status: "validation-failed", code: "INVALID_BACKUP_FORMAT" });
  const original = await exportSource();
  const { manifest, payload } = unpackBackup(original);
  writeBackup(bad, { ...manifest, schemaVersion: migrations.length + 1 }, payload);
  assert.deepEqual(await service.prepareRestore(pathToFileURL(bad).href),
    { status: "validation-failed", code: "UNSUPPORTED_BACKUP_VERSION" });
  const altered = join(directory, "missing-index.sqlite");
  writeFileSync(altered, payload);
  const malformed = openTestConnection(altered);
  try {
    await malformed.execAsync("DROP INDEX merchant_payments_by_activity");
  } finally {
    malformed.close();
  }
  const malformedPayload = readFileSync(altered);
  writeBackup(bad, { ...manifest, byteLength: malformedPayload.length, sha256: sha256(malformedPayload) }, malformedPayload);
  assert.deepEqual(await service.prepareRestore(pathToFileURL(bad).href),
    { status: "validation-failed", code: "BACKUP_SCHEMA_MISMATCH" });
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
  assert.deepEqual(await service.restoreBackup({ confirmation: {}, confirmed: true }),
    { status: "validation-failed", code: "INVALID_CONFIRMATION" });
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
    const detail = await loadActivityDetail("trip", database);
    assert.deepEqual(detail.expenses.map(({ name, effectiveMinor }) => [name, effectiveMinor]), [["費用 1", 8000]]);
    assert.equal((await connection.getFirstAsync("SELECT name FROM expenses WHERE id = 'dinner'")).name, null);
    assert.equal(valueOf(await validateStoredLedgers(connection, migrations.length)), true);
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

test("S12 Pro creates and reopens concurrent activities; downgrade protects expenses and preserves existing history", withFinance(
  async (finance, _activities, database) => {
    let pro = true;
    const hasProAccess = () => pro;
    const activities = createActivityRepository(database, hasProAccess);
    const entitledFinance = createFinanceRepository(database, hasProAccess);
    const another = { id: "second", name: "Second", currency: "HKD", members: [{ id: "new", displayName: "New" }] };
    await activities.createActivity(another);
    await activities.completeActivity(another.id);
    assert.equal((await activities.reopenActivity(another.id)).status, "active");
    assert.equal(await activities.getCreationBlocker(), null);
    valueOf(await entitledFinance.createExpense("trip", 100, expense()));
    const request = correction(8000);
    const preview = valueOf(await entitledFinance.previewExpenseCorrection("trip", "dinner", request.proposed, 1));
    const before = valueOf(await finance.getActivityLedger("trip"));
    pro = false;
    await assert.rejects(activities.createActivity({ ...another, id: "third" }), ActiveActivityLimitError);
    assert.equal((await entitledFinance.createExpense("trip", 110, expense("late"))).error.code, "EXPENSE_EDIT_LIMIT");
    assert.equal((await entitledFinance.commitReviewedExpenseCorrection("trip", {
      ...request, expectedLedger: preview.ledgerToken,
    })).error.code, "EXPENSE_EDIT_LIMIT");
    valueOf(await createQuickSplitRepository(database).saveQuickHistory("history", quickInput()));
    const conversions = createQuickSplitConversionService(database, hasProAccess);
    assert.equal((await conversions.convertQuickHistory(conversionRequest())).error.code, "EXPENSE_EDIT_LIMIT");
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
    valueOf(await finance.recordMemberTransfer("trip", 120, repayment));
    await activities.completeActivity(another.id);
    await assert.rejects(activities.reopenActivity(another.id), ActiveActivityLimitError);
    valueOf(await conversions.convertQuickHistory(conversionRequest()));
    assert.equal((await activities.listActivities()).length, 2);
  },
));

test("S12 restoring a multi-activity backup preserves the ledger without granting the destination Pro", withRestore(async ({
  source, live, activities, finance, service, exportSource, prepare,
}) => {
  await createActivityRepository(source, () => true).createActivity({
    id: "another", name: "Another", currency: "HKD", members: [{ id: "new", displayName: "New" }],
  });
  valueOf(await createFinanceRepository(source, () => true).createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  const entitlement = createProEntitlement({
    readEntitlement: async () => "free", subscribe: () => () => {},
  }, "test.lifetime-pro", { load: async () => true, save: async () => {} });
  const preview = await prepare(await exportSource());
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }), { status: "restored" });
  entitlement.start();
  await entitlement.refresh();
  assert.equal(entitlement.hasProAccess(), false);
  assert.equal((await activities.getCreationBlocker()).activeCount, 2);
  assert.deepEqual(valueOf(await createFinanceRepository(live).getActivityLedger("trip")), before);
  assert.equal((await createFinanceRepository(live, entitlement.hasProAccess)
    .createExpense("trip", 200, expense("new-expense"))).error.code, "EXPENSE_EDIT_LIMIT");
}));

test("batch members persist after reopening and leave two original expenses and balances intact", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    let database = await initializeDatabase(connection);
    const activities = createActivityRepository(database);
    let finance = createFinanceRepository(database);
    await activities.createActivity({
      id: "trip", name: "旅行", currency: "HKD", members: [{ id: "z", displayName: "a" }, { id: "a", displayName: "b" }],
    });
    valueOf(await finance.createExpense("trip", 100, expense("first", 56_000)));
    valueOf(await finance.createExpense("trip", 200, expense("second", 56_000)));
    const original = valueOf(await finance.getActivityLedger("trip"));
    const batch = [{ id: "c", displayName: " c " }, { id: "d", displayName: "d" }];
    const added = await activities.addMembers("trip", batch);
    assert.deepEqual(added.map(({ id, displayName, position }) => [id, displayName, position]), [["c", "c", 2], ["d", "d", 3]]);
    const ledger = valueOf(await finance.getActivityLedger("trip"));
    assert.deepEqual(ledger.events, original.events);
    assert.deepEqual(ledger.revisions, original.revisions);
    assert.deepEqual(ledger.suggestions, original.suggestions);
    assert.deepEqual(ledger.balanceSnapshot.balances.slice(0, 2), original.balanceSnapshot.balances);
    assert.deepEqual(ledger.balanceSnapshot.balances.map(({ memberId, netBalanceMinor }) => [memberId, netBalanceMinor]),
      [["z", 56_000], ["a", -56_000], ["c", 0], ["d", 0]]);
    const detail = await loadActivityDetail("trip", database);
    assert.deepEqual([detail.grossMinor, detail.effectiveMinor], [112_000n, 112_000n]);
    assert.equal((await loadActivityList(database))[0].memberCount, 4);

    connection.close();
    connection = openTestConnection(path);
    database = await initializeDatabase(connection);
    finance = createFinanceRepository(database);
    assert.deepEqual((await createActivityRepository(database).getActivity("trip")).members.slice(2), added);
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), ledger);
  } finally {
    connection.close();
  }
}));

test("member batches roll back completely and concurrent retries reuse the same stable IDs", withFinance(async (_finance, activities, database, connection) => {
  const batch = [{ id: "c", displayName: "同名" }, { id: "d", displayName: "同名" }];
  await database.write((transaction) => transaction.execAsync(`
    CREATE TRIGGER reject_second_member BEFORE INSERT ON members WHEN NEW.id = 'd'
    BEGIN SELECT RAISE(ABORT, 'member write failure'); END;
  `));
  await assert.rejects(activities.addMembers("trip", batch), /member write failure/);
  assert.equal((await activities.listMembers("trip")).length, 2);
  assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS count FROM members WHERE id IN ('c', 'd')")).count, 0);
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_second_member"));
  const [first, retry] = await Promise.all([activities.addMembers("trip", batch), activities.addMembers("trip", batch)]);
  assert.deepEqual(first, retry);
  assert.equal((await activities.listMembers("trip")).length, 4);
  const conflict = (error) => error instanceof MemberManagementError && error.code === "MEMBER_CONFLICT";
  await assert.rejects(activities.addMembers("trip", [batch[0], { ...batch[1], displayName: "變更名稱" }]), conflict);
  await assert.rejects(activities.addMembers("trip", [batch[0], { id: "e", displayName: "e" }]), conflict);
  for (const invalid of ["   ", "名".repeat(memberNameMaxLength + 1)]) {
    await assert.rejects(activities.addMembers("trip", [{ id: "e", displayName: invalid }]),
      (error) => error instanceof MemberManagementError && error.code === "INVALID_MEMBER_NAME");
  }
  assert.equal(await connection.getFirstAsync("SELECT id FROM members WHERE id = 'e'"), null);
  assert.equal((await activities.listMembers("trip")).length, 4);
}));

test("completed activity state is checked inside member write transactions", withFinance(async (_finance, activities, _database, connection) => {
  const before = await activities.listMembers("trip");
  const [completed, added] = await Promise.allSettled([
    activities.completeActivity("trip"), activities.addMembers("trip", [{ id: "c", displayName: "c" }]),
  ]);
  assert.equal(completed.status, "fulfilled");
  assert.equal(added.status, "rejected");
  assert.equal(added.reason.code, "ACTIVITY_COMPLETED");
  await assert.rejects(activities.addMember("trip", { id: "d", displayName: "d" }),
    (error) => error.code === "ACTIVITY_COMPLETED");
  await assert.rejects(activities.renameMember("trip", "z", "更名"),
    (error) => error.code === "ACTIVITY_COMPLETED");
  assert.deepEqual(await activities.listMembers("trip"), before);
  assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS count FROM members WHERE id IN ('c', 'd')")).count, 0);
}));

test("member rename and additions preserve refunds repayments revisions voids and all original balances", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMerchantRefund("trip", 200, refund));
  valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 3000 }));
  valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));
  valueOf(await finance.voidMemberTransfer("trip", { id: "void", targetEventId: repayment.id, occurredAt: 400 }));
  const original = valueOf(await finance.getActivityLedger("trip"));
  const members = await activities.listMembers("trip");
  const renamed = await activities.renameMember("trip", "z", " 阿明 ");
  assert.deepEqual(renamed, { ...members[0], displayName: "阿明" });
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), original);
  assert.deepEqual((await loadActivityDetail("trip", database)).expenses.map(({ payerName }) => payerName), ["阿明"]);
  await activities.addMembers("trip", [{ id: "c", displayName: "阿明" }, { id: "d", displayName: "d" }]);
  const ledger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(ledger.events, original.events);
  assert.deepEqual(ledger.revisions, original.revisions);
  assert.deepEqual(ledger.balanceSnapshot.balances.slice(0, 2), original.balanceSnapshot.balances);
  assert.deepEqual(ledger.balanceSnapshot.balances.slice(2).map(({ netBalanceMinor }) => netBalanceMinor), [0, 0]);
  const management = await loadActivityMembers("trip", database);
  assert.deepEqual(management.members.map(({ id, hasHistory }) => [id, hasHistory]), [["z", true], ["a", true], ["c", false], ["d", false]]);
  await assert.rejects(activities.renameMember("trip", "missing", "名稱"), (error) => error.code === "MEMBER_NOT_FOUND");
}));

test("renaming a shared member cannot change another activity's display name", withFinance(async (_finance, activities, database) => {
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "other", name: "另一活動", currency: "HKD", members: [{ id: "other", displayName: "Alex" }] });
  await database.write((transaction) => transaction.runAsync(
    "INSERT INTO activity_members (activity_id, member_id, position) VALUES ('other', 'z', 1)",
  ));
  await activities.completeActivity("other");
  await activities.reopenActivity("trip");
  assert.equal((await loadActivityMembers("trip", database)).members.find(({ id }) => id === "z").shared, true);
  await assert.rejects(activities.renameMember("trip", "z", "更名"), (error) => error.code === "SHARED_MEMBER");
  assert.equal((await activities.getActivity("other")).members.find(({ id }) => id === "z").displayName, "Alex");
  await activities.renameMember("trip", "a", "新名稱");
  assert.equal((await activities.getActivity("other")).members.find(({ id }) => id === "other").displayName, "Alex");
}));

test("adding members makes an existing four-person quick history eligible without changing its shares", withFinance(async (finance, activities, database) => {
  const input = {
    members: ["w", "x", "y", "v"].map((id) => ({ id, displayName: id })),
    charges: { kind: "finalTotal", total: { currency: "HKD", amountMinor: 10_001 } },
    method: { kind: "equal", memberIds: ["w", "x", "y", "v"] },
  };
  const quick = createQuickSplitRepository(database);
  const history = valueOf(await quick.saveQuickHistory("four", input));
  const conversions = createQuickSplitConversionService(database);
  assert.equal((await conversions.listTargets("HKD")).some((target) => canSelectConversionTarget(target, history)), false);
  await activities.addMembers("trip", [{ id: "c", displayName: "c" }, { id: "d", displayName: "d" }]);
  assert.equal((await conversions.listTargets("HKD")).some((target) => canSelectConversionTarget(target, history)), true);
  const mappings = ["z", "a", "c", "d"];
  const request = {
    requestId: "four-members", historyId: "four", activityId: "trip", expenseName: "四人費用", occurredAt: 100,
    memberMapping: input.members.map(({ id }, index) => ({ quickMemberId: id, activityMemberId: mappings[index] })),
    merchantPayment: { memberId: "z", ...history.snapshot.split.total },
  };
  const saved = valueOf(await conversions.convertQuickHistory(request));
  const sourceAmounts = new Map(history.snapshot.split.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  const targetAmounts = new Map(saved.event.expense.split.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]));
  for (const { quickMemberId, activityMemberId } of request.memberMapping) {
    assert.equal(targetAmounts.get(activityMemberId), sourceAmounts.get(quickMemberId));
  }
  assert.deepEqual(valueOf(await quick.getQuickHistory("four")), history);
  assert.equal(valueOf(await finance.getActivityLedger("trip")).events.length, 1);
}));

test("S09 reads the four-person ledger and stays unsettled when an activity is completed", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense("first", 56_000)));
  valueOf(await finance.createExpense("trip", 200, expense("second", 56_000)));
  await activities.addMembers("trip", [{ id: "chris", displayName: "Chris" }, { id: "d", displayName: "d" }]);
  const open = await loadActivitySettlement("trip", database);
  assert.equal(open.activity.status, "active");
  assert.equal(open.status, "unsettled");
  assert.deepEqual([open.expenseCount, open.effectiveMinor, open.outstandingMinor, open.refundMinor, open.repaymentMinor],
    [2, 112_000n, 56_000n, 0n, 0n]);
  assert.deepEqual(open.members.map(({ memberId, merchantPaidMinor, allocatedMinor, netBalanceMinor }) =>
    [memberId, merchantPaidMinor, allocatedMinor, netBalanceMinor]), [
    ["z", 112_000, 56_000, 56_000], ["a", 0, 56_000, -56_000], ["chris", 0, 0, 0], ["d", 0, 0, 0],
  ]);
  assert.deepEqual(open.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 56_000 }]);

  await activities.completeActivity("trip");
  const completed = await loadActivitySettlement("trip", database);
  assert.equal(completed.activity.status, "completed");
  assert.equal(completed.status, "unsettled");
  assert.equal(completed.outstandingMinor, open.outstandingMinor);
  assert.deepEqual(completed.suggestions, open.suggestions);
}));

test("S09 separates partial and full repayments from expenses and ignores voided repayments", withFinance(async (finance, _activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, amountMinor: 2000 }));
  const partial = await loadActivitySettlement("trip", database);
  assert.equal(partial.status, "unsettled");
  assert.deepEqual([partial.effectiveMinor, partial.repaymentMinor, partial.outstandingMinor], [10_000n, 2000n, 3000n]);
  assert.deepEqual(partial.members.map(({ transferSentMinor, transferReceivedMinor }) => [transferSentMinor, transferReceivedMinor]),
    [[0, 2000], [2000, 0]]);
  assert.deepEqual(partial.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 3000 }]);

  valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, id: "remainder", amountMinor: 3000 }));
  const settled = await loadActivitySettlement("trip", database);
  assert.equal(settled.activity.status, "active");
  assert.equal(settled.status, "settled");
  assert.deepEqual([settled.effectiveMinor, settled.repaymentMinor, settled.outstandingMinor], [10_000n, 5000n, 0n]);
  assert.deepEqual(settled.members.map(({ netBalanceMinor }) => netBalanceMinor), [0, 0]);
  assert.deepEqual(settled.suggestions, []);
  assert.deepEqual(settled.repayments.map(({ id }) => id), ["remainder", repayment.id]);

  valueOf(await finance.voidMemberTransfer("trip", { id: "void-first", targetEventId: repayment.id, occurredAt: 400 }));
  const reopenedBalance = await loadActivitySettlement("trip", database);
  assert.equal(reopenedBalance.status, "unsettled");
  assert.deepEqual([reopenedBalance.effectiveMinor, reopenedBalance.repaymentMinor, reopenedBalance.outstandingMinor],
    [10_000n, 3000n, 2000n]);
  assert.deepEqual(reopenedBalance.repayments.map(({ id }) => id), ["remainder"]);
  assert.deepEqual(reopenedBalance.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 2000 }]);
}));

test("S09 uses revised expenses and effective refunds, including a different refund recipient", withFinance(async (finance, _activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  valueOf(await finance.commitExpenseCorrection("trip", correction(8000, { reviewedRefundIds: [refund.id] })));
  const revised = await loadActivitySettlement("trip", database);
  assert.deepEqual([revised.expenseCount, revised.effectiveMinor, revised.refundMinor, revised.outstandingMinor],
    [1, 6000n, 2000n, 5000n]);
  assert.deepEqual(revised.members.map(({ merchantPaidMinor, merchantRefundReceivedMinor, allocatedMinor, netBalanceMinor }) =>
    [merchantPaidMinor, merchantRefundReceivedMinor, allocatedMinor, netBalanceMinor]), [
    [8000, 0, 3000, 5000], [0, 2000, 3000, -5000],
  ]);
  assert.deepEqual(revised.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 5000 }]);
  const detail = await loadActivityDetail("trip", database);
  assert.deepEqual([detail.effectiveMinor, detail.refundMinor, detail.outstandingMinor],
    [revised.effectiveMinor, revised.refundMinor, revised.outstandingMinor]);

  valueOf(await finance.voidMerchantRefund("trip", { id: "void-refund", targetEventId: refund.id, occurredAt: 400 }));
  const voided = await loadActivitySettlement("trip", database);
  assert.deepEqual([voided.effectiveMinor, voided.refundMinor, voided.outstandingMinor], [8000n, 0n, 4000n]);
  assert.deepEqual(voided.members.map(({ merchantRefundReceivedMinor }) => merchantRefundReceivedMinor), [0, 0]);
}));

test("S09 distinguishes an empty activity from a zero-yen expense with zero balances", withFinance(async (finance, activities, database) => {
  const empty = await loadActivitySettlement("trip", database);
  assert.equal(empty.status, "empty");
  assert.deepEqual([empty.expenseCount, empty.effectiveMinor, empty.outstandingMinor], [0, 0n, 0n]);
  assert.deepEqual(empty.members.map(({ memberId, netBalanceMinor }) => [memberId, netBalanceMinor]), [["z", 0], ["a", 0]]);
  assert.deepEqual(empty.suggestions, []);
  assert.equal(await loadActivitySettlement("missing", database), null);

  await activities.completeActivity("trip");
  await activities.createActivity({ id: "yen", name: "東京", currency: "JPY", members: [{ id: "j", displayName: "J" }] });
  const total = { currency: "JPY", amountMinor: 0 };
  valueOf(await finance.createExpense("yen", 100, {
    id: "zero", split: valueOf(splitEqual(total, ["j"])), merchantPayment: { memberId: "j", ...total },
    splitMode: "equal", allocationVersion: 1,
  }));
  const zero = await loadActivitySettlement("yen", database);
  assert.equal(zero.activity.currency, "JPY");
  assert.equal(zero.status, "settled");
  assert.deepEqual([zero.expenseCount, zero.effectiveMinor, zero.outstandingMinor, zero.repaymentMinor], [1, 0n, 0n, 0n]);
  assert.deepEqual(zero.suggestions, []);
}));

test("S10 records partial and full repayments on a completed activity and reloads S09", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense("first", 56_000)));
  valueOf(await finance.createExpense("trip", 150, expense("second", 56_000)));
  await activities.addMembers("trip", [{ id: "c", displayName: "Chris" }, { id: "d", displayName: "d" }]);
  await activities.completeActivity("trip");
  const before = await loadActivitySettlement("trip", database);
  const expenses = valueOf(await finance.listExpenses("trip"));
  assert.equal(before.outstandingMinor, 56_000n);

  const first = valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, amountMinor: 20_000, note: "FPS" }, {
    fromNetBalanceMinor: -56_000, toNetBalanceMinor: 56_000,
  }));
  assert.equal(first.kind, "memberTransfer");
  assert.equal(first.note, "FPS");
  const partial = await loadActivitySettlement("trip", database);
  assert.deepEqual([partial.activity.status, partial.expenseCount, partial.effectiveMinor, partial.repaymentMinor, partial.outstandingMinor],
    ["completed", 2, 112_000n, 20_000n, 36_000n]);
  assert.deepEqual(partial.members.map(({ netBalanceMinor }) => netBalanceMinor), [36_000, -36_000, 0, 0]);
  assert.deepEqual(partial.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 36_000 }]);

  valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, id: "remaining", amountMinor: 36_000 }, {
    fromNetBalanceMinor: -36_000, toNetBalanceMinor: 36_000,
  }));
  const settled = await loadActivitySettlement("trip", database);
  assert.deepEqual([settled.activity.status, settled.status, settled.effectiveMinor, settled.repaymentMinor, settled.outstandingMinor],
    ["completed", "settled", 112_000n, 56_000n, 0n]);
  assert.deepEqual(settled.suggestions, []);
  assert.deepEqual(valueOf(await finance.listExpenses("trip")), expenses);
}));

test("S10 serializes confirmations, rejects stale balances, and reuses the ID of the same event", withFinance(async (finance) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const expected = { fromNetBalanceMinor: -5000, toNetBalanceMinor: 5000 };
  const transfer = { ...repayment, amountMinor: 1000, note: " 現金 " };
  const separate = { ...transfer, id: "second-transfer" };
  const [first, stale] = await Promise.all([
    finance.recordMemberTransfer("trip", 200, transfer, expected),
    finance.recordMemberTransfer("trip", 200, separate, expected),
  ]);
  assert.equal(valueOf(first).note, "現金");
  assert.deepEqual(stale.error, { code: "TRANSFER_BALANCES_CHANGED", field: "memberTransfer" });
  const revised = { fromNetBalanceMinor: -4000, toNetBalanceMinor: 4000 };
  assert.deepEqual(valueOf(await finance.recordMemberTransfer("trip", 200, transfer, revised)), first.value);
  assert.equal((await finance.recordMemberTransfer("trip", 200, { ...transfer, note: "FPS" }, revised)).error.code, "EVENT_ID_CONFLICT");
  const second = valueOf(await finance.recordMemberTransfer("trip", 200, separate, revised));
  assert.notEqual(second.id, first.value.id);
  assert.deepEqual(valueOf(await finance.listEvents("trip")).filter(({ kind }) => kind === "memberTransfer"), [first.value, second]);
}));

test("S10 rejects invalid and backdated repayments without writing any event", withFinance(async (finance) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.listEvents("trip"));
  const expected = { fromNetBalanceMinor: -5000, toNetBalanceMinor: 5000 };
  for (const [transfer, occurredAt, code] of [
    [{ ...repayment, amountMinor: 5001 }, 200, "TRANSFER_EXCEEDS_BALANCE"],
    [{ ...repayment, amountMinor: 0 }, 200, "NON_POSITIVE_AMOUNT"],
    [{ ...repayment, toMemberId: repayment.fromMemberId }, 200, "SELF_TRANSFER"],
    [{ ...repayment, toMemberId: "outsider" }, 200, "MEMBER_NOT_PARTICIPATING"],
    [repayment, Date.now() + 86_400_000, "INVALID_EVENT_TIME"],
    [repayment, 99, "TRANSFER_DATE_CONFLICT"],
  ]) {
    assert.equal((await finance.recordMemberTransfer("trip", occurredAt, transfer, expected)).error.code, code);
  }
  assert.deepEqual(valueOf(await finance.listEvents("trip")), before);

  valueOf(await finance.recordMerchantRefund("trip", 300, { ...refund, amountMinor: 10_000,
    reductions: [{ memberId: "z", amountMinor: 5000 }, { memberId: "a", amountMinor: 5000 }],
  }));
  const afterRefund = valueOf(await finance.listEvents("trip"));
  // The old date had a payable balance. The full refund has since settled it.
  assert.equal((await finance.recordMemberTransfer("trip", 200, repayment)).error.code, "TRANSFER_EXCEEDS_BALANCE");
  assert.deepEqual(valueOf(await finance.listEvents("trip")), afterRefund);
}));

test("S10 rolls back the financial event if the transfer row fails and can retry the same ID", withFinance(async (finance, _activities, database, connection) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const before = valueOf(await finance.getActivityLedger("trip"));
  await database.write((transaction) => transaction.execAsync(`
    CREATE TRIGGER reject_transfer BEFORE INSERT ON member_transfers
    BEGIN SELECT RAISE(ABORT, 'test transfer write failure'); END;
  `));
  const transfer = { ...repayment, note: "FPS" };
  assert.equal((await finance.recordMemberTransfer("trip", 200, transfer)).error.code, "FINANCE_STORAGE_ERROR");
  assert.equal(await connection.getFirstAsync("SELECT id FROM financial_events WHERE id = ?", transfer.id), null);
  assert.equal(await connection.getFirstAsync("SELECT id FROM member_transfers WHERE id = ?", transfer.id), null);
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
  await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_transfer"));
  const saved = valueOf(await finance.recordMemberTransfer("trip", 200, transfer));
  assert.equal(saved.note, "FPS");
  assert.deepEqual(valueOf(await finance.listEvents("trip")).filter(({ kind }) => kind === "memberTransfer"), [saved]);
}));

test("v8 preserves v7 repayments and persists notes across reopening", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    for (const sql of migrations.slice(0, 7)) await connection.execAsync(sql);
    await connection.execAsync(`
      INSERT INTO activities VALUES ('trip', 'Trip', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('z', 'Alex', 1), ('a', 'Bo', 1);
      INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1);
      INSERT INTO financial_events VALUES (1, 'dinner', 'trip', 'expense', 100), (2, 'old', 'trip', 'memberTransfer', 200);
      INSERT INTO expenses (id, activity_id, currency, amount_minor, split_mode, allocation_version)
        VALUES ('dinner', 'trip', 'HKD', 10000, 'equal', 1);
      INSERT INTO expense_allocations VALUES ('trip', 'dinner', 'z', 5000, 0), ('trip', 'dinner', 'a', 5000, 1);
      INSERT INTO merchant_payments VALUES ('trip', 'dinner', 'z', 10000);
      INSERT INTO member_transfers VALUES ('old', 'trip', 'a', 'z', 1000);
      PRAGMA user_version = 7;
    `);
    assert.equal(valueOf(await inspectBackupDatabase(backupPlatform(path), connection, 7)).repaymentCount, 1);
    let database = await initializeDatabase(connection);
    const finance = createFinanceRepository(database);
    const legacy = valueOf(await finance.listEvents("trip")).find(({ id }) => id === "old");
    assert.equal(legacy.note, undefined);
    const transfer = valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, amountMinor: 2000, note: "現金分帳" }));
    connection.close();
    connection = openTestConnection(path);
    database = await initializeDatabase(connection);
    const settlement = await loadActivitySettlement("trip", database);
    assert.deepEqual(settlement.repayments, [transfer, legacy]);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
  } finally {
    connection.close();
  }
}));

test("S10 form uses local dates and rejects zero, negative and fractional yen amounts", withFinance(async (finance, activities, database) => {
  await activities.completeActivity("trip");
  await activities.createActivity({ id: "yen", name: "東京", currency: "JPY", members: [{ id: "payer", displayName: "P" }, { id: "debtor", displayName: "D" }] });
  const total = { currency: "JPY", amountMinor: 1000 };
  valueOf(await finance.createExpense("yen", 100, {
    id: "yen-expense", split: valueOf(splitEqual(total, ["payer", "debtor"])),
    merchantPayment: { memberId: "payer", ...total }, splitMode: "equal", allocationVersion: 1,
  }));
  const data = await loadActivitySettlement("yen", database);
  const now = new Date(2026, 10, 8, 19, 30);
  const draft = { fromMemberId: "debtor", toMemberId: "payer", amount: "200", date: expenseDateInput(now), note: " 現金 " };
  const { prepared, limit } = inspectRepaymentDraft(draft, data, now);
  assert.equal(limit, 500);
  assert.equal(prepared.occurredAt, now.getTime());
  assert.deepEqual(prepared.transfer, { currency: "JPY", amountMinor: 200, fromMemberId: "debtor", toMemberId: "payer", note: "現金" });
  const historical = inspectRepaymentDraft({ ...draft, date: "2026-11-07" }, data, now);
  assert.equal(expenseDateInput(new Date(historical.prepared.occurredAt)), "2026-11-07");
  assert.equal(inspectRepaymentDraft({ ...draft, date: "2026-11-09" }, data, now).errors.date, "INVALID_EVENT_TIME");
  for (const [amount, code] of [["0", "NON_POSITIVE_AMOUNT"], ["-1", "NEGATIVE_AMOUNT"], ["200.5", "INVALID_AMOUNT_PRECISION"], ["501", "TRANSFER_EXCEEDS_BALANCE"]]) {
    assert.equal(inspectRepaymentDraft({ ...draft, amount }, data, now).errors.amount, code);
  }
}));

test("S09 retains both historical repayments and refreshes a completed activity after voiding the earlier one", withFinance(
  async (finance, activities, database, _connection, reopen) => {
    const expenses = [
      valueOf(await finance.createExpense("trip", 100, expense("first", 56_000))),
      valueOf(await finance.createExpense("trip", 200, expense("second", 56_000))),
    ];
    await activities.addMembers("trip", [{ id: "chris", displayName: "Chris" }, { id: "d", displayName: "d" }]);
    await activities.completeActivity("trip");
    const first = valueOf(await finance.recordMemberTransfer("trip", 300,
      { ...repayment, amountMinor: 20_000, note: "第一次還款" }));
    const second = valueOf(await finance.recordMemberTransfer("trip", 300,
      { ...repayment, id: "remainder", amountMinor: 36_000, note: "第二次還款" }));
    const before = await loadActivitySettlement("trip", database);
    assert.equal(before.status, "settled");
    assert.equal(before.repaymentMinor, 56_000n);
    assert.deepEqual(before.repaymentHistory.map(({ transfer }) => transfer), [second, first]);
    assert.deepEqual(before.suggestions, []);

    const request = { id: "void-first", targetEventId: first.id, occurredAt: 400, reason: "誤記" };
    const preview = valueOf(await finance.previewMemberTransferVoid("trip", request));
    assert.deepEqual(preview.balanceSnapshot.balances.map(({ netBalanceMinor, transferSentMinor }) =>
      [netBalanceMinor, transferSentMinor]), [[20_000, 0], [-20_000, 36_000], [0, 0], [0, 0]]);
    assert.deepEqual(valueOf(await finance.listEvents("trip")), [...expenses, first, second]);

    const saved = valueOf(await finance.voidMemberTransfer("trip", request, preview.expectedSequence));
    const after = await loadActivitySettlement("trip", database);
    assert.equal(after.activity.status, "completed");
    assert.equal(after.status, "unsettled");
    assert.deepEqual([after.expenseCount, after.effectiveMinor, after.repaymentMinor, after.voidedRepaymentMinor, after.outstandingMinor],
      [2, 112_000n, 36_000n, 20_000n, 20_000n]);
    assert.deepEqual(after.repaymentHistory, [{ transfer: second, voidEvent: undefined }, { transfer: first, voidEvent: saved }]);
    assert.deepEqual(after.suggestions, [{ fromMemberId: "a", toMemberId: "z", currency: "HKD", amountMinor: 20_000 }]);
    assert.deepEqual((await finance.voidMemberTransfer("trip", { ...request, id: "duplicate" }, preview.expectedSequence)).error,
      { code: "EVENT_ALREADY_VOIDED", field: "targetEventId" });

    const reopened = await reopen();
    assert.deepEqual(valueOf(await reopened.listEvents("trip")), [...expenses, first, second, saved]);
    assert.deepEqual(valueOf(await reopened.voidMemberTransfer("trip", request, preview.expectedSequence)), saved);
  },
));

test("a backdated repayment invalidates an older void preview without changing the current ledger", withFinance(async (finance) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const target = valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, amountMinor: 1000 }));
  const request = { id: "reviewed-void", targetEventId: target.id, occurredAt: 400 };
  const firstPreview = valueOf(await finance.previewMemberTransferVoid("trip", request));

  valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, id: "backdated", amountMinor: 500 }));
  const before = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual((await finance.voidMemberTransfer("trip", request, firstPreview.expectedSequence)).error,
    { code: "VOID_LEDGER_CHANGED", field: "events" });
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);

  const nextPreview = valueOf(await finance.previewMemberTransferVoid("trip", request));
  const saved = valueOf(await finance.voidMemberTransfer("trip", request, nextPreview.expectedSequence));
  assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).balanceSnapshot, nextPreview.balanceSnapshot);
  assert.deepEqual(valueOf(await finance.voidMemberTransfer("trip", request, firstPreview.expectedSequence)), saved);
}));

test("a failed repayment void rolls back the audit insert and allows retrying the same request", withFinance(
  async (finance, _activities, database, connection) => {
    valueOf(await finance.createExpense("trip", 100, expense()));
    valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, note: "現金" }));
    const before = await loadActivitySettlement("trip", database);
    const request = { id: "void-rollback", targetEventId: repayment.id, occurredAt: 300 };
    const preview = valueOf(await finance.previewMemberTransferVoid("trip", request));
    await database.write((transaction) => transaction.execAsync(`
      CREATE TRIGGER reject_repayment_void AFTER INSERT ON financial_voids
      BEGIN SELECT RAISE(FAIL, 'test repayment void failure'); END;
    `));

    assert.deepEqual((await finance.voidMemberTransfer("trip", request, preview.expectedSequence)).error,
      { code: "FINANCE_STORAGE_ERROR", field: "storage" });
    assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS count FROM financial_voids")).count, 0);
    assert.deepEqual(await loadActivitySettlement("trip", database), before);

    await database.write((transaction) => transaction.execAsync("DROP TRIGGER reject_repayment_void"));
    const saved = valueOf(await finance.voidMemberTransfer("trip", request, preview.expectedSequence));
    const after = await loadActivitySettlement("trip", database);
    assert.deepEqual(after.repaymentHistory, [{ transfer: before.repayments[0], voidEvent: saved }]);
    assert.equal(after.repaymentMinor, 0n);
    assert.equal(after.outstandingMinor, 5000n);
  },
));

test("3B7A previews a two-to-four-person split, persists bill metadata and preserves the original expense", withFinance(
  async (finance, activities, database, _connection, reopen) => {
    const activity = await activities.getActivity("trip");
    const editor = { ...createExpenseEditor(activity), merchantPayerId: "z", finalTotal: "560.00",
      chargeMode: "details", subtotal: "500.00", serviceFeeMode: "manual", serviceFee: "60.00" };
    const original = valueOf(await finance.createExpense("trip", 100, valueOf(prepareNewExpense("dinner", "晚餐", editor))));
    valueOf(await finance.createExpense("trip", 200, { ...expense("lunch", 56_000), name: "午餐" }));
    await activities.addMembers("trip", [{ id: "chris", displayName: "Chris" }, { id: "d", displayName: "d" }]);

    const detail = await loadExpenseDetail("trip", "dinner", database);
    const initial = hydrateExpenseEditor(detail.activity, detail.expense);
    assert.deepEqual([initial.chargeMode, initial.subtotal, initial.serviceFee], ["details", "500.00", "60.00"]);
    assert.deepEqual(initial.members.map(({ included }) => included), [true, true, false, false]);
    const draft = { ...initial, members: initial.members.map((member) => ({ ...member, included: true })) };
    const proposed = valueOf(prepareExpenseEdit(detail.expense, initial, draft, "旅程晚餐", 50));
    const preview = valueOf(await loadExpenseCorrectionPreview("trip", proposed, detail.currentVersion, database));
    assert.deepEqual(preview.expense.after.split.allocations.map(({ amountMinor }) => amountMinor), [14_000, 14_000, 14_000, 14_000]);
    assert.deepEqual(preview.memberChanges.map(({ beforeNetBalanceMinor, afterNetBalanceMinor }) =>
      [beforeNetBalanceMinor, afterNetBalanceMinor]), [[56_000, 70_000], [-56_000, -42_000], [0, -14_000], [0, -14_000]]);
    assert.deepEqual([preview.beforeDate, preview.afterDate], [100, 50]);
    assert.deepEqual([preview.before, preview.after].map((snapshot) => summarizeCorrectionBalances(snapshot).effectiveMinor),
      [112_000n, 112_000n]);
    assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 1);

    const request = correction(56_000, { proposed: preview.expense.after, expectedLedger: preview.ledgerToken });
    const saved = valueOf(await finance.commitReviewedExpenseCorrection("trip", request));
    const current = await loadActivityDetail("trip", database);
    assert.deepEqual(current.expenses.find(({ id }) => id === "dinner").occurredAt, 50);
    assert.equal(current.expenses.find(({ id }) => id === "dinner").name, "旅程晚餐");
    const reopened = await reopen();
    const [v1, v2] = valueOf(await reopened.listExpenseRevisions("trip", "dinner"));
    assert.deepEqual(v1.expense, original.expense);
    assert.deepEqual(v2, saved);
    assert.deepEqual(valueOf(await reopened.getExpense("trip", "dinner")).expense, saved.expense);
  },
));

test("3B7A preserves historical repayments and previews a reverse transfer", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const paid = valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, note: "FPS" }));
  const detail = await loadExpenseDetail("trip", "dinner", database);
  const legacy = hydrateExpenseEditor(await activities.getActivity("trip"), detail.expense);
  const proposed = valueOf(prepareExpenseEdit(detail.expense, legacy, { ...legacy, finalTotal: "70.00" }, "晚餐", 100));
  const preview = valueOf(await loadExpenseCorrectionPreview("trip", proposed, 1, database));
  assert.deepEqual(preview.beforeSuggestions, []);
  assert.deepEqual(preview.suggestions, [{ fromMemberId: "z", toMemberId: "a", currency: "HKD", amountMinor: 1500 }]);
  assert.deepEqual([preview.before, preview.after].map((snapshot) => summarizeCorrectionBalances(snapshot).repaymentMinor),
    [5000n, 5000n]);
  valueOf(await finance.commitReviewedExpenseCorrection("trip", correction(7000, { proposed, expectedLedger: preview.ledgerToken })));
  assert.deepEqual(valueOf(await finance.listEvents("trip")).filter(({ kind }) => kind === "memberTransfer"), [paid]);
  assert.deepEqual((await loadActivitySettlement("trip", database)).suggestions, preview.suggestions);
}));

test("3B7A refuses incompatible merchant refunds and requires explicit review of retained refunds", withFinance(async (finance, _activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const retained = valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  assert.equal((await loadExpenseCorrectionPreview("trip", expense("dinner", 1000), 1, database)).error.code, "REFUND_EXCEEDS_EXPENSE");
  const nonparticipant = { ...expense("dinner", 8000), split: valueOf(splitEqual({ currency: "HKD", amountMinor: 8000 }, ["z"])) };
  assert.deepEqual((await loadExpenseCorrectionPreview("trip", nonparticipant, 1, database)).error,
    { code: "MEMBER_NOT_PARTICIPATING", field: "refundReductions" });

  const request = correction(8000);
  const preview = valueOf(await loadExpenseCorrectionPreview("trip", request.proposed, 1, database));
  assert.deepEqual(preview.expense.refunds, [retained]);
  const reviewed = { ...request, expectedLedger: preview.ledgerToken };
  assert.equal((await finance.commitReviewedExpenseCorrection("trip", reviewed)).error.code, "REFUND_REVIEW_REQUIRED");
  assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 1);
  valueOf(await finance.commitReviewedExpenseCorrection("trip", { ...reviewed, reviewedRefundIds: [retained.id] }));
  assert.deepEqual((await loadExpenseDetail("trip", "dinner", database)).refunds, [retained]);
}));

test("3B7A rejects stale previews after backdated writes, voids and activity status transitions", withFinance(async (finance, activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.createExpense("trip", 250, expense("lunch")));
  const request = correction(8000, { occurredAt: 400 });
  const read = async () => valueOf(await loadExpenseCorrectionPreview("trip", request.proposed, 1, database));
  const submit = (preview) => finance.commitReviewedExpenseCorrection("trip", { ...request, expectedLedger: preview.ledgerToken });
  const initial = await read();
  assert.equal((await finance.commitReviewedExpenseCorrection("trip", {
    ...request, expectedLedger: initial.ledgerToken, proposed: expense("dinner", 9000),
  })).error.code, "CORRECTION_LEDGER_CHANGED");
  const paid = valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, amountMinor: 1000 }));
  assert.equal((await submit(initial)).error.code, "CORRECTION_LEDGER_CHANGED");

  const beforeVoid = await read();
  valueOf(await finance.voidMemberTransfer("trip", { id: "void", targetEventId: paid.id, occurredAt: 300 }));
  assert.equal((await submit(beforeVoid)).error.code, "CORRECTION_LEDGER_CHANGED");

  const beforeCompletion = await read();
  await activities.completeActivity("trip");
  assert.equal((await submit(beforeCompletion)).error.code, "CORRECTION_LEDGER_CHANGED");
  assert.equal((await loadExpenseDetail("trip", "dinner", database)).editBlocker, "ACTIVITY_COMPLETED");
  assert.equal((await loadExpenseCorrectionPreview("trip", request.proposed, 1, database)).error.code, "ACTIVITY_COMPLETED");
  await activities.reopenActivity("trip");
  assert.equal((await submit(beforeCompletion)).error.code, "CORRECTION_LEDGER_CHANGED");
  assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 1);
}));

test("3B7A rolls back partial revisions and retries with the same ID, including metadata-only legacy edits", withFinance(
  async (finance, _activities, database) => {
    const original = valueOf(await finance.createExpense("trip", 100, { ...expense(), splitMode: "individual" }));
    const detail = await loadExpenseDetail("trip", "dinner", database);
    const initial = hydrateExpenseEditor(detail.activity, detail.expense);
    const proposed = valueOf(prepareExpenseEdit(detail.expense, initial, { ...initial, merchantPayerId: "a" }, "晚飯", 60));
    assert.deepEqual(proposed.split, original.expense.split);
    assert.equal(proposed.splitInput, undefined);
    const preview = valueOf(await loadExpenseCorrectionPreview("trip", proposed, 1, database));
    const request = correction(10_000, { proposed, expectedLedger: preview.ledgerToken });
    await database.write((db) => db.execAsync(`
      CREATE TRIGGER reject_revision AFTER INSERT ON expense_revision_allocations
      BEGIN SELECT RAISE(FAIL, 'test revision failure'); END;
    `));
    assert.deepEqual(await saveReviewedExpenseCorrection("trip", request, { database }), { status: "notSaved" });
    assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 1);
    assert.deepEqual(valueOf(await finance.listEvents("trip")), [original]);

    await database.write((db) => db.execAsync("DROP TRIGGER reject_revision"));
    const saved = valueOf(await finance.commitReviewedExpenseCorrection("trip", request));
    assert.deepEqual(valueOf(await finance.commitReviewedExpenseCorrection("trip", request)), saved);
    assert.equal((await finance.commitReviewedExpenseCorrection("trip", { ...request, proposed: { ...proposed, name: "不同" } })).error.code,
      "REVISION_ID_CONFLICT");
    assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 2);
  },
));

test("3B7A keeps historical custom fees and over-quota activities readable with guarded editing blocked", withFinance(
  async (finance, _activities, database) => {
    const custom = { ...expense("custom"), splitMode: "custom" };
    valueOf(await createFinanceRepository(database, () => true).createExpense("trip", 100, custom));
    valueOf(await finance.createExpense("trip", 200, expense()));
    assert.equal((await loadExpenseDetail("trip", "custom", database)).editBlocker, "UNSUPPORTED_EXPENSE_EDIT");
    assert.equal((await loadExpenseCorrectionPreview("trip", custom, 1, database)).error.code, "UNSUPPORTED_EXPENSE_EDIT");
    const request = correction(8000);
    const preview = valueOf(await loadExpenseCorrectionPreview("trip", request.proposed, 1, database));
    await database.write((db) => db.execAsync(`
      INSERT INTO activities (id, name, currency, status, created_at, updated_at)
      VALUES ('restored', 'Restored', 'HKD', 'active', 100, 100);
    `));
    assert.equal((await loadExpenseDetail("trip", "dinner", database)).editBlocker, "EXPENSE_EDIT_LIMIT");
    assert.equal((await loadExpenseCorrectionPreview("trip", request.proposed, 1, database)).error.code, "EXPENSE_EDIT_LIMIT");
    assert.equal((await finance.commitReviewedExpenseCorrection("trip", { ...request, expectedLedger: preview.ledgerToken })).error.code,
      "CORRECTION_LEDGER_CHANGED");
    assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 1);
  },
));

test("Batch A protects advanced expense writes and revisions while preserving the original expense and refund", withFinance(
  async (finance, activities, database, _connection, reopen) => {
    let pro = false;
    const repository = createFinanceRepository(database, () => pro);
    const activity = await activities.getActivity("trip");
    const editor = { ...createExpenseEditor(activity), mode: "custom", finalTotal: "100.01",
      customKind: "percentage", customValues: { z: "50", a: "50" }, merchantPayerId: "z" };
    const original = valueOf(prepareNewExpense("dinner", "Dinner", editor));
    assert.equal((await repository.createExpense("trip", 100, original)).error.code, "PRO_REQUIRED");
    assert.equal(valueOf(await finance.listEvents("trip")).length, 0);
    pro = true;
    const saved = valueOf(await repository.createExpense("trip", 100, original));
    valueOf(await repository.recordMerchantRefund("trip", 200, refund));
    const hydrated = hydrateExpenseEditor(activity, saved.expense);
    assert.deepEqual(hydrated.customValues, { z: "50.00", a: "50.00" });
    const proposed = valueOf(prepareExpenseEdit(original, hydrated, { ...hydrated,
      customKind: "shares", customValues: { z: "1", a: "2" },
    }, "Dinner", 100));
    const preview = valueOf(await repository.previewExpenseCorrection("trip", original.id, proposed, 1));
    const request = { expenseId: original.id, revisionId: "pro-revision", expectedVersion: 1,
      expectedLedger: preview.ledgerToken, occurredAt: 300, proposed, reviewedRefundIds: [refund.id] };
    pro = false;
    assert.equal((await repository.commitReviewedExpenseCorrection("trip", request)).error.code, "PRO_REQUIRED");
    assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 1);
    assert.deepEqual(valueOf(await repository.createExpense("trip", 100, original)), saved);
    pro = true;
    valueOf(await repository.commitReviewedExpenseCorrection("trip", request));
    const reopened = await reopen();
    const versions = valueOf(await reopened.listExpenseRevisions("trip", "dinner"));
    assert.deepEqual(versions.map(({ expense }) => expense.split.allocations.map(({ amountMinor }) => amountMinor)), [[5001, 5000], [3334, 6667]]);
    assert.equal(valueOf(await reopened.getExpense("trip", "dinner")).refunds[0].id, refund.id);
  },
));

test("Batch A keeps advanced quick history and mapped item tails intact through backup and Free restore", withRestore(async ({
  source, live, finance, service, exportSource, prepare,
}) => {
  let pro = false;
  const hasProAccess = () => pro;
  const quick = createQuickSplitRepository(source, hasProAccess);
  const editor = { ...createQuickSplitEditor(), mode: "individual", finalTotal: "100.01", itemized: true,
    items: [{ id: "row", name: "Tea", quantity: "2", amount: "100.01", memberIds: ["member-1", "member-2"] }] };
  const { input } = valueOf(calculateQuickSplitEditor(editor));
  assert.equal((await quick.saveQuickHistory("history", input)).error.code, "PRO_REQUIRED");
  pro = true;
  const history = valueOf(await quick.saveQuickHistory("history", input));
  const conversion = createQuickSplitConversionService(source, hasProAccess);
  const request = conversionRequest({ memberMapping: [
    { quickMemberId: "member-1", activityMemberId: "a" }, { quickMemberId: "member-2", activityMemberId: "z" },
  ] });
  pro = false;
  assert.deepEqual(valueOf(await quick.getQuickHistory("history")), history);
  assert.equal((await conversion.convertQuickHistory(request)).error.code, "PRO_REQUIRED");
  assert.equal(valueOf(await finance.listEvents("trip")).length, 0);
  pro = true;
  const receipt = valueOf(await conversion.convertQuickHistory(request));
  assert.deepEqual(receipt.event.expense.splitInput.method.items[0].memberIds, ["a", "z"]);
  const preview = await prepare(await exportSource());
  assert.deepEqual(await service.restoreBackup({ confirmation: preview.confirmation, confirmed: true }), { status: "restored" });
  const restored = await loadExpenseDetail("trip", receipt.event.expense.id, live);
  assert.equal(restored.editBlocker, "PRO_REQUIRED");
  assert.deepEqual(restored.expense.split.allocations.map(({ memberId, amountMinor }) => [memberId, amountMinor]), [["z", 5000], ["a", 5001]]);
  assert.deepEqual(valueOf(await createQuickSplitRepository(live).getQuickHistory("history")), history);
}));

test("3B7A repairs the early v9 schema and saves a four-person correction without rewriting history", withTestFile(async (path) => {
  const connection = openTestConnection(path);
  try {
    for (const [index, sql] of migrations.slice(0, 9).entries()) {
      await connection.execAsync(index === 2 ? sql.replace("    reviewed_refund_ids TEXT NOT NULL,\n", "") : sql);
    }
    await connection.execAsync(`
      INSERT INTO activities VALUES ('trip', '旅行', 'HKD', 'active', 1, 1);
      INSERT INTO members VALUES ('z', 'a', 1), ('a', 'b', 1), ('chris', 'Chris', 1), ('d', 'd', 1);
      INSERT INTO activity_members VALUES ('trip', 'z', 0), ('trip', 'a', 1), ('trip', 'chris', 2), ('trip', 'd', 3);
      INSERT INTO financial_events VALUES (1, 'lunch', 'trip', 'expense', 100), (2, 'dinner', 'trip', 'expense', 200),
        (3, 'repayment', 'trip', 'memberTransfer', 300);
      INSERT INTO expenses (id, activity_id, currency, amount_minor, split_mode, allocation_version, name)
        VALUES ('lunch', 'trip', 'HKD', 56000, 'equal', 1, '午餐'), ('dinner', 'trip', 'HKD', 56000, 'equal', 1, '晚餐');
      INSERT INTO expense_allocations VALUES
        ('trip', 'lunch', 'z', 28000, 0), ('trip', 'lunch', 'a', 28000, 1),
        ('trip', 'dinner', 'z', 28000, 0), ('trip', 'dinner', 'a', 28000, 1);
      INSERT INTO merchant_payments VALUES ('trip', 'lunch', 'z', 56000), ('trip', 'dinner', 'z', 56000);
      INSERT INTO member_transfers (id, activity_id, from_member_id, to_member_id, amount_minor, note)
        VALUES ('repayment', 'trip', 'a', 'z', 20000, 'FPS');
      INSERT INTO financial_voids (sequence, id, activity_id, target_event_id, target_kind, occurred_at)
        VALUES (4, 'void-payment', 'trip', 'repayment', 'memberTransfer', 400);
      PRAGMA user_version = 9;
    `);
    await assert.rejects(connection.getFirstAsync("SELECT reviewed_refund_ids FROM expense_revisions"),
      /no such column: reviewed_refund_ids/);
    assert.ok((await inspectBackupDatabase(backupPlatform(path), connection, 9)).ok);

    const database = await initializeDatabase(connection);
    const finance = createFinanceRepository(database);
    const detail = await loadExpenseDetail("trip", "dinner", database);
    const originalEvents = valueOf(await finance.listEvents("trip"));
    const initial = hydrateExpenseEditor(detail.activity, detail.expense);
    const draft = { ...initial, members: initial.members.map((member) => ({ ...member, included: true })) };
    const proposed = valueOf(prepareExpenseEdit(detail.expense, initial, draft, "晚餐", detail.expenseDate));
    const preview = valueOf(await loadExpenseCorrectionPreview("trip", proposed, detail.currentVersion, database));
    const request = correction(56_000, { occurredAt: 500, proposed: preview.expense.after, expectedLedger: preview.ledgerToken });
    assert.deepEqual(await saveReviewedExpenseCorrection("trip", request, { database }), { status: "saved" });
    const first = valueOf(await finance.lookupReviewedExpenseCorrection("trip", request));
    assert.equal(first.version, 2);
    assert.deepEqual(valueOf(await finance.commitReviewedExpenseCorrection("trip", request)), first);
    assert.deepEqual(valueOf(await finance.listExpenseRevisions("trip", "dinner")).map(({ version }) => version), [1, 2]);
    assert.deepEqual((await loadExpenseDetail("trip", "dinner", database)).expense.split.allocations.map(({ amountMinor }) => amountMinor),
      [14_000, 14_000, 14_000, 14_000]);
    const settlement = await loadActivitySettlement("trip", database);
    assert.equal(settlement.effectiveMinor, 112_000n);
    assert.equal(settlement.outstandingMinor, 70_000n);
    assert.deepEqual(settlement.members.map(({ netBalanceMinor }) => netBalanceMinor), [70_000, -42_000, -14_000, -14_000]);
    assert.deepEqual(valueOf(await finance.listEvents("trip")), originalEvents);
    assert.ok((await inspectBackupDatabase(backupPlatform(path), connection, migrations.length)).ok);
    await initializeDatabase(connection);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, migrations.length);
  } finally {
    connection.close();
  }
}));

test("3B7A verifies an ambiguous committed result by revision ID without a second write", withFinance(async (finance, _activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const base = correction(8000);
  const preview = valueOf(await loadExpenseCorrectionPreview("trip", base.proposed, 1, database));
  const request = { ...base, expectedLedger: preview.ledgerToken };
  let writes = 0;
  let canRead = false;
  const intercepted = {
    ...database,
    async write(task) {
      writes++;
      await database.write(task);
      throw new Error("The commit response was lost");
    },
    read(task) {
      if (!canRead) return Promise.reject(new Error("Receipt lookup is temporarily unavailable"));
      return database.read(task);
    },
  };

  assert.deepEqual(await saveReviewedExpenseCorrection("trip", request, { database: intercepted }), { status: "unknown" });
  assert.deepEqual(await saveReviewedExpenseCorrection("trip", request, { database: intercepted, verifyOnly: true }), { status: "unknown" });
  canRead = true;
  assert.deepEqual(await saveReviewedExpenseCorrection("trip", request, { database: intercepted, verifyOnly: true }), { status: "saved" });
  assert.equal(writes, 1);
  assert.equal((await loadExpenseDetail("trip", "dinner", database)).currentVersion, 2);
  assert.deepEqual((await saveReviewedExpenseCorrection("trip", { ...request, proposed: expense("dinner", 9000) },
    { database: intercepted, verifyOnly: true })), { status: "rejected", error: { code: "REVISION_ID_CONFLICT", field: "revisionId" } });
  assert.equal(valueOf(await finance.listExpenseRevisions("trip", "dinner")).length, 2);
}));

async function seedRefundTrip(finance, activities, withVoidedRepayment = false) {
  await activities.addMembers("trip", [{ id: "chris", displayName: "Chris" }, { id: "d", displayName: "d" }]);
  valueOf(await finance.createExpense("trip", 100, { ...expense("lunch", 56_000), name: "吃飯" }));
  valueOf(await finance.createExpense("trip", 200, { ...expense("dinner", 56_000), name: "晚餐" }));
  if (withVoidedRepayment) {
    valueOf(await finance.recordMemberTransfer("trip", 250, { ...repayment, amountMinor: 20_000 }));
    valueOf(await finance.voidMemberTransfer("trip", { id: "void-paid", targetEventId: repayment.id, occurredAt: 260 }));
  }
  const proposed = { ...expense("dinner", 56_000), split: valueOf(splitEqual(
    { currency: "HKD", amountMinor: 56_000 }, ["z", "a", "chris", "d"],
  )) };
  const preview = valueOf(await finance.previewExpenseCorrection("trip", "dinner", proposed, 1));
  return valueOf(await finance.commitReviewedExpenseCorrection("trip", correction(56_000, {
    proposed: preview.expense.after, expectedLedger: preview.ledgerToken,
  })));
}

const refundInput = { id: "refund", expenseId: "dinner", recipientId: "z", currency: "HKD", amountMinor: 20_000 };

test("3B7B records and voids a HKD 200 merchant refund against the revised expense and keeps all history", withFinance(
  async (finance, activities, database, connection, reopen) => {
    const revision = await seedRefundTrip(finance, activities, true);
    const original = valueOf(await finance.getActivityLedger("trip"));
    assert.equal((await finance.previewMerchantRefund("trip", 240, refundInput)).error.code, "REFUND_DATE_CONFLICT");
    const review = valueOf(await loadMerchantRefundPreview("trip", 400, { ...refundInput, note: " 餐廳退款 " }, database));
    assert.deepEqual(review.beforeShares.map(({ amountMinor }) => amountMinor), [14_000, 14_000, 14_000, 14_000]);
    assert.deepEqual(review.refund.reductions.map(({ amountMinor }) => amountMinor), [5000, 5000, 5000, 5000]);
    assert.equal(review.refund.reductions.reduce((sum, share) => sum + share.amountMinor, 0), review.refund.amountMinor);
    assert.deepEqual(review.afterShares.map(({ amountMinor }) => amountMinor), [9000, 9000, 9000, 9000]);
    assert.deepEqual([review.before, review.after].map((snapshot) => summarizeCorrectionBalances(snapshot)), [
      { effectiveMinor: 112_000n, refundMinor: 0n, repaymentMinor: 0n, outstandingMinor: 70_000n },
      { effectiveMinor: 92_000n, refundMinor: 20_000n, repaymentMinor: 0n, outstandingMinor: 55_000n },
    ]);
    assert.deepEqual(review.after.balances.map(({ netBalanceMinor }) => netBalanceMinor), [55_000, -37_000, -9000, -9000]);
    assert.deepEqual(review.afterSuggestions.map(({ fromMemberId, toMemberId, amountMinor }) => [fromMemberId, toMemberId, amountMinor]),
      [["a", "z", 37_000], ["chris", "z", 9000], ["d", "z", 9000]]);
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), original);

    const request = { kind: "record", preview: review };
    assert.deepEqual(await saveReviewedMerchantRefund("trip", request, { database }), { status: "saved" });
    assert.deepEqual(await saveReviewedMerchantRefund("trip", request, { database }), { status: "saved" });
    assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS n FROM merchant_refunds")).n, 1);
    const [stored] = (await loadExpenseDetail("trip", "dinner", database)).refundHistory;
    assert.equal(stored.refund.note, "餐廳退款");
    assert.equal(stored.refund.distribution, "proportional");
    assert.ok(stored.refund.recordedAt >= stored.refund.occurredAt);
    assert.equal(stored.version.id, revision.id);
    assert.equal(stored.voidEvent, undefined);

    const voidRequest = { id: "refund-void", targetEventId: review.refund.id, occurredAt: 500 };
    assert.equal((await finance.previewMerchantRefundVoid("trip", "lunch", voidRequest)).error.code, "INVALID_VOID_TARGET");
    const voidPreview = valueOf(await loadMerchantRefundVoidPreview("trip", "dinner", voidRequest, database));
    assert.deepEqual(voidPreview.after, original.balanceSnapshot);
    assert.deepEqual(voidPreview.afterSuggestions, original.suggestions);
    assert.equal((await loadActivitySettlement("trip", database)).outstandingMinor, 55_000n);
    const reviewedVoid = { kind: "void", preview: { ...voidPreview, request: { ...voidRequest, occurredAt: 600 } } };
    assert.deepEqual(await saveReviewedMerchantRefund("trip", reviewedVoid, { database }), { status: "saved" });
    assert.deepEqual(await saveReviewedMerchantRefund("trip", reviewedVoid, { database }), { status: "saved" });
    const final = await loadExpenseDetail("trip", "dinner", database);
    assert.deepEqual(final.refunds, []);
    assert.equal(final.refundHistory[0].voidEvent.id, voidRequest.id);
    assert.equal(final.refundHistory[0].voidEvent.occurredAt, 600);
    assert.deepEqual(final.refundHistory[0].refund, stored.refund);
    const reopened = await reopen();
    const ledger = valueOf(await reopened.getActivityLedger("trip"));
    assert.deepEqual(ledger.events.slice(0, original.events.length), original.events);
    assert.deepEqual(ledger.balanceSnapshot, original.balanceSnapshot);
    assert.deepEqual(ledger.revisions, original.revisions);
    assert.equal((await reopened.previewMerchantRefundVoid("trip", "dinner", { ...voidRequest, id: "second-void" })).error.code,
      "EVENT_ALREADY_VOIDED");
  },
));

test("3B7B keeps HKD 420 in actual repayments and recalculates who should receive money", withFinance(async (finance, activities, database) => {
  await seedRefundTrip(finance, activities);
  const paid = valueOf(await finance.recordMemberTransfer("trip", 350, { ...repayment, amountMinor: 42_000, note: "FPS" }));
  const preview = valueOf(await finance.previewMerchantRefund("trip", 400, refundInput));
  assert.deepEqual(preview.after.balances.map(({ netBalanceMinor }) => netBalanceMinor), [13_000, 5000, -9000, -9000]);
  assert.equal(summarizeCorrectionBalances(preview.after).outstandingMinor, 18_000n);
  assert.equal(summarizeCorrectionBalances(preview.after).repaymentMinor, 42_000n);
  assert.equal(preview.afterSuggestions.filter(({ toMemberId }) => toMemberId === "a").reduce((sum, row) => sum + row.amountMinor, 0), 5000);
  valueOf(await finance.commitReviewedMerchantRefund("trip", preview));
  const ledger = valueOf(await finance.getActivityLedger("trip"));
  assert.deepEqual(ledger.events.filter(({ kind }) => kind === "memberTransfer"), [paid]);
  assert.deepEqual((await loadActivitySettlement("trip", database)).suggestions, preview.afterSuggestions);
}));

test("3B7B validates JPY precision and allocates successive partial refunds in stable order to a non-payer", withFinance(
  async (finance, activities, database) => {
    await activities.completeActivity("trip");
    await activities.createActivity({ id: "yen", name: "東京", currency: "JPY",
      members: ["payer", "one", "two", "recipient"].map((id) => ({ id, displayName: id })) });
    const total = { currency: "JPY", amountMinor: 5 };
    valueOf(await finance.createExpense("yen", 100, { id: "bill", splitMode: "equal", allocationVersion: 1,
      split: valueOf(splitEqual(total, ["payer", "one", "two"])), merchantPayment: { ...total, memberId: "payer" } }));
    const detail = await loadExpenseDetail("yen", "bill", database);
    const now = new Date();
    const draft = { amount: "2", recipientId: "recipient", note: "", date: expenseDateInput(now) };
    for (const [amount, code] of [["0", "NON_POSITIVE_AMOUNT"], ["-1", "NEGATIVE_AMOUNT"], ["2.01", "INVALID_AMOUNT_PRECISION"],
      ["6", "REFUND_EXCEEDS_EXPENSE"]]) {
      assert.equal(inspectMerchantRefundDraft({ ...draft, amount }, detail, now).errors.amount, code);
    }
    assert.equal(inspectMerchantRefundDraft({ ...draft, recipientId: "outsider" }, detail, now).errors.recipientId,
      "MEMBER_NOT_PARTICIPATING");
    const parsed = inspectMerchantRefundDraft(draft, detail, now);
    const input = { ...parsed.prepared.refund, id: "partial-1" };
    for (const [amountMinor, code] of [[0, "NON_POSITIVE_AMOUNT"], [-1, "NEGATIVE_AMOUNT"], [6, "REFUND_EXCEEDS_EXPENSE"]]) {
      assert.equal((await finance.previewMerchantRefund("yen", 200, { ...input, amountMinor })).error.code, code);
    }
    assert.equal((await finance.previewMerchantRefund("yen", 200, { ...input, currency: "USD" })).error.code, "CURRENCY_MISMATCH");
    const first = valueOf(await finance.previewMerchantRefund("yen", 200, input));
    assert.deepEqual(first.refund.reductions, [{ memberId: "payer", amountMinor: 1 }, { memberId: "one", amountMinor: 1 }]);
    valueOf(await finance.commitReviewedMerchantRefund("yen", first));
    assert.equal((await finance.previewMerchantRefund("yen", 300, { ...input, id: "too-much", amountMinor: 4 })).error.code, "REFUND_EXCEEDS_EXPENSE");
    const second = valueOf(await finance.previewMerchantRefund("yen", 300, { ...input, id: "partial-2" }));
    valueOf(await finance.commitReviewedMerchantRefund("yen", second));
    assert.deepEqual(second.afterShares.map(({ amountMinor }) => amountMinor), [0, 0, 1]);
    assert.deepEqual(second.after.balances.map(({ merchantRefundReceivedMinor }) => merchantRefundReceivedMinor), [0, 0, 0, 4]);
    assert.equal((await loadExpenseDetail("yen", "bill", database)).refundHistory.length, 2);
  },
));

test("3B7B rejects stale refund and void confirmations and restricts writes on completed activities", withFinance(async (finance, activities) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  const input = { ...refundInput, amountMinor: 1000 };
  const first = valueOf(await finance.previewMerchantRefund("trip", 400, input));
  valueOf(await finance.recordMemberTransfer("trip", 200, { ...repayment, amountMinor: 1000 }));
  assert.equal((await finance.commitReviewedMerchantRefund("trip", first)).error.code, "REFUND_LEDGER_CHANGED");
  assert.equal(valueOf(await finance.lookupMerchantRefund("trip", first)), null);
  const current = valueOf(await finance.previewMerchantRefund("trip", 400, input));
  assert.equal((await finance.commitReviewedMerchantRefund("trip", { ...current,
    refund: { ...current.refund, reductions: [{ memberId: "a", amountMinor: 1000 }] },
  })).error.code, "REFUND_LEDGER_CHANGED");
  valueOf(await finance.commitReviewedMerchantRefund("trip", current));

  const request = { id: "void", targetEventId: input.id, occurredAt: 500 };
  const voidPreview = valueOf(await finance.previewMerchantRefundVoid("trip", "dinner", request));
  valueOf(await finance.recordMemberTransfer("trip", 450, { ...repayment, id: "another", amountMinor: 1000 }));
  assert.equal((await finance.commitReviewedMerchantRefundVoid("trip", voidPreview)).error.code, "REFUND_LEDGER_CHANGED");
  const validVoid = valueOf(await finance.previewMerchantRefundVoid("trip", "dinner", request));
  const pendingRefund = valueOf(await finance.previewMerchantRefund("trip", 500, { ...input, id: "new" }));
  await activities.completeActivity("trip");
  assert.equal((await finance.previewMerchantRefund("trip", 500, input)).error.code, "ACTIVITY_COMPLETED");
  assert.equal((await finance.previewMerchantRefundVoid("trip", "dinner", request)).error.code, "ACTIVITY_COMPLETED");
  assert.equal((await finance.commitReviewedMerchantRefund("trip", pendingRefund)).error.code, "ACTIVITY_COMPLETED");
  assert.equal((await finance.commitReviewedMerchantRefundVoid("trip", validVoid)).error.code, "REFUND_LEDGER_CHANGED");
  assert.equal(valueOf(await finance.lookupMerchantRefundVoid("trip", request)), null);
  assert.equal(valueOf(await finance.getExpense("trip", "dinner")).refunds.length, 1);
}));

test("3B7B rolls back both refund writes and resolves an uncertain submission without another write", withFinance(
  async (finance, _activities, database, connection) => {
    valueOf(await finance.createExpense("trip", 100, expense()));
    const preview = valueOf(await finance.previewMerchantRefund("trip", 200, { ...refundInput, amountMinor: 2000 }));
    const record = { kind: "record", preview };
    await database.write((db) => db.execAsync(`
      CREATE TRIGGER fail_refund AFTER INSERT ON refund_reductions BEGIN SELECT RAISE(FAIL, 'injected'); END;
    `));
    assert.deepEqual(await saveReviewedMerchantRefund("trip", record, { database }), { status: "notSaved" });
    assert.equal(valueOf(await finance.listEvents("trip")).length, 1);
    assert.equal((await connection.getFirstAsync("SELECT COUNT(*) AS n FROM merchant_refunds")).n, 0);
    await database.write((db) => db.execAsync("DROP TRIGGER fail_refund"));

    let writes = 0;
    let canRead = false;
    const intercepted = {
      ...database,
      async write(task) { writes++; await database.write(task); throw new Error("The commit response was lost"); },
      read: (task) => canRead ? database.read(task) : Promise.reject(new Error("Receipt unavailable")),
    };
    assert.deepEqual(await saveReviewedMerchantRefund("trip", record, { database: intercepted }), { status: "unknown" });
    canRead = true;
    assert.deepEqual(await saveReviewedMerchantRefund("trip", record, { database: intercepted, verifyOnly: true }), { status: "saved" });
    assert.equal(writes, 1);

    const voidPreview = valueOf(await finance.previewMerchantRefundVoid("trip", "dinner", {
      id: "void", targetEventId: preview.refund.id, occurredAt: 300,
    }));
    await database.write((db) => db.execAsync(`
      CREATE TRIGGER fail_void AFTER INSERT ON financial_voids BEGIN SELECT RAISE(FAIL, 'injected'); END;
    `));
    const reversal = { kind: "void", preview: voidPreview };
    assert.deepEqual(await saveReviewedMerchantRefund("trip", reversal, { database }), { status: "notSaved" });
    assert.deepEqual((await loadExpenseDetail("trip", "dinner", database)).refunds.map(({ id }) => id), [preview.refund.id]);
    await database.write((db) => db.execAsync("DROP TRIGGER fail_void"));
    assert.deepEqual(await saveReviewedMerchantRefund("trip", reversal, { database: intercepted }), { status: "saved" });
    assert.equal(writes, 2);
    assert.equal(valueOf(await finance.listEvents("trip")).filter(({ kind }) => kind === "financialVoid").length, 1);
  },
));

test("S11 reads revised and voided activity ledgers without writes and retains the old preview after settlement", withFinance(
  async (finance, activities, database) => {
    const empty = await loadSettlementPngSnapshot("trip", database);
    assert.equal(empty.status, "empty");
    await seedRefundTrip(finance, activities, true);
    const refundReview = valueOf(await loadMerchantRefundPreview("trip", 400, refundInput, database));
    assert.deepEqual(await saveReviewedMerchantRefund("trip", { kind: "record", preview: refundReview }, { database }), { status: "saved" });
    const refunded = await loadSettlementPngSnapshot("trip", database);
    assert.deepEqual([refunded.effectiveMinor, refunded.refundMinor, refunded.outstandingMinor], [92_000n, 20_000n, 55_000n]);

    const voidReview = valueOf(await loadMerchantRefundVoidPreview("trip", "dinner",
      { id: "refund-void", targetEventId: refundInput.id, occurredAt: 500 }, database));
    assert.deepEqual(await saveReviewedMerchantRefund("trip", { kind: "void", preview: voidReview }, { database }), { status: "saved" });
    await activities.completeActivity("trip");
    const ledger = valueOf(await finance.getActivityLedger("trip"));
    const preview = await loadSettlementPngSnapshot("trip", database);
    const png = buildSettlementPngCard(preview, "zh-HK");
    assert.deepEqual([png.activityStatus, png.settlementStatus], ["已完成", "未結清"]);
    assert.deepEqual([png.effective, png.refund, png.repayment, png.outstanding], ["HKD 1,120.00", "HKD 0.00", "HKD 0.00", "HKD 700.00"]);
    assert.deepEqual(png.transfers.map(({ from, to, amount }) => [from, to, amount]),
      [["Bo", "Alex", "HKD 420.00"], ["Chris", "Alex", "HKD 140.00"], ["d", "Alex", "HKD 140.00"]]);
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), ledger);

    for (const { fromMemberId, toMemberId, amountMinor } of preview.suggestions) {
      valueOf(await finance.recordMemberTransfer("trip", 600, { id: `actual-${fromMemberId}`, fromMemberId, toMemberId, amountMinor, currency: "HKD" }));
    }
    const refreshed = buildSettlementPngCard(await loadSettlementPngSnapshot("trip", database), "zh-HK");
    assert.deepEqual([refreshed.activityStatus, refreshed.settlementStatus, refreshed.outstanding, refreshed.repayment],
      ["已完成", "已結清", "HKD 0.00", "HKD 700.00"]);
    assert.equal(refreshed.effective, png.effective);
    assert.equal(refreshed.transfers.length, 0);
    assert.equal(buildSettlementPngCard(preview, "en").outstanding, "HKD 700.00");
  },
));

function multiPayerExpense(first = 6000, second = 4000) {
  const { merchantPayment: _single, ...bill } = expense();
  return {
    ...bill,
    merchantPayments: [
      { memberId: "z", currency: "HKD", amountMinor: first },
      { memberId: "a", currency: "HKD", amountMinor: second },
    ],
  };
}

test("S11 Pro PDF, CSV and Free PNG read the same immutable v13 settlement snapshot", withFinance(
  async (_finance, activities, database) => {
    const finance = createFinanceRepository(database, () => true, () => true);
    valueOf(await finance.createExpense("trip", 100, multiPayerExpense()));
    valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a", note: "Private refund note" }));
    valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, amountMinor: 500, note: "Private repayment note" }));
    valueOf(await finance.commitExpenseCorrection("trip", correction(10_000, {
      occurredAt: 400, proposed: multiPayerExpense(7000, 3000), reviewedRefundIds: [refund.id],
    })));
    await activities.completeActivity("trip");

    const snapshot = await loadSettlementPngSnapshot("trip", database);
    const card = buildSettlementPngCard(snapshot, "en");
    const preview = { snapshot, card };
    assert.deepEqual([card.activityStatus, card.settlementStatus], ["Completed", "Unsettled"]);
    assert.deepEqual([card.effective, card.refund, card.repayment, card.outstanding], ["HKD 80.00", "HKD 20.00", "HKD 5.00", "HKD 25.00"]);
    assert.deepEqual(card.transfers.map(({ from, to, amount }) => [from, to, amount]), [["Bo", "Alex", "HKD 25.00"]]);
    const before = valueOf(await finance.getActivityLedger("trip"));
    const pdf = buildSettlementDocument(preview, "pdf").content;
    const csv = buildSettlementDocument(preview, "csv").content;
    for (const amount of ["80.00", "20.00", "5.00", "25.00"]) {
      assert.ok(pdf.includes(`HKD ${amount}`));
      assert.ok(csv.includes(`"HKD","${amount}"`));
    }
    assert.doesNotMatch(pdf + csv, /Private .* note/);
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);

    valueOf(await finance.recordMemberTransfer("trip", 500, { ...repayment, id: "remaining", amountMinor: 2500 }));
    const latest = buildSettlementPngCard(await loadSettlementPngSnapshot("trip", database), "en");
    assert.deepEqual([latest.effective, latest.outstanding, latest.settlementStatus], ["HKD 80.00", "HKD 0.00", "Settled"]);
    assert.equal(buildSettlementDocument(preview, "pdf").content, pdf);
    assert.equal(buildSettlementDocument(preview, "csv").content, csv);
  },
));

test("Batch B keeps multiple merchant payments, a refund to the second payer and real repayments independent", withFinance(
  async (_finance, _activities, database, _connection, reopen) => {
    const finance = createFinanceRepository(database, () => true, () => true);
    const bill = multiPayerExpense();
    valueOf(await finance.createExpense("trip", 100, bill));
    const before = await loadActivitySettlement("trip", database);
    assert.deepEqual(before.members.map(({ netBalanceMinor }) => netBalanceMinor), [1000, -1000]);

    const review = valueOf(await finance.previewMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
    assert.deepEqual(review.refund.reductions, refund.reductions);
    valueOf(await finance.commitReviewedMerchantRefund("trip", review));
    const refunded = await loadActivitySettlement("trip", database);
    assert.deepEqual([refunded.effectiveMinor, refunded.outstandingMinor], [8000n, 2000n]);
    assert.deepEqual(refunded.members.map(({ netBalanceMinor }) => netBalanceMinor), [2000, -2000]);
    valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, amountMinor: 500 }));
    assert.deepEqual((await loadActivitySettlement("trip", database)).members.map(({ netBalanceMinor }) => netBalanceMinor), [1500, -1500]);

    const request = { id: "refund-void", targetEventId: refund.id, occurredAt: 400 };
    valueOf(await finance.commitReviewedMerchantRefundVoid("trip", valueOf(await finance.previewMerchantRefundVoid("trip", "dinner", request))));
    const restored = valueOf(await (await reopen()).getActivityLedger("trip"));
    assert.deepEqual(restored.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [500, -500]);
    assert.deepEqual(restored.events.map(({ kind }) => kind), ["expense", "merchantRefund", "memberTransfer", "financialVoid"]);
    assert.deepEqual(restored.events[0].expense.merchantPayments, bill.merchantPayments);
    assert.equal(restored.events[1].recipientId, "a");
    assert.equal(restored.events[2].amountMinor, 500);
  },
));

test("Batch B rejects unverified Pro, invalid payer rows and partial writes, and retries by expense ID", withFinance(
  async (_finance, activities, database, connection) => {
    let verified = false;
    const finance = createFinanceRepository(database, () => true, () => verified);
    await activities.addMember("trip", { id: "outside-split", displayName: "Casey" });
    const draft = {
      ...createExpenseEditor(await activities.getActivity("trip")), finalTotal: "100.00",
      paymentRows: [{ memberId: "z", amount: "60.00" }, { memberId: "outside-split", amount: "40.00" }],
    };
    const bill = valueOf(prepareNewExpense("dinner", "Dinner", {
      ...draft, members: draft.members.map((member) => ({ ...member, included: member.id !== "outside-split" })),
    }));
    assert.equal((await finance.createExpense("trip", 100, bill)).error.code, "PRO_REQUIRED");
    verified = true;
    const [first, second] = bill.merchantPayments;
    for (const [rows, code] of [
      [[first, { ...second, amountMinor: 3999 }], "TOTAL_MISMATCH"],
      [[first, { ...second, amountMinor: 4001 }], "TOTAL_MISMATCH"],
      [[first, { ...second, memberId: "z" }], "DUPLICATE_MEMBER_ID"],
      [[first, { ...second, memberId: "missing" }], "MEMBER_NOT_PARTICIPATING"],
      [[first, { ...second, currency: "JPY" }], "CURRENCY_MISMATCH"],
      [[first, { ...second, amountMinor: 0 }], "NON_POSITIVE_AMOUNT"],
    ]) {
      assert.equal((await finance.createExpense("trip", 100, { ...bill, merchantPayments: rows })).error.code, code);
    }
    await connection.execAsync(`
      CREATE TRIGGER fail_second_payment BEFORE INSERT ON merchant_payments
      WHEN NEW.member_id = 'outside-split' BEGIN SELECT RAISE(ABORT, 'payment failure'); END;
    `);
    assert.equal((await finance.createExpense("trip", 100, bill)).error.code, "FINANCE_STORAGE_ERROR");
    for (const table of ["financial_events", "expenses", "expense_allocations", "merchant_payments"]) {
      assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0);
    }
    await connection.execAsync("DROP TRIGGER fail_second_payment");
    const saved = valueOf(await finance.createExpense("trip", 100, bill));
    verified = false;
    assert.deepEqual(valueOf(await finance.createExpense("trip", 100, { ...bill, merchantPayments: [second, first] })), saved);
    assert.equal((await finance.createExpense("trip", 100, multiPayerExpense())).error.code, "EVENT_ID_CONFLICT");
    assert.deepEqual((await loadActivitySettlement("trip", database)).members.map(({ netBalanceMinor }) => netBalanceMinor), [1000, -5000, 4000]);
    // An activity member who did not pay the merchant can still be the actual refund recipient.
    valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
    assert.deepEqual((await loadActivitySettlement("trip", database)).members.map(({ netBalanceMinor }) => netBalanceMinor), [2000, -6000, 4000]);
  },
));

test("Batch B corrects payer amounts with reviewed refunds and prior repayments, atomically preserving every version", withFinance(
  async (_finance, _activities, database, connection, reopen) => {
    let verified = true;
    const finance = createFinanceRepository(database, () => true, () => verified);
    const original = valueOf(await finance.createExpense("trip", 100, { ...multiPayerExpense(), name: "Dinner" }));
    valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
    valueOf(await finance.recordMemberTransfer("trip", 300, { ...repayment, amountMinor: 500 }));
    const detail = await loadExpenseDetail("trip", "dinner", database);
    const initial = hydrateExpenseEditor(detail.activity, detail.expense);
    assert.deepEqual(initial.paymentRows, [{ memberId: "z", amount: "60.00" }, { memberId: "a", amount: "40.00" }]);
    const proposed = valueOf(prepareExpenseEdit(detail.expense, initial, {
      ...initial, paymentRows: [{ memberId: "z", amount: "70.00" }, { memberId: "a", amount: "30.00" }],
    }, "Dinner", detail.expenseDate));
    assert.deepEqual(proposed.split, original.expense.split);

    const review = valueOf(await finance.previewExpenseCorrection("trip", "dinner", proposed, 1));
    assert.deepEqual(review.memberChanges.map(({ beforeNetBalanceMinor, afterNetBalanceMinor }) =>
      [beforeNetBalanceMinor, afterNetBalanceMinor]), [[1500, 2500], [-1500, -2500]]);
    const request = correction(10_000, { occurredAt: 400, proposed: review.expense.after, expectedLedger: review.ledgerToken });
    assert.equal((await finance.commitReviewedExpenseCorrection("trip", request)).error.code, "REFUND_REVIEW_REQUIRED");
    request.reviewedRefundIds = [refund.id];
    verified = false;
    assert.equal((await finance.commitReviewedExpenseCorrection("trip", request)).error.code, "PRO_REQUIRED");
    verified = true;
    await connection.execAsync(`
      CREATE TRIGGER fail_revision_payment BEFORE INSERT ON expense_revision_payments
      WHEN NEW.member_id = 'a' BEGIN SELECT RAISE(ABORT, 'revision payment failure'); END;
    `);
    const before = valueOf(await finance.getActivityLedger("trip"));
    assert.equal((await finance.commitReviewedExpenseCorrection("trip", request)).error.code, "FINANCE_STORAGE_ERROR");
    for (const table of ["expense_revisions", "expense_revision_allocations", "expense_revision_payments"]) {
      assert.equal((await connection.getFirstAsync(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0);
    }
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")), before);
    await connection.execAsync("DROP TRIGGER fail_revision_payment");
    const saved = valueOf(await finance.commitReviewedExpenseCorrection("trip", request));
    assert.equal(saved.version, 2);
    assert.deepEqual(valueOf(await finance.getActivityLedger("trip")).events, before.events);

    const free = await reopen();
    assert.deepEqual(valueOf(await free.commitReviewedExpenseCorrection("trip", request)), saved);
    const versions = valueOf(await free.listExpenseRevisions("trip", "dinner"));
    assert.deepEqual(versions.map(({ expense }) => expense.merchantPayments.map(({ amountMinor }) => amountMinor)),
      [[6000, 4000], [7000, 3000]]);
    assert.deepEqual(valueOf(await free.getActivityLedger("trip")).balanceSnapshot, review.after);
  },
));

test("Batch B restores v12, v13 and current backups with revisions and event history", withRestore(async ({
  directory, platform, live, source, service, exportSource, prepare,
}) => {
  const legacyPath = join(directory, "legacy-v12.sqlite");
  const legacy = openTestConnection(legacyPath);
  try {
    await seedLegacyPayments(legacy, 12);
  } finally {
    legacy.close();
  }
  const bytes = readFileSync(legacyPath);
  const legacyBackup = join(directory, "v12.splitmori-backup");
  writeBackup(legacyBackup, { formatVersion: 1, schemaVersion: 12, createdAt: null, byteLength: bytes.length, sha256: sha256(bytes), assets: [] }, bytes);
  const restore = async (file) => {
    const { confirmation } = await prepare(file);
    assert.deepEqual(await service.restoreBackup({ confirmation, confirmed: true }), { status: "restored" });
  };
  await restore(legacyBackup);
  const free = createFinanceRepository(live);
  assert.deepEqual(valueOf(await free.listExpenseRevisions("trip", "dinner")).map(({ expense }) => expense.merchantPayment.amountMinor),
    [10_000, 8000]);
  assert.equal((await live.read((db) => db.getFirstAsync("PRAGMA user_version"))).user_version, expandedCurrencySchemaVersion);

  const v13Path = join(directory, "legacy-v13.sqlite");
  const v13 = openTestConnection(v13Path);
  try {
    await seedV13Payments(v13);
  } finally {
    v13.close();
  }
  const v13Bytes = readFileSync(v13Path);
  const v13Backup = join(directory, "v13.splitmori-backup");
  writeBackup(v13Backup, {
    formatVersion: 1, schemaVersion: multiPayerSchemaVersion, createdAt: null, byteLength: v13Bytes.length, sha256: sha256(v13Bytes), assets: [],
  }, v13Bytes);
  await restore(v13Backup);
  const v13Ledger = valueOf(await free.getActivityLedger("trip"));
  assert.deepEqual(v13Ledger.revisions[0].expense.merchantPayments.map(({ amountMinor }) => amountMinor), [7000, 1000]);
  assert.deepEqual(v13Ledger.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [3000, -3000]);

  const pro = createFinanceRepository(source, () => true, () => true);
  valueOf(await pro.createExpense("trip", 100, multiPayerExpense()));
  valueOf(await pro.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  valueOf(await pro.recordMemberTransfer("trip", 300, { ...repayment, amountMinor: 500 }));
  valueOf(await pro.commitExpenseCorrection("trip", correction(10_000, {
    occurredAt: 400, proposed: multiPayerExpense(7000, 3000), reviewedRefundIds: [refund.id],
  })));
  valueOf(await pro.voidMerchantRefund("trip", { id: "refund-void", targetEventId: refund.id, occurredAt: 500 }));
  const before = valueOf(await pro.getActivityLedger("trip"));
  const uri = await exportSource();
  assert.equal(valueOf(await createBackupService(platform).previewBackup(uri)).manifest.schemaVersion, expandedCurrencySchemaVersion);
  assert.deepEqual(valueOf(await pro.getActivityLedger("trip")), before);
  await restore(uri);
  assert.deepEqual(valueOf(await free.getActivityLedger("trip")), before);
  assert.equal((await free.previewExpenseCorrection("trip", "dinner", expense(), 2)).error.code, "PRO_REQUIRED");

  const { manifest, payload } = unpackBackup(uri);
  const alteredPath = join(directory, "invalid.sqlite");
  writeFileSync(alteredPath, payload);
  const altered = openTestConnection(alteredPath);
  try {
    await altered.execAsync("DELETE FROM expense_revision_payments WHERE member_id = 'a'");
  } finally {
    altered.close();
  }
  const invalid = join(directory, "invalid.splitmori-backup");
  const alteredBytes = readFileSync(alteredPath);
  writeBackup(invalid, { ...manifest, byteLength: alteredBytes.length, sha256: sha256(alteredBytes) }, alteredBytes);
  assert.deepEqual(await service.prepareRestore(pathToFileURL(invalid).href),
    { status: "validation-failed", code: "BACKUP_LEDGER_INVALID" });
  assert.deepEqual(valueOf(await free.getActivityLedger("trip")), before);
}));

test("currency expansion preserves VND payments, refunds, repayments and reviewed corrections through backup restore", withRestore(async ({
  live, source, service, exportSource, prepare,
}) => {
  const currency = "VND";
  const activities = createActivityRepository(source);
  await activities.completeActivity("trip");
  const activity = await activities.createActivity({
    id: "vnd-trip", name: "Vietnam", currency, members: [{ id: "vnd-a", displayName: "A" }, { id: "vnd-b", displayName: "B" }],
  });
  const finance = createFinanceRepository(source, () => true, () => true);
  const editor = {
    ...createExpenseEditor(activity), finalTotal: "100000",
    paymentRows: [{ memberId: "vnd-a", amount: "60000" }, { memberId: "vnd-b", amount: "40000" }],
  };
  const expenseId = "vnd-dinner";
  assert.equal(prepareNewExpense(expenseId, "Dinner", { ...editor, finalTotal: "100000.5" }).error.code, "INVALID_AMOUNT_PRECISION");
  const created = valueOf(prepareNewExpense(expenseId, "Dinner", editor));
  valueOf(await finance.createExpense(activity.id, 100, created));
  const refundNow = new Date(200);
  const refundDetail = await loadExpenseDetail(activity.id, expenseId, source);
  const refundDraft = { amount: "20000", recipientId: "vnd-b", date: expenseDateInput(refundNow), note: "" };
  assert.equal(inspectMerchantRefundDraft({ ...refundDraft, amount: "20000.5" }, refundDetail, refundNow).errors.amount,
    "INVALID_AMOUNT_PRECISION");
  const preparedRefund = inspectMerchantRefundDraft(refundDraft, refundDetail, refundNow).prepared;
  assert.ok(preparedRefund);
  const review = valueOf(await finance.previewMerchantRefund(activity.id, preparedRefund.occurredAt,
    { id: "vnd-refund", ...preparedRefund.refund }));
  assert.deepEqual(review.refund.reductions.map(({ amountMinor }) => amountMinor), [10_000, 10_000]);
  valueOf(await finance.commitReviewedMerchantRefund(activity.id, review));
  const repaymentNow = new Date(300);
  const afterRefund = await loadActivitySettlement(activity.id, source);
  const repaymentDraft = { amount: "5000", fromMemberId: "vnd-b", toMemberId: "vnd-a", date: expenseDateInput(repaymentNow), note: "" };
  assert.equal(inspectRepaymentDraft({ ...repaymentDraft, amount: "5000.0" }, afterRefund, repaymentNow).errors.amount,
    "INVALID_AMOUNT_PRECISION");
  const preparedRepayment = inspectRepaymentDraft(repaymentDraft, afterRefund, repaymentNow).prepared;
  assert.ok(preparedRepayment);
  valueOf(await finance.recordMemberTransfer(activity.id, preparedRepayment.occurredAt,
    { id: "vnd-repayment", ...preparedRepayment.transfer }, preparedRepayment.expectedBalances));

  const detail = await loadExpenseDetail(activity.id, expenseId, source);
  const original = hydrateExpenseEditor(activity, detail.expense);
  const corrected = valueOf(prepareExpenseEdit(detail.expense, original, {
    ...original, paymentRows: [{ memberId: "vnd-a", amount: "70000" }, { memberId: "vnd-b", amount: "30000" }],
  }, "Dinner", detail.expenseDate));
  const impact = valueOf(await finance.previewExpenseCorrection(activity.id, expenseId, corrected, 1));
  valueOf(await finance.commitReviewedExpenseCorrection(activity.id, {
    expenseId, expectedVersion: 1, revisionId: "vnd-revision", occurredAt: 400,
    proposed: impact.expense.after, expectedLedger: impact.ledgerToken, reviewedRefundIds: [review.refund.id],
  }));
  const before = valueOf(await finance.getActivityLedger(activity.id));
  const summary = await loadActivitySettlement(activity.id, source);
  assert.deepEqual([summary.effectiveMinor, summary.refundMinor, summary.repaymentMinor, summary.outstandingMinor],
    [80_000n, 20_000n, 5000n, 25_000n]);
  assert.deepEqual(before.balanceSnapshot.balances.map(({ netBalanceMinor }) => netBalanceMinor), [25_000, -25_000]);
  assert.deepEqual(before.suggestions, [{ fromMemberId: "vnd-b", toMemberId: "vnd-a", currency, amountMinor: 25_000 }]);

  const { confirmation } = await prepare(await exportSource());
  assert.deepEqual(await service.restoreBackup({ confirmation, confirmed: true }), { status: "restored" });
  assert.equal((await createActivityRepository(live).getActivity(activity.id)).currency, currency);
  assert.deepEqual(valueOf(await createFinanceRepository(live).getActivityLedger(activity.id)), before);
}));

test("Phase 4A localizes activity ledger labels and legacy fallback names without changing stored names", withFinance(async (finance, _activities, database) => {
  valueOf(await finance.createExpense("trip", 100, expense()));
  valueOf(await finance.createExpense("trip", 150, { ...expense("named"), name: "費用 1" }));
  valueOf(await finance.recordMerchantRefund("trip", 200, { ...refund, recipientId: "a" }));
  const zh = await loadActivityDetail("trip", database, "zh-HK");
  const en = await loadActivityDetail("trip", database, "en");
  assert.deepEqual(zh.expenses.map(({ name }) => name), ["費用 1", "費用 1"]);
  assert.deepEqual(en.expenses.map(({ name }) => name), ["費用 1", "Expense 1"]);
  assert.deepEqual([en.activity.name, en.effectiveMinor, en.balances], [zh.activity.name, zh.effectiveMinor, zh.balances]);
  assert.equal(en.history[0].label, "Merchant refund");
  assert.equal(en.history[0].description, "Expense 1 · Received by Bo");
}));

test("Phase 4A keeps the device language and default currency when restoring a ledger", withRestore(async ({
  directory, activities, service, exportSource, prepare,
}) => {
  const preferencesPath = join(directory, "splitmori-preferences.db");
  const prefsDb = openTestConnection(preferencesPath);
  try {
    await prefsDb.execAsync("CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const preferences = createAppPreferencesStore({
      getItem: async (key) => (await prefsDb.getFirstAsync("SELECT value FROM preferences WHERE key = ?", key))?.value ?? null,
      setItem: async (key, value) => { await prefsDb.runAsync("INSERT OR REPLACE INTO preferences VALUES (?, ?)", key, value); },
    });
    const selected = { language: "en", defaultCurrency: "USD" };
    await preferences.save(selected);
    const { confirmation } = await prepare(await exportSource());
    assert.deepEqual(await service.restoreBackup({ confirmation, confirmed: true }), { status: "restored" });
    assert.equal((await activities.listActivities())[0].id, "trip");
    assert.deepEqual(await preferences.load(), selected);
  } finally {
    prefsDb.close();
  }
}));
