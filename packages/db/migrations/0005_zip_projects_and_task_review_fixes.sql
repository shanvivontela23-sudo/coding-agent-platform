BEGIN;

CREATE TABLE project_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  file_count integer NOT NULL CHECK (file_count >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, version_number),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, storage_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, uploaded_by_user_id) REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

ALTER TABLE project_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY project_versions_tenant_policy ON project_versions
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_versions TO coding_agent_app;

ALTER TABLE project_reports ALTER COLUMN analysed_commit DROP NOT NULL;
ALTER TABLE project_reports ADD COLUMN analysed_version_id uuid;
ALTER TABLE project_reports ADD CONSTRAINT project_reports_analysis_source_check
  CHECK ((analysed_commit IS NOT NULL) <> (analysed_version_id IS NOT NULL));
ALTER TABLE project_reports ADD CONSTRAINT project_reports_version_fk
  FOREIGN KEY (organization_id, project_id, analysed_version_id)
  REFERENCES project_versions (organization_id, project_id, id) ON DELETE CASCADE;

ALTER TABLE tasks ADD COLUMN estimated_cost_usd_min numeric(14,8) CHECK (estimated_cost_usd_min >= 0);
ALTER TABLE tasks ADD COLUMN estimated_cost_usd_max numeric(14,8) CHECK (estimated_cost_usd_max >= estimated_cost_usd_min);
ALTER TABLE tasks ADD COLUMN estimated_time_minutes_min integer CHECK (estimated_time_minutes_min > 0);
ALTER TABLE tasks ADD COLUMN estimated_time_minutes_max integer CHECK (estimated_time_minutes_max >= estimated_time_minutes_min);
ALTER TABLE tasks ADD COLUMN clarification_filtered_count integer NOT NULL DEFAULT 0 CHECK (clarification_filtered_count >= 0);
ALTER TABLE tasks ADD COLUMN clarification_rephrased_count integer NOT NULL DEFAULT 0 CHECK (clarification_rephrased_count >= 0 AND clarification_rephrased_count <= clarification_filtered_count);

COMMIT;
