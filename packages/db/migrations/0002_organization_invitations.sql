BEGIN;
SELECT pg_advisory_xact_lock(7102026);

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('developer', 'rep')),
  invited_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by_user_id uuid,
  FOREIGN KEY (organization_id, invited_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, accepted_by_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX organization_invitations_pending_email_idx
  ON organization_invitations (organization_id, lower(btrim(email)))
  WHERE accepted_at IS NULL;

ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_tenant_policy ON organization_invitations
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON organization_invitations TO coding_agent_app;
REVOKE ALL ON organization_invitations FROM coding_agent_api;

CREATE OR REPLACE FUNCTION public.list_invitations_for_verified_email(uuid, text, boolean)
RETURNS TABLE(
  invitation_id uuid,
  organization_id uuid,
  organization_name text,
  email text,
  role text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email text := pg_catalog.lower(pg_catalog.btrim($2));
BEGIN
  IF $3 IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'confirmed email is required';
  END IF;
  IF $1 IS NULL OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'verified identity is incomplete';
  END IF;

  RETURN QUERY
  SELECT i.id, i.organization_id, o.name, i.email, i.role, i.expires_at
    FROM public.organization_invitations AS i
    JOIN public.organizations AS o ON o.id = i.organization_id
   WHERE pg_catalog.lower(pg_catalog.btrim(i.email)) = v_email
     AND i.accepted_at IS NULL
     AND i.expires_at > pg_catalog.now()
   ORDER BY i.created_at, i.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_invitation_for_verified_email(uuid, text, boolean, uuid)
RETURNS TABLE(user_id uuid, organization_id uuid, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email text := pg_catalog.lower(pg_catalog.btrim($2));
  v_invitation public.organization_invitations%ROWTYPE;
  v_user_id uuid;
BEGIN
  IF $3 IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'confirmed email is required';
  END IF;
  IF $1 IS NULL OR v_email IS NULL OR v_email = '' OR $4 IS NULL THEN
    RAISE EXCEPTION 'verified identity or invitation is incomplete';
  END IF;

  SELECT * INTO v_invitation
    FROM public.organization_invitations
   WHERE id = $4
   FOR UPDATE;

  IF NOT FOUND
     OR v_invitation.accepted_at IS NOT NULL
     OR v_invitation.expires_at <= pg_catalog.now()
     OR pg_catalog.lower(pg_catalog.btrim(v_invitation.email)) <> v_email THEN
    RAISE EXCEPTION 'invitation is unavailable';
  END IF;

  SELECT u.id INTO v_user_id
    FROM public.users AS u
   WHERE u.supabase_user_id = $1
   FOR UPDATE;

  IF v_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.organization_memberships AS m WHERE m.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'user already has an organization membership';
  END IF;

  IF v_user_id IS NULL THEN
    v_user_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.users (id, supabase_user_id, email)
    VALUES (v_user_id, $1, v_email);
  ELSE
    UPDATE public.users SET email = v_email WHERE id = v_user_id;
  END IF;

  INSERT INTO public.organization_memberships (organization_id, user_id, role)
  VALUES (v_invitation.organization_id, v_user_id, v_invitation.role);

  UPDATE public.organization_invitations
     SET accepted_at = pg_catalog.now(), accepted_by_user_id = v_user_id
   WHERE id = v_invitation.id;

  RETURN QUERY SELECT v_user_id, v_invitation.organization_id, v_invitation.role;
END;
$$;

REVOKE ALL ON FUNCTION public.list_invitations_for_verified_email(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_invitations_for_verified_email(uuid, text, boolean) TO coding_agent_api;
REVOKE ALL ON FUNCTION public.accept_invitation_for_verified_email(uuid, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_invitation_for_verified_email(uuid, text, boolean, uuid) TO coding_agent_api;

COMMIT;
