import { isCurrency, type Currency } from "../domain/money.ts";
import type { LocalDatabase, SQLiteConnection } from "./database.ts";

export type ActivityStatus = "active" | "completed";

export type Activity = {
  readonly id: string;
  readonly name: string;
  readonly currency: Currency;
  readonly status: ActivityStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type Member = {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: number;
};

export type ActivityMember = Member & { readonly activityId: string; readonly position: number };
export type ActivityDetail = Activity & { readonly members: readonly ActivityMember[] };

export type NewMember = Pick<Member, "id" | "displayName">;
export type NewActivity = Pick<Activity, "id" | "name" | "currency"> & {
  readonly members: readonly NewMember[];
};

const activityColumns = "id, name, currency, status, created_at AS createdAt, updated_at AS updatedAt";

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function selectActivity(connection: Pick<SQLiteConnection, "getFirstAsync">, id: string) {
  return connection.getFirstAsync<Activity>(`SELECT ${activityColumns} FROM activities WHERE id = ?`, id);
}

function selectMembers(connection: Pick<SQLiteConnection, "getAllAsync">, activityId: string) {
  return connection.getAllAsync<ActivityMember>(`
    SELECT m.id, m.display_name AS displayName, m.created_at AS createdAt,
           am.activity_id AS activityId, am.position
    FROM activity_members AS am JOIN members AS m ON m.id = am.member_id
    WHERE am.activity_id = ? ORDER BY am.position
  `, activityId);
}

async function insertMember(
  transaction: SQLiteConnection, activityId: string, input: NewMember, position: number, createdAt: number,
): Promise<ActivityMember> {
  requireText(input.id, "Member ID");
  const displayName = requireText(input.displayName, "Member display name");
  await transaction.runAsync(
    "INSERT INTO members (id, display_name, created_at) VALUES (?, ?, ?)", input.id, displayName, createdAt,
  );
  await transaction.runAsync(
    "INSERT INTO activity_members (activity_id, member_id, position) VALUES (?, ?, ?)", activityId, input.id, position,
  );
  return { id: input.id, displayName, createdAt, activityId, position };
}

function requireActivity(activity: Activity | null, id: string): Activity {
  if (!activity) throw new Error(`Activity ${id} was not found`);
  return activity;
}

export function createActivityRepository(database: LocalDatabase) {
  function setStatus(id: string, status: ActivityStatus): Promise<Activity> {
    return database.write(async (transaction) => {
      const current = requireActivity(await selectActivity(transaction, id), id);
      if (current.status === status) return current;
      // An entitlement service can check the active-activity limit in this same transaction.
      const activity = await transaction.getFirstAsync<Activity>(`
        UPDATE activities SET status = ?, updated_at = MAX(updated_at, ?) WHERE id = ?
        RETURNING ${activityColumns}
      `, status, Date.now(), id);
      return requireActivity(activity, id);
    });
  }

  return {
    createActivity(input: NewActivity): Promise<ActivityDetail> {
      return database.write(async (transaction) => {
        requireText(input.id, "Activity ID");
        const name = requireText(input.name, "Activity name");
        if (!isCurrency(input.currency)) throw new Error("Unsupported activity currency");
        if (input.members.length === 0) throw new Error("An activity needs at least one member");

        const now = Date.now();
        const activity: Activity = {
          id: input.id, name, currency: input.currency, status: "active", createdAt: now, updatedAt: now,
        };
        await transaction.runAsync(`
          INSERT INTO activities (id, name, currency, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, activity.id, activity.name, activity.currency, activity.status, now, now);

        const members: ActivityMember[] = [];
        for (const [position, inputMember] of input.members.entries()) {
          members.push(await insertMember(transaction, activity.id, inputMember, position, now));
        }
        return { ...activity, members };
      });
    },

    listActivities(): Promise<Activity[]> {
      return database.read((connection) => connection.getAllAsync<Activity>(`
        SELECT ${activityColumns} FROM activities ORDER BY created_at DESC, id
      `));
    },

    getActivity(id: string): Promise<ActivityDetail | null> {
      return database.read(async (connection) => {
        const activity = await selectActivity(connection, id);
        return activity ? { ...activity, members: await selectMembers(connection, id) } : null;
      });
    },

    renameActivity(id: string, name: string): Promise<Activity> {
      return database.write(async (transaction) => {
        const activity = await transaction.getFirstAsync<Activity>(`
          UPDATE activities SET name = ?, updated_at = MAX(updated_at, ?) WHERE id = ?
          RETURNING ${activityColumns}
        `, requireText(name, "Activity name"), Date.now(), id);
        return requireActivity(activity, id);
      });
    },

    addMember(activityId: string, input: NewMember): Promise<ActivityMember> {
      return database.write(async (transaction) => {
        requireActivity(await selectActivity(transaction, activityId), activityId);
        const next = await transaction.getFirstAsync<{ position: number }>(`
          SELECT COALESCE(MAX(position) + 1, 0) AS position FROM activity_members WHERE activity_id = ?
        `, activityId);
        if (!next) throw new Error("Cannot determine activity member position");
        const now = Date.now();
        const member = await insertMember(transaction, activityId, input, next.position, now);
        await transaction.runAsync(
          "UPDATE activities SET updated_at = MAX(updated_at, ?) WHERE id = ?", now, activityId,
        );
        return member;
      });
    },

    listMembers(activityId: string): Promise<ActivityMember[]> {
      return database.read((connection) => selectMembers(connection, activityId));
    },

    completeActivity: (id: string) => setStatus(id, "completed"),
    reopenActivity: (id: string) => setStatus(id, "active"),
  };
}
