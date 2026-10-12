BEGIN;
SELECT pg_advisory_xact_lock(7102026);

ALTER TABLE task_executions
  ADD COLUMN zip_build_status text
    CHECK (zip_build_status IS NULL OR zip_build_status IN ('pending','building','ready','failed')),
  ADD COLUMN zip_build_started_at timestamptz,
  ADD COLUMN zip_build_error_code text,
  ADD COLUMN zip_build_error_message text;

CREATE INDEX task_executions_zip_build_pending_idx
  ON task_executions (finished_at, id)
  WHERE zip_build_status = 'pending';

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
  v_queue_zip boolean;
BEGIN
  IF p_status NOT IN ('succeeded','failed','verification_failed','verification_incomplete','fix_not_reproduced') THEN
    RAISE EXCEPTION 'finish status must be succeeded, failed, verification_failed, verification_incomplete, or fix_not_reproduced';
  END IF;

  SELECT e.organization_id,e.task_id,e.started_at,e.timeout_seconds,e.cancel_requested_at,e.failure_code,e.source_version_id
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
  v_queue_zip := v_final_status='succeeded' AND v_row.source_version_id IS NOT NULL;

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
         zip_build_status=CASE WHEN v_queue_zip THEN 'pending' ELSE zip_build_status END,
         zip_build_started_at=CASE WHEN v_queue_zip THEN NULL ELSE zip_build_started_at END,
         zip_build_error_code=CASE WHEN v_queue_zip THEN NULL ELSE zip_build_error_code END,
         zip_build_error_message=CASE WHEN v_queue_zip THEN NULL ELSE zip_build_error_message END,
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=p_execution_id;

  PERFORM public.task_execution_terminal_audit(
    v_row.organization_id,v_row.task_id,p_execution_id,v_final_status,v_failure_code
  );
  RETURN v_final_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_pending_zip_result_build()
RETURNS TABLE(
  execution_id uuid,
  organization_id uuid,
  task_id uuid,
  project_id uuid,
  source_version_id uuid,
  source_storage_key text,
  source_sha256 text,
  result_patch text,
  change_document text,
  result_metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.task_executions AS e
     SET zip_build_status='failed',
         zip_build_started_at=NULL,
         zip_build_error_code='ZIP_RESULT_INTERRUPTED',
         zip_build_error_message='ZIP result build was interrupted. Retry building the ZIP.',
         updated_at=pg_catalog.clock_timestamp()
   WHERE e.zip_build_status='building'
     AND e.zip_build_started_at IS NOT NULL
     AND e.zip_build_started_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => 10);

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
      FROM public.task_executions AS e
      JOIN public.repositories AS r
        ON r.organization_id=e.organization_id
       AND r.project_id=e.project_id
       AND r.provider='upload'
     WHERE e.zip_build_status='pending'
       AND e.status IN ('succeeded','fix_not_reproduced')
       AND e.source_version_id IS NOT NULL
     ORDER BY e.finished_at,e.id
     FOR UPDATE OF e SKIP LOCKED
     LIMIT 1
  ),
  claimed AS (
    UPDATE public.task_executions AS e
       SET zip_build_status='building',
           zip_build_started_at=pg_catalog.clock_timestamp(),
           zip_build_error_code=NULL,
           zip_build_error_message=NULL,
           updated_at=pg_catalog.clock_timestamp()
      FROM candidate
     WHERE e.id=candidate.id
       AND e.zip_build_status='pending'
    RETURNING e.id,e.organization_id,e.task_id,e.project_id,e.source_version_id,
              e.result_patch,e.change_document,e.result_metadata
  )
  SELECT c.id,c.organization_id,c.task_id,c.project_id,c.source_version_id,
         pv.storage_key,pv.sha256,c.result_patch,c.change_document,c.result_metadata
    FROM claimed AS c
    JOIN public.project_versions AS pv
      ON pv.organization_id=c.organization_id
     AND pv.project_id=c.project_id
     AND pv.id=c.source_version_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_zip_result_build(
  p_execution_id uuid,
  p_artifact_id uuid,
  p_storage_key text,
  p_sha256 text,
  p_size_bytes bigint,
  p_file_count integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
  v_inserted uuid;
BEGIN
  SELECT e.organization_id,e.task_id,e.project_id,e.source_version_id
    INTO v_row
    FROM public.task_executions AS e
   WHERE e.id=p_execution_id
     AND e.zip_build_status='building'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;

  INSERT INTO public.task_execution_artifacts
    (id,organization_id,task_id,execution_id,kind,storage_key,sha256,size_bytes,metadata)
  VALUES
    (p_artifact_id,v_row.organization_id,v_row.task_id,p_execution_id,'zip_result',
     p_storage_key,p_sha256,p_size_bytes,
     pg_catalog.jsonb_build_object(
       'sourceVersionId',v_row.source_version_id::text,
       'artifactVersionId',p_artifact_id::text,
       'fileCount',p_file_count
     ))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted;

  UPDATE public.task_executions
     SET zip_build_status='ready',
         zip_build_started_at=NULL,
         zip_build_error_code=NULL,
         zip_build_error_message=NULL,
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=p_execution_id
     AND zip_build_status='building';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZIP result build ownership was lost during completion';
  END IF;
  RETURN CASE WHEN v_inserted IS NULL THEN 'existing' ELSE 'inserted' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_zip_result_build(
  p_execution_id uuid,
  p_error_code text,
  p_error_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.task_executions
     SET zip_build_status='failed',
         zip_build_started_at=NULL,
         zip_build_error_code=p_error_code,
         zip_build_error_message=p_error_message,
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=p_execution_id
     AND zip_build_status='building';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_zip_result_build() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_zip_result_build(uuid,uuid,text,text,bigint,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_zip_result_build(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_zip_result_build() TO coding_agent_worker;
GRANT EXECUTE ON FUNCTION public.complete_zip_result_build(uuid,uuid,text,text,bigint,integer) TO coding_agent_worker;
GRANT EXECUTE ON FUNCTION public.fail_zip_result_build(uuid,text,text) TO coding_agent_worker;

COMMIT;
