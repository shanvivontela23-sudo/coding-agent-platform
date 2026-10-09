BEGIN;

ALTER TABLE tasks
  ADD COLUMN planned_source_commit_sha text
    CHECK (planned_source_commit_sha IS NULL OR planned_source_commit_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN planned_source_version_id uuid,
  ADD CONSTRAINT tasks_planned_source_exclusive
    CHECK (NOT (planned_source_commit_sha IS NOT NULL AND planned_source_version_id IS NOT NULL)),
  ADD CONSTRAINT tasks_planned_source_version_fk
    FOREIGN KEY (organization_id, project_id, planned_source_version_id)
    REFERENCES project_versions (organization_id, project_id, id) ON DELETE RESTRICT;

CREATE TABLE task_executions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
  started_by_user_id uuid NOT NULL,
  source_commit_sha text CHECK (source_commit_sha IS NULL OR source_commit_sha ~ '^[0-9a-f]{40}$'),
  source_version_id uuid,
  budget_usd numeric(14,8) NOT NULL CHECK (budget_usd > 0),
  timeout_seconds integer NOT NULL CHECK (timeout_seconds > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  cancelled_by_user_id uuid,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, task_id, attempt),
  UNIQUE (organization_id, task_id, id),
  CHECK (NOT (source_commit_sha IS NOT NULL AND source_version_id IS NOT NULL)),
  FOREIGN KEY (organization_id, task_id)
    REFERENCES tasks (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, started_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cancelled_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id, source_version_id)
    REFERENCES project_versions (organization_id, project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX task_executions_one_active_per_task
  ON task_executions (organization_id, task_id)
  WHERE status IN ('queued','running');
CREATE INDEX task_executions_queue_idx
  ON task_executions (queued_at, id)
  WHERE status IN ('queued','running');

CREATE TABLE task_execution_checks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  phase text NOT NULL,
  check_key text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending','passed','failed','pre_existing','skipped')),
  command text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, execution_id, phase, check_key),
  FOREIGN KEY (organization_id, task_id, execution_id)
    REFERENCES task_executions (organization_id, task_id, id) ON DELETE CASCADE
);

CREATE TABLE task_execution_artifacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  kind text NOT NULL,
  storage_key text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, execution_id, id),
  FOREIGN KEY (organization_id, task_id, execution_id)
    REFERENCES task_executions (organization_id, task_id, id) ON DELETE CASCADE
);

ALTER TABLE model_calls
  ADD COLUMN task_execution_id uuid,
  ADD CONSTRAINT model_calls_task_execution_fk
    FOREIGN KEY (organization_id, task_id, task_execution_id)
    REFERENCES task_executions (organization_id, task_id, id) ON DELETE SET NULL;

ALTER TABLE task_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY task_executions_tenant_policy ON task_executions
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

ALTER TABLE task_execution_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_execution_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY task_execution_checks_tenant_policy ON task_execution_checks
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

ALTER TABLE task_execution_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_execution_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY task_execution_artifacts_tenant_policy ON task_execution_artifacts
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON task_executions, task_execution_checks, task_execution_artifacts TO coding_agent_app;

CREATE OR REPLACE FUNCTION public.claim_task_execution(p_worker_id text, p_lease_seconds integer)
RETURNS TABLE(
  execution_id uuid,
  organization_id uuid,
  task_id uuid,
  project_id uuid,
  attempt integer,
  source_commit_sha text,
  source_version_id uuid,
  budget_usd numeric,
  timeout_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(pg_catalog.btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 5 and 3600';
  END IF;

  UPDATE public.task_executions AS e
     SET status = 'cancelled',
         finished_at = COALESCE(e.finished_at, pg_catalog.clock_timestamp()),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE e.status = 'running'
     AND e.cancel_requested_at IS NOT NULL
     AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= pg_catalog.clock_timestamp());

  UPDATE public.task_executions AS e
     SET status = 'timed_out',
         finished_at = COALESCE(e.finished_at, pg_catalog.clock_timestamp()),
         failure_code = COALESCE(e.failure_code, 'EXECUTION_TIMEOUT'),
         failure_message = COALESCE(e.failure_message, 'Implementation exceeded its wall-clock timeout.'),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE e.status = 'running'
     AND e.started_at IS NOT NULL
     AND e.started_at + pg_catalog.make_interval(secs => e.timeout_seconds) <= pg_catalog.clock_timestamp();

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
      FROM public.task_executions AS e
     WHERE e.cancel_requested_at IS NULL
       AND (
         e.status = 'queued'
         OR (e.status = 'running' AND e.lease_expires_at <= pg_catalog.clock_timestamp())
       )
       AND (
         e.started_at IS NULL
         OR e.started_at + pg_catalog.make_interval(secs => e.timeout_seconds) > pg_catalog.clock_timestamp()
       )
     ORDER BY e.queued_at, e.id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  ),
  claimed AS (
    UPDATE public.task_executions AS e
       SET status = 'running',
           lease_owner = p_worker_id,
           lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
           started_at = COALESCE(e.started_at, pg_catalog.clock_timestamp()),
           updated_at = pg_catalog.clock_timestamp()
      FROM candidate
     WHERE e.id = candidate.id
    RETURNING e.id, e.organization_id, e.task_id, e.project_id, e.attempt,
              e.source_commit_sha, e.source_version_id, e.budget_usd, e.timeout_seconds
  )
  SELECT claimed.id, claimed.organization_id, claimed.task_id, claimed.project_id,
         claimed.attempt, claimed.source_commit_sha, claimed.source_version_id,
         claimed.budget_usd, claimed.timeout_seconds
    FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_task_execution(
  p_execution_id uuid,
  p_worker_id text,
  p_lease_seconds integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_started_at timestamptz;
  v_timeout_seconds integer;
  v_cancel_requested_at timestamptz;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 5 and 3600';
  END IF;

  SELECT e.status, e.started_at, e.timeout_seconds, e.cancel_requested_at
    INTO v_status, v_started_at, v_timeout_seconds, v_cancel_requested_at
    FROM public.task_executions AS e
   WHERE e.id = p_execution_id
     AND e.lease_owner = p_worker_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;
  IF v_status <> 'running' THEN
    RETURN v_status;
  END IF;
  IF v_cancel_requested_at IS NOT NULL THEN
    UPDATE public.task_executions
       SET status='cancelled', finished_at=pg_catalog.clock_timestamp(),
           lease_owner=NULL, lease_expires_at=NULL, updated_at=pg_catalog.clock_timestamp()
     WHERE id=p_execution_id;
    RETURN 'cancelled';
  END IF;
  IF v_started_at IS NOT NULL
     AND v_started_at + pg_catalog.make_interval(secs => v_timeout_seconds) <= pg_catalog.clock_timestamp() THEN
    UPDATE public.task_executions
       SET status='timed_out', finished_at=pg_catalog.clock_timestamp(),
           failure_code=COALESCE(failure_code,'EXECUTION_TIMEOUT'),
           failure_message=COALESCE(failure_message,'Implementation exceeded its wall-clock timeout.'),
           lease_owner=NULL, lease_expires_at=NULL, updated_at=pg_catalog.clock_timestamp()
     WHERE id=p_execution_id;
    RETURN 'timed_out';
  END IF;

  UPDATE public.task_executions
     SET lease_expires_at=pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=p_execution_id;
  RETURN 'running';
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_task_execution(
  p_execution_id uuid,
  p_worker_id text,
  p_status text,
  p_failure_code text,
  p_failure_message text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_started_at timestamptz;
  v_timeout_seconds integer;
  v_cancel_requested_at timestamptz;
  v_final_status text;
BEGIN
  IF p_status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'finish status must be succeeded or failed';
  END IF;

  SELECT e.started_at, e.timeout_seconds, e.cancel_requested_at
    INTO v_started_at, v_timeout_seconds, v_cancel_requested_at
    FROM public.task_executions AS e
   WHERE e.id=p_execution_id
     AND e.status='running'
     AND e.lease_owner=p_worker_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;

  IF v_cancel_requested_at IS NOT NULL THEN
    v_final_status := 'cancelled';
  ELSIF v_started_at IS NOT NULL
        AND v_started_at + pg_catalog.make_interval(secs => v_timeout_seconds) <= pg_catalog.clock_timestamp() THEN
    v_final_status := 'timed_out';
  ELSE
    v_final_status := p_status;
  END IF;

  UPDATE public.task_executions
     SET status=v_final_status,
         finished_at=pg_catalog.clock_timestamp(),
         failure_code=CASE
           WHEN v_final_status='timed_out' THEN COALESCE(p_failure_code,'EXECUTION_TIMEOUT')
           WHEN v_final_status='failed' THEN p_failure_code
           ELSE NULL
         END,
         failure_message=CASE
           WHEN v_final_status='timed_out' THEN COALESCE(p_failure_message,'Implementation exceeded its wall-clock timeout.')
           WHEN v_final_status='failed' THEN p_failure_message
           ELSE NULL
         END,
         lease_owner=NULL,
         lease_expires_at=NULL,
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=p_execution_id;

  RETURN v_final_status;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_task_execution(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_task_execution(text, integer) TO coding_agent_api;
REVOKE ALL ON FUNCTION public.heartbeat_task_execution(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.heartbeat_task_execution(uuid, text, integer) TO coding_agent_api;
REVOKE ALL ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) TO coding_agent_api;

COMMIT;
