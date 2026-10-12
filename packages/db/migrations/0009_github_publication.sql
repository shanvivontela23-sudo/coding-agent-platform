BEGIN;
SELECT pg_advisory_xact_lock(7102026);

CREATE TABLE task_execution_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('publishing','published','failed','source_changed')),
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 255),
  approved_sha text NOT NULL CHECK (approved_sha ~ '^[0-9a-f]{40}$'),
  current_head_sha text CHECK (current_head_sha IS NULL OR current_head_sha ~ '^[0-9a-f]{40}$'),
  branch_head_sha text CHECK (branch_head_sha IS NULL OR branch_head_sha ~ '^[0-9a-f]{40}$'),
  base_moved_commits integer CHECK (base_moved_commits IS NULL OR base_moved_commits >= 0),
  pull_request_number integer CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  pull_request_url text,
  unproven boolean NOT NULL DEFAULT false,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (organization_id, execution_id),
  FOREIGN KEY (organization_id, task_id, execution_id)
    REFERENCES task_executions (organization_id, task_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, requested_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.prevent_task_execution_publication_downgrade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'published' AND NEW.status <> 'published' THEN
    RAISE EXCEPTION 'published task execution publication is terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_execution_publications_published_terminal
BEFORE UPDATE OF status ON task_execution_publications
FOR EACH ROW
EXECUTE FUNCTION public.prevent_task_execution_publication_downgrade();

ALTER TABLE task_execution_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_execution_publications FORCE ROW LEVEL SECURITY;

CREATE POLICY task_execution_publications_tenant_policy ON task_execution_publications
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON task_execution_publications TO coding_agent_app;
REVOKE DELETE ON task_execution_publications FROM coding_agent_app;

COMMIT;
