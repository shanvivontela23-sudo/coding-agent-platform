BEGIN;
SELECT pg_advisory_xact_lock(7102026);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coding_agent_worker') THEN
    CREATE ROLE coding_agent_worker LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
ALTER ROLE coding_agent_worker LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA public TO coding_agent_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coding_agent_worker;
GRANT coding_agent_app TO coding_agent_worker;

REVOKE DELETE ON task_executions, task_execution_checks, task_execution_artifacts FROM coding_agent_app;

ALTER TABLE task_executions
  ADD COLUMN source_prepared_at timestamptz,
  ADD COLUMN coding_started_at timestamptz,
  ADD COLUMN coding_finished_at timestamptz,
  ADD COLUMN patch_exported_at timestamptz,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN result_patch text,
  ADD COLUMN change_document text,
  ADD COLUMN result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN cost_usd numeric(14,8) CHECK (cost_usd IS NULL OR cost_usd >= 0);

ALTER TABLE task_executions DROP CONSTRAINT IF EXISTS task_executions_status_check;
ALTER TABLE task_executions
  ADD CONSTRAINT task_executions_status_check
  CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out','verification_failed','fix_not_reproduced'));

CREATE OR REPLACE FUNCTION public.pin_task_source_on_plan_ready()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_commit text;
  v_version uuid;
BEGIN
  IF NEW.status <> 'plan_ready' OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF (NEW.planned_source_commit_sha IS NOT NULL) <> (NEW.planned_source_version_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT pr.analysed_commit, pr.analysed_version_id
    INTO v_commit, v_version
    FROM public.project_reports AS pr
   WHERE pr.organization_id = NEW.organization_id
     AND pr.project_id = NEW.project_id
   LIMIT 1;

  IF NOT FOUND OR ((v_commit IS NOT NULL) = (v_version IS NOT NULL)) THEN
    RAISE EXCEPTION 'task plan source is unavailable';
  END IF;

  NEW.planned_source_commit_sha := v_commit;
  NEW.planned_source_version_id := v_version;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.task_execution_terminal_audit(
  p_organization_id uuid,
  p_task_id uuid,
  p_execution_id uuid,
  p_status text,
  p_failure_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_type text;
BEGIN
  v_event_type := CASE p_status
    WHEN 'succeeded' THEN 'task_execution_succeeded'
    WHEN 'cancelled' THEN 'task_execution_cancelled'
    WHEN 'timed_out' THEN 'task_execution_timed_out'
    ELSE 'task_execution_failed'
  END;

  INSERT INTO public.audit_events (id,organization_id,actor_user_id,task_id,event_type,payload)
  VALUES (
    pg_catalog.gen_random_uuid(),
    p_organization_id,
    NULL,
    p_task_id,
    v_event_type,
    pg_catalog.jsonb_build_object(
      'execution_id', p_execution_id::text,
      'failure_code', p_failure_code
    )
  );
END;
$$;

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
DECLARE
  v_row record;
BEGIN
  IF NULLIF(pg_catalog.btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 5 and 3600';
  END IF;

  FOR v_row IN
    UPDATE public.task_executions AS e
       SET status = 'cancelled',
           finished_at = COALESCE(e.finished_at, pg_catalog.clock_timestamp()),
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE e.status = 'running'
       AND e.cancel_requested_at IS NOT NULL
       AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= pg_catalog.clock_timestamp())
    RETURNING e.organization_id,e.task_id,e.id,e.failure_code
  LOOP
    PERFORM public.task_execution_terminal_audit(
      v_row.organization_id,v_row.task_id,v_row.id,'cancelled',v_row.failure_code
    );
  END LOOP;

  FOR v_row IN
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
       AND e.started_at + pg_catalog.make_interval(secs => e.timeout_seconds) <= pg_catalog.clock_timestamp()
    RETURNING e.organization_id,e.task_id,e.id,e.failure_code
  LOOP
    PERFORM public.task_execution_terminal_audit(
      v_row.organization_id,v_row.task_id,v_row.id,'timed_out',v_row.failure_code
    );
  END LOOP;

  FOR v_row IN
    UPDATE public.task_executions AS e
       SET status = 'failed',
           finished_at = COALESCE(e.finished_at, pg_catalog.clock_timestamp()),
           failure_code = 'WORKER_INTERRUPTED',
           failure_message = 'Implementation worker stopped during paid coding. Start a new attempt to retry safely.',
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE e.status = 'running'
       AND e.lease_expires_at <= pg_catalog.clock_timestamp()
       AND e.coding_started_at IS NOT NULL
       AND e.coding_finished_at IS NULL
    RETURNING e.organization_id,e.task_id,e.id,e.failure_code
  LOOP
    PERFORM public.task_execution_terminal_audit(
      v_row.organization_id,v_row.task_id,v_row.id,'failed',v_row.failure_code
    );
  END LOOP;

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
      FROM public.task_executions AS e
     WHERE e.cancel_requested_at IS NULL
       AND (
         e.status = 'queued'
         OR (
           e.status = 'running'
           AND e.lease_expires_at <= pg_catalog.clock_timestamp()
           AND (e.coding_started_at IS NULL OR e.coding_finished_at IS NOT NULL)
         )
       )
       AND (
         e.started_at IS NULL
         OR e.started_at + pg_catalog.make_interval(secs => e.timeout_seconds) > pg_catalog.clock_timestamp()
       )
     ORDER BY e.queued_at,e.id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  ), claimed AS (
    UPDATE public.task_executions AS e
       SET status = 'running',
           lease_owner = p_worker_id,
           lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
           started_at = COALESCE(e.started_at, pg_catalog.clock_timestamp()),
           updated_at = pg_catalog.clock_timestamp()
      FROM candidate
     WHERE e.id = candidate.id
    RETURNING e.id,e.organization_id,e.task_id,e.project_id,e.attempt,
              e.source_commit_sha,e.source_version_id,e.budget_usd,e.timeout_seconds
  )
  SELECT claimed.id,claimed.organization_id,claimed.task_id,claimed.project_id,
         claimed.attempt,claimed.source_commit_sha,claimed.source_version_id,
         claimed.budget_usd,claimed.timeout_seconds
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
  v_row record;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 5 and 3600';
  END IF;

  SELECT e.organization_id,e.task_id,e.status,e.started_at,e.timeout_seconds,
         e.cancel_requested_at,e.failure_code
    INTO v_row
    FROM public.task_executions AS e
   WHERE e.id = p_execution_id
     AND e.lease_owner = p_worker_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;
  IF v_row.status <> 'running' THEN
    RETURN v_row.status;
  END IF;

  IF v_row.cancel_requested_at IS NOT NULL THEN
    UPDATE public.task_executions
       SET status='cancelled',
           finished_at=pg_catalog.clock_timestamp(),
           lease_owner=NULL,
           lease_expires_at=NULL,
           updated_at=pg_catalog.clock_timestamp()
     WHERE id=p_execution_id;
    PERFORM public.task_execution_terminal_audit(
      v_row.organization_id,v_row.task_id,p_execution_id,'cancelled',v_row.failure_code
    );
    RETURN 'cancelled';
  END IF;

  IF v_row.started_at IS NOT NULL
     AND v_row.started_at + pg_catalog.make_interval(secs => v_row.timeout_seconds) <= pg_catalog.clock_timestamp() THEN
    UPDATE public.task_executions
       SET status='timed_out',
           finished_at=pg_catalog.clock_timestamp(),
           failure_code=COALESCE(failure_code,'EXECUTION_TIMEOUT'),
           failure_message=COALESCE(failure_message,'Implementation exceeded its wall-clock timeout.'),
           lease_owner=NULL,
           lease_expires_at=NULL,
           updated_at=pg_catalog.clock_timestamp()
     WHERE id=p_execution_id
     RETURNING failure_code INTO v_row.failure_code;
    PERFORM public.task_execution_terminal_audit(
      v_row.organization_id,v_row.task_id,p_execution_id,'timed_out',v_row.failure_code
    );
    RETURN 'timed_out';
  END IF;

  UPDATE public.task_executions
     SET lease_expires_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs => p_lease_seconds),
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
  v_row record;
  v_final_status text;
  v_failure_code text;
BEGIN
  IF p_status NOT IN ('succeeded','failed','verification_failed','fix_not_reproduced') THEN
    RAISE EXCEPTION 'finish status must be succeeded, failed, verification_failed, or fix_not_reproduced';
  END IF;

  SELECT e.organization_id,e.task_id,e.started_at,e.timeout_seconds,e.cancel_requested_at,e.failure_code
    INTO v_row
    FROM public.task_executions AS e
   WHERE e.id=p_execution_id
     AND e.status='running'
     AND e.lease_owner=p_worker_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;

  IF v_row.cancel_requested_at IS NOT NULL THEN
    v_final_status := 'cancelled';
  ELSIF v_row.started_at IS NOT NULL
        AND v_row.started_at + pg_catalog.make_interval(secs => v_row.timeout_seconds) <= pg_catalog.clock_timestamp() THEN
    v_final_status := 'timed_out';
  ELSE
    v_final_status := p_status;
  END IF;

  v_failure_code := CASE
    WHEN v_final_status='timed_out' THEN COALESCE(p_failure_code,'EXECUTION_TIMEOUT')
    WHEN v_final_status IN ('failed','verification_failed','fix_not_reproduced') THEN p_failure_code
    ELSE NULL
  END;

  UPDATE public.task_executions
     SET status=v_final_status,
         finished_at=pg_catalog.clock_timestamp(),
         failure_code=v_failure_code,
         failure_message=CASE
           WHEN v_final_status='timed_out' THEN COALESCE(p_failure_message,'Implementation exceeded its wall-clock timeout.')
           WHEN v_final_status IN ('failed','verification_failed','fix_not_reproduced') THEN p_failure_message
           ELSE NULL
         END,
         lease_owner=NULL,
         lease_expires_at=NULL,
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=p_execution_id;

  PERFORM public.task_execution_terminal_audit(
    v_row.organization_id,v_row.task_id,p_execution_id,v_final_status,v_failure_code
  );
  RETURN v_final_status;
END;
$$;

REVOKE ALL ON FUNCTION public.task_execution_terminal_audit(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_execution_terminal_audit(uuid, uuid, uuid, text, text) FROM coding_agent_api;
REVOKE ALL ON FUNCTION public.task_execution_terminal_audit(uuid, uuid, uuid, text, text) FROM coding_agent_worker;

REVOKE ALL ON FUNCTION public.claim_task_execution(text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_task_execution(text, integer) FROM coding_agent_api;
GRANT EXECUTE ON FUNCTION public.claim_task_execution(text, integer) TO coding_agent_worker;

REVOKE ALL ON FUNCTION public.heartbeat_task_execution(uuid, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.heartbeat_task_execution(uuid, text, integer) FROM coding_agent_api;
GRANT EXECUTE ON FUNCTION public.heartbeat_task_execution(uuid, text, integer) TO coding_agent_worker;

REVOKE ALL ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) FROM coding_agent_api;
GRANT EXECUTE ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) TO coding_agent_worker;

COMMIT;
