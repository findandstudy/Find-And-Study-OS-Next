-- Additive, default-unwired selection-bound session resolver.
-- The legacy resolver remains available for compatibility; the gateway uses
-- this facade so a signed context can bind to the exact selection row.

CREATE FUNCTION fas_session_v1.resolve_session_for_active_context_bound(
  p_session_id text,
  p_session_fingerprint text,
  p_observed_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved jsonb;
  selection_id uuid;
BEGIN
  resolved := fas_session_v1.resolve_session_for_active_context(
    p_session_id,
    p_session_fingerprint,
    p_observed_at
  );
  IF resolved IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT selection.id INTO selection_id
  FROM public.active_session_context_selections selection
  WHERE selection.session_fingerprint = resolved ->> 'sessionFingerprint'
  ORDER BY selection.session_generation DESC
  LIMIT 1
  FOR SHARE;

  IF selection_id IS NULL THEN
    RAISE EXCEPTION 'active context selection binding is unavailable';
  END IF;

  RETURN resolved || jsonb_build_object('selectionId', selection_id);
END;
$$;

REVOKE ALL ON FUNCTION
  fas_session_v1.resolve_session_for_active_context_bound(text, text, bigint)
FROM PUBLIC;

COMMENT ON FUNCTION
  fas_session_v1.resolve_session_for_active_context_bound(text, text, bigint) IS
  'Default-unwired resolver facade that adds the locked selection UUID to the authoritative session state.';
