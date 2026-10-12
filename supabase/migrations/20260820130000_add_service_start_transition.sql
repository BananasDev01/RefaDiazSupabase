CREATE OR REPLACE FUNCTION public.transition_service_v1(
    p_external_id UUID,
    p_expected_version INTEGER,
    p_action TEXT,
    p_actor_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    service_row public.service%ROWTYPE;
    target_status TEXT;
BEGIN
    PERFORM public.assert_staff_actor_v1(p_actor_user_id);

    target_status := CASE upper(p_action)
        WHEN 'START' THEN 'IN_PROGRESS'
        WHEN 'COMPLETE' THEN 'COMPLETED'
        WHEN 'CANCEL' THEN 'CANCELLED'
        ELSE NULL
    END;
    IF target_status IS NULL THEN
        RAISE EXCEPTION 'SERVICE_ACTION_INVALID' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO service_row
    FROM public.service
    WHERE external_id = p_external_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SERVICE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF service_row.status = target_status
       AND service_row.version = p_expected_version + 1 THEN
        RETURN public.service_public_json_v1(service_row.id)
            || jsonb_build_object('idempotent_replay', true);
    END IF;

    IF service_row.version <> p_expected_version THEN
        RAISE EXCEPTION 'SERVICE_VERSION_CONFLICT current=% expected=%',
            service_row.version, p_expected_version
            USING ERRCODE = 'P0001';
    END IF;
    IF service_row.status IN ('COMPLETED', 'CANCELLED') THEN
        RAISE EXCEPTION 'SERVICE_INVALID_STATE_%', service_row.status
            USING ERRCODE = '55000';
    END IF;
    IF upper(p_action) = 'START' AND service_row.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'SERVICE_START_REQUIRES_DRAFT' USING ERRCODE = '55000';
    END IF;

    UPDATE public.service
    SET status = target_status,
        folio_number = coalesce(folio_number, nextval('public.service_folio_number_seq')),
        folio_assigned_at = coalesce(folio_assigned_at, now()),
        completed_at = CASE WHEN target_status = 'COMPLETED' THEN now() ELSE completed_at END,
        completed_by_user_id = CASE
            WHEN target_status = 'COMPLETED' THEN p_actor_user_id
            ELSE completed_by_user_id
        END,
        cancelled_at = CASE WHEN target_status = 'CANCELLED' THEN now() ELSE cancelled_at END,
        cancelled_by_user_id = CASE
            WHEN target_status = 'CANCELLED' THEN p_actor_user_id
            ELSE cancelled_by_user_id
        END,
        updated_by_user_id = p_actor_user_id
    WHERE id = service_row.id;

    RETURN public.service_public_json_v1(service_row.id)
        || jsonb_build_object('idempotent_replay', false);
END;
$$;
