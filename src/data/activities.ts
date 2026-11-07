import { isCurrency, type Currency } from "../domain/money.ts";
import type { LocalDatabase, SQLiteConnection, SQLiteReader } from "./database.ts";

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
export const memberNameMaxLength = 50;
type MemberManagementCode = "INVALID_MEMBER_NAME" | "INVALID_MEMBER_BATCH" | "MEMBER_CONFLICT"
  | "ACTIVITY_COMPLETED" | "ACTIVITY_NOT_FOUND" | "MEMBER_NOT_FOUND" | "SHARED_MEMBER";

export class MemberManagementError extends Error {
  readonly code: MemberManagementCode;

  constructor(code: MemberManagementCode) {
    super(code);
    this.name = "MemberManagementError";
    this.code = code;
  }
}

export function validMemberName(name: string): boolean {
  return typeof name === "string" && name.trim() !== "" && Array.from(name.trim()).length <= memberNameMaxLength;
}
export type NewActivity = Pick<Activity, "id" | "name" | "currency"> & {
  readonly members: readonly NewMember[];
};

export type ActivityCreationBlocker = Pick<Activity, "id" | "name"> & { readonly activeCount: number };

export class ActiveActivityLimitError extends Error {
  readonly blocker: ActivityCreationBlocker;

  constructor(blocker: ActivityCreationBlocker) {
    super("The Free active activity limit has been reached");
    this.name = "ActiveActivityLimitError";
    this.blocker = blocker;
  }
}

const activityColumns = "id, name, currency, status, created_at AS createdAt, updated_at AS updatedAt";

function readCreationBlocker(connection: SQLiteReader) {
  return connection.getFirstAsync<ActivityCreationBlocker>(`
    SELECT id, name, COUNT(*) OVER () AS activeCount FROM activities
    WHERE status = 'active' ORDER BY updated_at DESC, id LIMIT 1
  `);
}

async function requireActiveActivitySlot(transaction: SQLiteConnection) {
  const blocker = await readCreationBlocker(transaction);
  // Central write-time eligibility check for creating or reopening an activity.
  if (blocker) throw new ActiveActivityLimitError(blocker);
}

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

export async function readActivityDetail(
  connection: Pick<SQLiteConnection, "getFirstAsync" | "getAllAsync">, id: string,
): Promise<ActivityDetail | null> {
  const activity = await selectActivity(connection, id);
  return activity ? { ...activity, members: await selectMembers(connection, id) } : null;
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
  function addMembers(activityId: string, input: readonly NewMember[]): Promise<ActivityMember[]> {
    const requested = input.map((member) => ({ ...member }));
    return database.write(async (transaction) => {
      const activity = await selectActivity(transaction, activityId);
      if (!activity) throw new MemberManagementError("ACTIVITY_NOT_FOUND");
      if (requested.length === 0 || new Set(requested.map(({ id }) => id)).size !== requested.length
        || requested.some(({ id }) => typeof id !== "string" || id.trim() === "")) {
        throw new MemberManagementError("INVALID_MEMBER_BATCH");
      }
      if (requested.some(({ displayName }) => !validMemberName(displayName))) {
        throw new MemberManagementError("INVALID_MEMBER_NAME");
      }

      const members = await selectMembers(transaction, activityId);
      const ids = new Set(requested.map(({ id }) => id));
      const existing = members.filter(({ id }) => ids.has(id));
      // Stable member IDs are the retry keys. A partial or changed batch is a conflict.
      if (existing.length > 0) {
        if (existing.length !== requested.length || !existing.every((member, index) =>
          member.id === requested[index].id && member.displayName === requested[index].displayName.trim()
          && member.position === existing[0].position + index)) {
          throw new MemberManagementError("MEMBER_CONFLICT");
        }
        return existing;
      }
      if (activity.status !== "active") throw new MemberManagementError("ACTIVITY_COMPLETED");

      const now = Date.now();
      const nextPosition = members.reduce((next, member) => Math.max(next, member.position + 1), 0);
      if (!Number.isSafeInteger(nextPosition + requested.length)) throw new MemberManagementError("INVALID_MEMBER_BATCH");
      const added: ActivityMember[] = [];
      for (const [index, member] of requested.entries()) {
        if (await transaction.getFirstAsync("SELECT id FROM members WHERE id = ?", member.id)) {
          throw new MemberManagementError("MEMBER_CONFLICT");
        }
        added.push(await insertMember(transaction, activityId, member, nextPosition + index, now));
      }
      await transaction.runAsync("UPDATE activities SET updated_at = MAX(updated_at, ?) WHERE id = ?", now, activityId);
      return added;
    });
  }

  function setStatus(id: string, status: ActivityStatus): Promise<Activity> {
    return database.write(async (transaction) => {
      const current = requireActivity(await selectActivity(transaction, id), id);
      if (current.status === status) return current;
      if (status === "active") await requireActiveActivitySlot(transaction);
      const activity = await transaction.getFirstAsync<Activity>(`
        UPDATE activities SET status = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?
        RETURNING ${activityColumns}
      `, status, Date.now(), id);
      return requireActivity(activity, id);
    });
  }

  return {
    getCreationBlocker: () => database.read(readCreationBlocker),

    createActivity(input: NewActivity): Promise<ActivityDetail> {
      return database.write(async (transaction) => {
        requireText(input.id, "Activity ID");
        const name = requireText(input.name, "Activity name");
        if (!isCurrency(input.currency)) throw new Error("Unsupported activity currency");
        if (input.members.length === 0) throw new Error("An activity needs at least one member");
        await requireActiveActivitySlot(transaction);

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
      return database.read((connection) => readActivityDetail(connection, id));
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

    addMember: (activityId: string, input: NewMember): Promise<ActivityMember> =>
      addMembers(activityId, [input]).then((members) => members[0]),

    addMembers,

    renameMember(activityId: string, memberId: string, name: string): Promise<ActivityMember> {
      return database.write(async (transaction) => {
        const activity = await selectActivity(transaction, activityId);
        if (!activity) throw new MemberManagementError("ACTIVITY_NOT_FOUND");
        if (activity.status !== "active") throw new MemberManagementError("ACTIVITY_COMPLETED");
        if (!validMemberName(name)) throw new MemberManagementError("INVALID_MEMBER_NAME");
        const members = await selectMembers(transaction, activityId);
        const member = members.find(({ id }) => id === memberId);
        if (!member) throw new MemberManagementError("MEMBER_NOT_FOUND");
        const displayName = name.trim();
        if (displayName === member.displayName) return member;
        const links = await transaction.getFirstAsync<{ count: number }>(
          "SELECT COUNT(*) AS count FROM activity_members WHERE member_id = ?", memberId,
        );
        if (links?.count !== 1) throw new MemberManagementError("SHARED_MEMBER");
        await transaction.runAsync("UPDATE members SET display_name = ? WHERE id = ?", displayName, memberId);
        await transaction.runAsync("UPDATE activities SET updated_at = MAX(updated_at, ?) WHERE id = ?", Date.now(), activityId);
        return { ...member, displayName };
      });
    },

    listMembers(activityId: string): Promise<ActivityMember[]> {
      return database.read((connection) => selectMembers(connection, activityId));
    },

    completeActivity: (id: string) => setStatus(id, "completed"),
    reopenActivity: (id: string) => setStatus(id, "active"),
  };
}
