BEGIN;
SELECT pg_advisory_xact_lock(7102026);

ALTER TABLE tasks
  ADD COLUMN original_ticket_encrypted text,
  ADD COLUMN masked_ticket text,
  ADD COLUMN job_type text,
  ADD COLUMN what_i_understand text,
  ADD COLUMN proposed_approach text,
  ADD COLUMN job_size text CHECK (job_size IS NULL OR job_size IN ('small','medium','large')),
  ADD COLUMN estimated_cost_usd numeric(14,8) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  ADD COLUMN estimated_time_minutes integer CHECK (estimated_time_minutes IS NULL OR estimated_time_minutes > 0),
  ADD COLUMN confirmed_requirement text,
  ADD COLUMN confirmed_plan text,
  ADD COLUMN task_model_budget_usd numeric(14,8) NOT NULL DEFAULT 0.50 CHECK (task_model_budget_usd > 0),
  ADD COLUMN approved_at timestamptz;

CREATE TABLE task_questions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 5),
  question text NOT NULL,
  suggested_answer text NOT NULL,
  answer text,
  answer_status text NOT NULL DEFAULT 'unanswered'
    CHECK (answer_status IN ('unanswered','answered','developer_needed')),
  routed_to_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  UNIQUE (organization_id, task_id, ordinal),
  FOREIGN KEY (organization_id, task_id)
    REFERENCES tasks (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, routed_to_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

ALTER TABLE task_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY task_questions_tenant_policy ON task_questions
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON task_questions TO coding_agent_app;

COMMIT;
