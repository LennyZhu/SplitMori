export const migrations = [
  `
  CREATE TABLE activities (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    currency TEXT NOT NULL CHECK (currency IN ('HKD', 'CNY', 'MOP', 'TWD', 'USD', 'JPY')),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  );

  CREATE TABLE members (
    id TEXT NOT NULL PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE activity_members (
    activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (activity_id, member_id),
    UNIQUE (activity_id, position)
  );

  CREATE INDEX activity_members_by_member ON activity_members(member_id);
  `,
] as const;
