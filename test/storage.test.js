import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createActivityRepository } from "../src/data/activities.ts";
import { DatabaseInitializationError, initializeDatabase } from "../src/data/database.ts";

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

test("migration v1 and activity/member writes survive closing and reopening SQLite", withTestFile(async (path) => {
  let connection = openTestConnection(path);
  try {
    const database = await initializeDatabase(connection);
    const repository = createActivityRepository(database);
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 1);
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
    assert.equal((await connection.getFirstAsync("PRAGMA user_version")).user_version, 1);
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
