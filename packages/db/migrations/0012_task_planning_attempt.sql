BEGIN;
SELECT pg_advisory_xact_lock(7102026);

-- A failed clarification left a task in draft with no way to retry: gateway
-- run ids cannot be reused. Each retry gets its own planning attempt, which
-- names a fresh gateway run (task:<id>:attempt-<n>); attempt 1 keeps the
-- original run id so existing tasks are unchanged.
ALTER TABLE tasks
  ADD COLUMN planning_attempt integer NOT NULL DEFAULT 1
    CHECK (planning_attempt BETWEEN 1 AND 20);

COMMIT;
