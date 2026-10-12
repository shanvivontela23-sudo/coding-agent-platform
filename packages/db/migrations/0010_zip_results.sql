BEGIN;

CREATE UNIQUE INDEX task_execution_artifacts_one_zip_result
  ON task_execution_artifacts (organization_id, execution_id)
  WHERE kind = 'zip_result';

COMMIT;
