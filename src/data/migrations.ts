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
  `
  CREATE UNIQUE INDEX activities_id_currency ON activities(id, currency);

  CREATE TABLE financial_events (
    sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991),
    id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
    activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'merchantRefund', 'memberTransfer')),
    occurred_at INTEGER NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
    UNIQUE (activity_id, id)
  ) STRICT;

  CREATE INDEX financial_events_timeline ON financial_events(activity_id, occurred_at, sequence);

  CREATE TABLE expenses (
    id TEXT NOT NULL PRIMARY KEY,
    activity_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    split_mode TEXT NOT NULL CHECK (split_mode IN ('equal', 'treat', 'individual', 'custom')),
    allocation_version INTEGER NOT NULL CHECK (allocation_version BETWEEN 1 AND 9007199254740991),
    UNIQUE (activity_id, id),
    FOREIGN KEY (activity_id, id) REFERENCES financial_events(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, currency) REFERENCES activities(id, currency) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE expense_allocations (
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (expense_id, member_id),
    UNIQUE (expense_id, position),
    FOREIGN KEY (activity_id, expense_id) REFERENCES expenses(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, member_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE merchant_payments (
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (expense_id, member_id),
    FOREIGN KEY (activity_id, expense_id) REFERENCES expenses(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, member_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX merchant_payments_single_payer ON merchant_payments(expense_id);

  CREATE TABLE merchant_refunds (
    id TEXT NOT NULL PRIMARY KEY,
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
    UNIQUE (activity_id, expense_id, id),
    FOREIGN KEY (activity_id, id) REFERENCES financial_events(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, expense_id) REFERENCES expenses(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, recipient_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE refund_reductions (
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    refund_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (refund_id, member_id),
    FOREIGN KEY (activity_id, expense_id, refund_id)
      REFERENCES merchant_refunds(activity_id, expense_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (expense_id, member_id) REFERENCES expense_allocations(expense_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE member_transfers (
    id TEXT NOT NULL PRIMARY KEY,
    activity_id TEXT NOT NULL,
    from_member_id TEXT NOT NULL,
    to_member_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
    CHECK (from_member_id <> to_member_id),
    FOREIGN KEY (activity_id, id) REFERENCES financial_events(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, from_member_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, to_member_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;
  `,
  `
  CREATE TABLE expense_revisions (
    sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991),
    id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version BETWEEN 2 AND 9007199254740991),
    occurred_at INTEGER NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
    currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    split_mode TEXT NOT NULL CHECK (split_mode IN ('equal', 'treat', 'individual', 'custom')),
    allocation_version INTEGER NOT NULL CHECK (allocation_version BETWEEN 1 AND 9007199254740991),
    payer_id TEXT NOT NULL,
    paid_minor INTEGER NOT NULL CHECK (paid_minor = amount_minor),
    reviewed_refund_ids TEXT NOT NULL,
    UNIQUE (expense_id, version),
    UNIQUE (activity_id, id),
    FOREIGN KEY (activity_id, expense_id) REFERENCES expenses(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, currency) REFERENCES activities(id, currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, payer_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX expense_revisions_timeline ON expense_revisions(activity_id, occurred_at, sequence);

  CREATE TABLE expense_revision_allocations (
    activity_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (revision_id, member_id),
    UNIQUE (revision_id, position),
    FOREIGN KEY (activity_id, revision_id) REFERENCES expense_revisions(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, member_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  -- A refund can reduce a share introduced by a revision. The ledger checks the share at the event's position.
  CREATE TABLE refund_reductions_v3 (
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    refund_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (refund_id, member_id),
    FOREIGN KEY (activity_id, expense_id, refund_id)
      REFERENCES merchant_refunds(activity_id, expense_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (activity_id, member_id) REFERENCES activity_members(activity_id, member_id) ON DELETE RESTRICT
  ) STRICT;

  INSERT INTO refund_reductions_v3 (activity_id, expense_id, refund_id, member_id, amount_minor)
  SELECT activity_id, expense_id, refund_id, member_id, amount_minor FROM refund_reductions;
  DROP TABLE refund_reductions;
  ALTER TABLE refund_reductions_v3 RENAME TO refund_reductions;
  `,
  `
  CREATE TABLE quick_draft (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    id TEXT NOT NULL CHECK (length(trim(id)) > 0),
    created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    input_json TEXT NOT NULL
  ) STRICT;

  CREATE TABLE quick_history (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
    created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    input_json TEXT NOT NULL,
    result_json TEXT NOT NULL
  ) STRICT;

  CREATE INDEX quick_history_saved_order ON quick_history(created_at DESC, id);
  `,
  `
  CREATE TABLE quick_split_conversions (
    request_id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(request_id)) > 0),
    history_id TEXT NOT NULL UNIQUE CHECK (length(trim(history_id)) > 0),
    activity_id TEXT NOT NULL,
    expense_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    FOREIGN KEY (activity_id, expense_id) REFERENCES expenses(activity_id, id) ON DELETE RESTRICT
  ) STRICT;
  `,
  `
  CREATE UNIQUE INDEX financial_events_void_target ON financial_events(activity_id, id, kind);

  CREATE TABLE financial_voids (
    sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991),
    id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
    activity_id TEXT NOT NULL,
    target_event_id TEXT NOT NULL UNIQUE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('merchantRefund', 'memberTransfer')),
    occurred_at INTEGER NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
    reason TEXT,
    CHECK (id <> target_event_id),
    FOREIGN KEY (activity_id, target_event_id, target_kind)
      REFERENCES financial_events(activity_id, id, kind) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX financial_voids_timeline ON financial_voids(activity_id, occurred_at, sequence);
  `,
  `
  ALTER TABLE expenses ADD COLUMN name TEXT CHECK (name IS NULL OR length(trim(name)) > 0);
  `,
  `
  ALTER TABLE member_transfers ADD COLUMN note TEXT;
  `,
] as const;
