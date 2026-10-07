BEGIN;
SELECT pg_advisory_xact_lock(7102026);

CREATE TABLE github_installations (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL UNIQUE CHECK (installation_id > 0),
  connected_by_user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('connected', 'disconnected')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, connected_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE github_connection_states (
  nonce_hash text PRIMARY KEY CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX github_connection_states_tenant_idx
  ON github_connection_states (organization_id, user_id, expires_at);

ALTER TABLE repositories ADD COLUMN github_repository_id bigint;
ALTER TABLE repositories ADD COLUMN full_name text;
ALTER TABLE repositories ADD COLUMN default_branch text;
ALTER TABLE repositories ADD COLUMN last_analysed_commit text
  CHECK (last_analysed_commit IS NULL OR last_analysed_commit ~ '^[0-9a-f]{40}$');
CREATE UNIQUE INDEX repositories_github_id_idx
  ON repositories (organization_id, github_repository_id)
  WHERE github_repository_id IS NOT NULL;

CREATE TABLE project_reports (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  report jsonb NOT NULL,
  analysed_commit text NOT NULL CHECK (analysed_commit ~ '^[0-9a-f]{40}$'),
  analysed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects (organization_id, id) ON DELETE CASCADE
);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY github_installations_tenant_policy ON github_installations
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

ALTER TABLE github_connection_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_connection_states FORCE ROW LEVEL SECURITY;
CREATE POLICY github_connection_states_tenant_policy ON github_connection_states
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

ALTER TABLE project_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY project_reports_tenant_policy ON project_reports
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON github_installations, github_connection_states, project_reports TO coding_agent_app;

COMMIT;
