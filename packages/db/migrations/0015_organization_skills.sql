BEGIN;
SELECT pg_advisory_xact_lock(7102026);

-- Organization skills: short coding rules an organization owner writes once
-- and Dhara applies to every matching task. Authoring is owner-only in the API;
-- the table is tenant-scoped like every other runtime table and is reached only
-- through coding_agent_app inside withTenant().
CREATE TABLE organization_skills (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 100),
  body text NOT NULL CHECK (pg_catalog.char_length(body) BETWEEN 1 AND 2000),
  applies_to_stacks text[]
    CHECK (applies_to_stacks IS NULL OR (pg_catalog.cardinality(applies_to_stacks) BETWEEN 1 AND 10
      AND pg_catalog.array_to_string(applies_to_stacks, ',') ~ '^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$')),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE INDEX organization_skills_org_idx ON organization_skills (organization_id, created_at, id);

ALTER TABLE organization_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_skills_tenant_policy ON organization_skills
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON organization_skills TO coding_agent_app;

COMMIT;
