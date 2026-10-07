BEGIN;
SELECT pg_advisory_xact_lock(7102026);

CREATE TABLE github_installations (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL UNIQUE CHECK (installation_id > 0),
  connected_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, connected_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY github_installations_tenant_policy ON github_installations
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON github_installations TO coding_agent_app;
REVOKE ALL ON github_installations FROM coding_agent_api;

CREATE TABLE github_installation_states (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX github_installation_states_expiry_idx
  ON github_installation_states (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE github_installation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installation_states FORCE ROW LEVEL SECURITY;
CREATE POLICY github_installation_states_tenant_policy ON github_installation_states
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON github_installation_states TO coding_agent_app;
REVOKE ALL ON github_installation_states FROM coding_agent_api;

ALTER TABLE repositories
  ADD COLUMN github_full_name text,
  ADD COLUMN default_branch text,
  ADD COLUMN last_analyzed_commit_sha text,
  ADD COLUMN analysis_report jsonb,
  ADD CONSTRAINT repositories_last_analyzed_commit_sha_check
    CHECK (last_analyzed_commit_sha IS NULL OR last_analyzed_commit_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT repositories_github_full_name_check
    CHECK (github_full_name IS NULL OR length(btrim(github_full_name)) BETWEEN 3 AND 255),
  ADD CONSTRAINT repositories_default_branch_check
    CHECK (default_branch IS NULL OR length(btrim(default_branch)) BETWEEN 1 AND 255);

COMMIT;
