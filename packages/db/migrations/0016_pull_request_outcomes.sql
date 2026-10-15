BEGIN;
SELECT pg_advisory_xact_lock(7102026);

-- What happened to a pull request Dhara published: still open, merged, or
-- closed without merging. A worker sync (and, where configured, a GitHub
-- webhook) records it; a merged or closed PR also updates project memory.
ALTER TABLE task_execution_publications
  ADD COLUMN pull_request_state text
    CHECK (pull_request_state IS NULL OR pull_request_state IN ('open', 'merged', 'closed')),
  ADD COLUMN pull_request_resolved_at timestamptz,
  ADD COLUMN pull_request_checked_at timestamptz,
  ADD CONSTRAINT task_execution_publications_resolved_state
    CHECK ((pull_request_resolved_at IS NULL) = (pull_request_state IS NULL OR pull_request_state = 'open'));

CREATE INDEX task_execution_publications_unresolved_idx
  ON task_execution_publications (pull_request_checked_at NULLS FIRST, published_at)
  WHERE status = 'published' AND pull_request_number IS NOT NULL AND (pull_request_state IS NULL OR pull_request_state = 'open');

-- A merged or closed outcome is final.
CREATE OR REPLACE FUNCTION public.prevent_pull_request_outcome_reopen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.pull_request_state IN ('merged', 'closed') AND NEW.pull_request_state IS DISTINCT FROM OLD.pull_request_state THEN
    RAISE EXCEPTION 'pull request outcome is final';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_execution_publications_outcome_final
BEFORE UPDATE OF pull_request_state ON task_execution_publications
FOR EACH ROW
EXECUTE FUNCTION public.prevent_pull_request_outcome_reopen();

-- Worker: published pull requests whose outcome is not known yet, across
-- tenants, least recently checked first. Returns only what the sync needs.
CREATE OR REPLACE FUNCTION public.list_unresolved_pull_requests(p_limit integer, p_min_age_seconds integer)
RETURNS TABLE (
  organization_id uuid,
  publication_id uuid,
  repository_full_name text,
  pull_request_number integer,
  installation_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'limit must be between 1 and 100'; END IF;
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 0 OR p_min_age_seconds > 86400 THEN RAISE EXCEPTION 'minimum age must be between 0 and 86400 seconds'; END IF;
  RETURN QUERY
  SELECT p.organization_id, p.id, r.full_name, p.pull_request_number, gi.installation_id
    FROM public.task_execution_publications AS p
    JOIN public.tasks AS t ON t.organization_id = p.organization_id AND t.id = p.task_id
    JOIN public.repositories AS r ON r.organization_id = t.organization_id AND r.id = t.repository_id AND r.provider = 'github'
    JOIN public.github_installations AS gi ON gi.organization_id = p.organization_id AND gi.status = 'connected'
   WHERE p.status = 'published'
     AND p.pull_request_number IS NOT NULL
     AND r.full_name IS NOT NULL
     AND (p.pull_request_state IS NULL OR p.pull_request_state = 'open')
     AND (p.pull_request_checked_at IS NULL OR p.pull_request_checked_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => p_min_age_seconds))
   ORDER BY p.pull_request_checked_at NULLS FIRST, p.published_at, p.id
   LIMIT p_limit;
END;
$$;

-- Webhook: which tenant publication a GitHub pull_request event is about.
-- Matches installation, repository and PR number together.
CREATE OR REPLACE FUNCTION public.find_publication_for_pull_request(p_installation_id bigint, p_github_repository_id bigint, p_pull_request_number integer)
RETURNS TABLE (organization_id uuid, publication_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.organization_id, p.id
    FROM public.task_execution_publications AS p
    JOIN public.tasks AS t ON t.organization_id = p.organization_id AND t.id = p.task_id
    JOIN public.repositories AS r ON r.organization_id = t.organization_id AND r.id = t.repository_id AND r.provider = 'github'
    JOIN public.github_installations AS gi ON gi.organization_id = p.organization_id
   WHERE gi.installation_id = p_installation_id
     AND r.github_repository_id = p_github_repository_id
     AND p.pull_request_number = p_pull_request_number
     AND p.status = 'published'
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.list_unresolved_pull_requests(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_unresolved_pull_requests(integer, integer) TO coding_agent_worker;
REVOKE ALL ON FUNCTION public.find_publication_for_pull_request(bigint, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_publication_for_pull_request(bigint, bigint, integer) TO coding_agent_api;

COMMIT;
