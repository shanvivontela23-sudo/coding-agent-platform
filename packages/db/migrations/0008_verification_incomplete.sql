BEGIN;
SELECT pg_advisory_xact_lock(7102026);

ALTER TABLE task_executions DROP CONSTRAINT IF EXISTS task_executions_status_check;
ALTER TABLE task_executions
  ADD CONSTRAINT task_executions_status_check
  CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out','verification_failed','verification_incomplete','fix_not_reproduced'));

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
  IF p_status NOT IN ('succeeded','failed','verification_failed','verification_incomplete','fix_not_reproduced') THEN
    RAISE EXCEPTION 'finish status must be succeeded, failed, verification_failed, verification_incomplete, or fix_not_reproduced';
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
    WHEN v_final_status IN ('failed','verification_failed','verification_incomplete','fix_not_reproduced') THEN p_failure_code
    ELSE NULL
  END;

  UPDATE public.task_executions
     SET status=v_final_status,
         finished_at=pg_catalog.clock_timestamp(),
         failure_code=v_failure_code,
         failure_message=CASE
           WHEN v_final_status='timed_out' THEN COALESCE(p_failure_message,'Implementation exceeded its wall-clock timeout.')
           WHEN v_final_status IN ('failed','verification_failed','verification_incomplete','fix_not_reproduced') THEN p_failure_message
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

REVOKE ALL ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) FROM coding_agent_api;
GRANT EXECUTE ON FUNCTION public.finish_task_execution(uuid, text, text, text, text) TO coding_agent_worker;

COMMIT;
