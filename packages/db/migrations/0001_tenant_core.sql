BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coding_agent_app') THEN
    CREATE ROLE coding_agent_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coding_agent_api') THEN
    CREATE ROLE coding_agent_api LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
ALTER ROLE coding_agent_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
ALTER ROLE coding_agent_api LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  supabase_user_id uuid NOT NULL UNIQUE,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'developer', 'rep')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, provider, external_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  repository_id uuid,
  requested_by_user_id uuid NOT NULL,
  status text NOT NULL,
  requirement text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, repository_id) REFERENCES repositories (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, requested_by_user_id) REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE task_steps (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (organization_id, task_id, step_key),
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE model_calls (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cost_usd numeric(14, 8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid,
  task_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks (organization_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.current_organization_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$ SELECT NULLIF(pg_catalog.current_setting('app.organization_id', true), '')::uuid $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_policy ON organizations USING (id = public.current_organization_id()) WITH CHECK (id = public.current_organization_id());
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_policy ON organization_memberships USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id());
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_shared_membership_policy ON users
  USING (EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = users.id AND m.organization_id = public.current_organization_id()
  ));
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant_policy ON projects USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id());
ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY repositories_tenant_policy ON repositories USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id());
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant_policy ON tasks USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id());
ALTER TABLE task_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY task_steps_tenant_policy ON task_steps USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id());
ALTER TABLE model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY model_calls_tenant_policy ON model_calls USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id());
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read_policy ON audit_events USING (organization_id = public.current_organization_id());
CREATE POLICY audit_events_insert_policy ON audit_events FOR INSERT WITH CHECK (organization_id = public.current_organization_id());

GRANT USAGE ON SCHEMA public TO coding_agent_app;
GRANT SELECT ON organizations, users, organization_memberships, projects, repositories, tasks, task_steps, model_calls, audit_events TO coding_agent_app;
GRANT INSERT, UPDATE, DELETE ON users, organization_memberships, projects, repositories, tasks, task_steps, model_calls TO coding_agent_app;
GRANT INSERT ON audit_events TO coding_agent_app;
REVOKE UPDATE, DELETE ON audit_events FROM coding_agent_app;

CREATE OR REPLACE FUNCTION public.lookup_memberships_for_supabase_user(uuid)
RETURNS TABLE(user_id uuid, organization_id uuid, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, m.organization_id, m.role
    FROM public.users AS u
    JOIN public.organization_memberships AS m ON m.user_id = u.id
   WHERE u.supabase_user_id = $1
   ORDER BY m.organization_id
$$;

CREATE OR REPLACE FUNCTION public.create_organization_with_owner(uuid, text, text)
RETURNS TABLE(user_id uuid, organization_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
  v_organization_id uuid;
  v_name text := pg_catalog.btrim($3);
  v_email text := NULLIF(pg_catalog.btrim($2), '');
BEGIN
  IF v_name IS NULL OR pg_catalog.char_length(v_name) < 2 OR pg_catalog.char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'organization name must be 2 to 80 characters after trimming';
  END IF;

  INSERT INTO public.users (id, supabase_user_id, email)
  VALUES (pg_catalog.gen_random_uuid(), $1, v_email)
  ON CONFLICT (supabase_user_id) DO UPDATE SET email = EXCLUDED.email
  RETURNING id INTO v_user_id;

  IF EXISTS (SELECT 1 FROM public.organization_memberships AS m WHERE m.user_id = v_user_id) THEN
    RAISE EXCEPTION 'user already has an organization membership';
  END IF;

  v_organization_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.organizations (id, name) VALUES (v_organization_id, v_name);
  INSERT INTO public.organization_memberships (organization_id, user_id, role)
  VALUES (v_organization_id, v_user_id, 'owner');

  RETURN QUERY SELECT v_user_id, v_organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_memberships_for_supabase_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_memberships_for_supabase_user(uuid) TO coding_agent_api;
REVOKE ALL ON FUNCTION public.create_organization_with_owner(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(uuid, text, text) TO coding_agent_api;
GRANT USAGE ON SCHEMA public TO coding_agent_api;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coding_agent_api;
GRANT coding_agent_app TO coding_agent_api;

COMMIT;
