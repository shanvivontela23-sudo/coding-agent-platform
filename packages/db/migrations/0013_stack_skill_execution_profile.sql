BEGIN;
SELECT pg_advisory_xact_lock(7102026);

-- Stack skills (PR 1). Records which built-in stack skill shaped the accepted
-- plan, and pins one immutable execution profile per execution so coding,
-- baseline verification and patched verification all use the same skill
-- version, commands, guide text and sandbox template. Every column is nullable:
-- existing rows and generic (no-skill) runs keep working unchanged. Access is
-- through the existing table grants and tenant RLS policies.
ALTER TABLE tasks
  ADD COLUMN planning_skill_id text
    CHECK (planning_skill_id IS NULL OR planning_skill_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD COLUMN planning_skill_version text
    CHECK (planning_skill_version IS NULL OR planning_skill_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  ADD CONSTRAINT tasks_planning_skill_pair
    CHECK ((planning_skill_id IS NULL) = (planning_skill_version IS NULL));

ALTER TABLE task_executions
  ADD COLUMN execution_profile jsonb
    CHECK (execution_profile IS NULL OR (pg_catalog.jsonb_typeof(execution_profile) = 'object' AND pg_catalog.octet_length(execution_profile::text) <= 65536)),
  ADD COLUMN implementation_skill_id text
    CHECK (implementation_skill_id IS NULL OR implementation_skill_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD COLUMN implementation_skill_version text
    CHECK (implementation_skill_version IS NULL OR implementation_skill_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  ADD COLUMN planning_skill_id text
    CHECK (planning_skill_id IS NULL OR planning_skill_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD COLUMN planning_skill_version text
    CHECK (planning_skill_version IS NULL OR planning_skill_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  ADD COLUMN sandbox_template_id text
    CHECK (sandbox_template_id IS NULL OR (pg_catalog.length(sandbox_template_id) BETWEEN 1 AND 200 AND sandbox_template_id !~ '[[:space:]]')),
  ADD CONSTRAINT task_executions_implementation_skill_pair
    CHECK ((implementation_skill_id IS NULL) = (implementation_skill_version IS NULL)),
  ADD CONSTRAINT task_executions_planning_skill_pair
    CHECK ((planning_skill_id IS NULL) = (planning_skill_version IS NULL)),
  ADD CONSTRAINT task_executions_profile_template
    CHECK (execution_profile IS NULL OR sandbox_template_id IS NOT NULL);

COMMIT;
