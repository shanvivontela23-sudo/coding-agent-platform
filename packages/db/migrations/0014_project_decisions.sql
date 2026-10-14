BEGIN;
SELECT pg_advisory_xact_lock(7102026);

-- Project memory is append/supersede only. The project id is included in the
-- task relationship so a same-tenant task cannot be attached to the wrong
-- project. Runtime roles reach this table only through coding_agent_app and
-- the existing withTenant() transaction boundary.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_organization_project_id_key
  UNIQUE (organization_id, project_id, id);

CREATE TABLE project_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  task_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'command_worked',
    'command_failed',
    'convention',
    'reviewer_accepted',
    'reviewer_rejected',
    'rep_preference'
  )),
  summary text NOT NULL CHECK (pg_catalog.char_length(summary) BETWEEN 1 AND 300),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (pg_catalog.jsonb_typeof(detail) = 'object' AND pg_catalog.octet_length(detail::text) <= 16384),
  source text NOT NULL CHECK (source IN ('verification', 'publication', 'zip_promotion', 'plan_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_by uuid,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, task_id)
    REFERENCES tasks (organization_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, superseded_by)
    REFERENCES project_decisions (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX project_decisions_current_project_idx
  ON project_decisions (organization_id, project_id, created_at DESC, id DESC)
  WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX project_decisions_one_current_memory_key
  ON project_decisions (organization_id, project_id, source, (detail->>'memoryKey'))
  WHERE superseded_by IS NULL AND detail ? 'memoryKey';

ALTER TABLE project_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY project_decisions_tenant_policy ON project_decisions
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON project_decisions TO coding_agent_app;
REVOKE DELETE ON project_decisions FROM coding_agent_app;

COMMIT;

