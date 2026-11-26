-- Nota privada única y editable, y restaurar órdenes eliminadas.
-- * service.internal_note guarda una sola nota; se llena con la última de
--   service_internal_note, que se conserva como archivo.
-- * create/update aceptan internal_note (y siguen aceptando internal_notes de
--   pantallas anteriores, tomando la última).
-- * transition_service_v1 acepta RESTORE: una orden eliminada vuelve a
--   Completada si ya se había completado, o a En progreso.
-- * service_public_json_v1 agrega cancelled_by_name.
-- Las funciones parten de sus definiciones vigentes (pg_get_functiondef).

ALTER TABLE public.service ADD COLUMN internal_note TEXT;

UPDATE public.service AS service
SET internal_note = latest.note
FROM (
    SELECT DISTINCT ON (service_id) service_id, note
    FROM public.service_internal_note
    ORDER BY service_id, created_at DESC, id DESC
) AS latest
WHERE latest.service_id = service.id;

CREATE OR REPLACE FUNCTION public.create_service_v1(p_payload jsonb, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    service_row public.service%ROWTYPE;
    existing_row public.service%ROWTYPE;
    party JSONB;
    manager_user_row public."user"%ROWTYPE;
    manager_person_row public.person%ROWTYPE;
    failure_payload JSONB;
    note_payload JSONB;
    external_id_value UUID;
    failure_external_id UUID;
    note_external_id UUID;
    subtotal_value NUMERIC(12, 2);
    tax_value NUMERIC(12, 2);
    manager_user_id_value TEXT;
BEGIN
    PERFORM public.assert_staff_actor_v1(p_actor_user_id);

    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'SERVICE_PAYLOAD_INVALID' USING ERRCODE = '22023';
    END IF;

    BEGIN
        external_id_value := (p_payload->>'external_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'SERVICE_EXTERNAL_ID_INVALID' USING ERRCODE = '22023';
    END;

    PERFORM pg_advisory_xact_lock(hashtextextended(external_id_value::TEXT, 0));

    SELECT * INTO existing_row
    FROM public.service
    WHERE external_id = external_id_value
    FOR UPDATE;

    IF FOUND THEN
        IF existing_row.client_vehicle_id IS DISTINCT FROM
                nullif(p_payload->>'client_vehicle_id', '')::BIGINT
           OR (existing_row.category = 'PART'
               AND existing_row.client_id IS DISTINCT FROM
                   nullif(p_payload->>'client_id', '')::INTEGER)
           OR existing_row.provisional_reference IS DISTINCT FROM
                coalesce(
                    nullif(btrim(p_payload->>'provisional_reference'), ''),
                    'PEND-SER-' || upper(left(external_id_value::TEXT, 8))
                ) THEN
            RAISE EXCEPTION 'SERVICE_EXTERNAL_ID_CONFLICT'
                USING ERRCODE = '23505';
        END IF;

        RETURN public.service_public_json_v1(existing_row.id)
            || jsonb_build_object('idempotent_replay', true);
    END IF;

    IF NOT p_payload ? 'tax_amount' OR p_payload->>'tax_amount' IS NULL THEN
        RAISE EXCEPTION 'SERVICE_TAX_AMOUNT_REQUIRED' USING ERRCODE = '23502';
    END IF;

    party := public.service_party_v1(p_payload);

    manager_user_id_value := nullif(btrim(p_payload->>'work_manager_user_id'), '');
    IF manager_user_id_value IS NOT NULL THEN
        SELECT * INTO manager_user_row
        FROM public."user"
        WHERE id = manager_user_id_value
          AND active = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'SERVICE_WORK_MANAGER_NOT_FOUND' USING ERRCODE = '23503';
        END IF;
        SELECT * INTO manager_person_row
        FROM public.person WHERE id = manager_user_row.person_id;
    END IF;

    subtotal_value := public.service_line_subtotal_v1(p_payload);
    tax_value := (p_payload->>'tax_amount')::NUMERIC(12, 2);

    INSERT INTO public.service (
        external_id,
        provisional_reference,
        folio_series,
        folio_number,
        folio_assigned_at,
        status,
        category,
        part_description,
        service_date,
        client_vehicle_id,
        client_id,
        vehicle_id,
        work_manager_user_id,
        reported_failure_summary,
        authorized_work_description,
        vehicle_operation_observations,
        important_information,
        informational_note,
        compression_leak_detected,
        cooling_system_air_pressure_detected,
        radiator_serial_number,
        radiator_obstruction_level,
        line_totals_mode,
        subtotal,
        tax_amount,
        total,
        warranty_months,
        client_snapshot,
        vehicle_snapshot,
        work_manager_snapshot,
        legal_text_snapshot,
        internal_note,
        created_by_user_id,
        updated_by_user_id
    )
    VALUES (
        external_id_value,
        coalesce(
            nullif(btrim(p_payload->>'provisional_reference'), ''),
            'PEND-SER-' || upper(left(external_id_value::TEXT, 8))
        ),
        'SER',
        nextval('public.service_folio_number_seq'),
        now(),
        -- Orders open straight in progress; there are no drafts anymore.
        'IN_PROGRESS',
        party->>'category',
        party->>'part_description',
        CASE WHEN p_payload->>'service_date' IS NULL
            THEN NULL ELSE (p_payload->>'service_date')::DATE END,
        (party->>'client_vehicle_id')::BIGINT,
        (party->>'client_id')::INTEGER,
        (party->>'vehicle_id')::INTEGER,
        manager_user_id_value,
        nullif(btrim(p_payload->>'reported_failure_summary'), ''),
        nullif(btrim(p_payload->>'authorized_work_description'), ''),
        nullif(btrim(p_payload->>'vehicle_operation_observations'), ''),
        nullif(btrim(p_payload->>'important_information'), ''),
        nullif(btrim(p_payload->>'informational_note'), ''),
        coalesce((p_payload->>'compression_leak_detected')::BOOLEAN, false),
        coalesce((p_payload->>'cooling_system_air_pressure_detected')::BOOLEAN, false),
        nullif(btrim(p_payload->>'radiator_serial_number'), ''),
        CASE WHEN p_payload->>'radiator_obstruction_level' IS NULL
            THEN NULL ELSE (p_payload->>'radiator_obstruction_level')::SMALLINT END,
        p_payload->>'line_totals_mode',
        subtotal_value,
        tax_value,
        round(coalesce(subtotal_value, 0) + tax_value, 2),
        CASE WHEN p_payload->>'warranty_months' IS NULL
            THEN NULL ELSE (p_payload->>'warranty_months')::SMALLINT END,
        party->'client_snapshot',
        party->'vehicle_snapshot',
        CASE WHEN manager_user_id_value IS NULL THEN NULL ELSE
            jsonb_build_object(
                'user_id', manager_user_row.id,
                'name', concat_ws(' ', manager_person_row.name, manager_person_row.last_name)
            )
        END,
        coalesce(p_payload->'legal_text_snapshot', '{}'::JSONB),
        coalesce(
            nullif(btrim(p_payload->>'internal_note'), ''),
            nullif(btrim(p_payload->'internal_notes'->-1->>'note'), '')
        ),
        p_actor_user_id,
        p_actor_user_id
    )
    RETURNING * INTO service_row;

    IF p_payload ? 'reported_failures'
       AND jsonb_typeof(p_payload->'reported_failures') <> 'array' THEN
        RAISE EXCEPTION 'SERVICE_REPORTED_FAILURES_MUST_BE_ARRAY'
            USING ERRCODE = '22023';
    END IF;

    FOR failure_payload IN
        SELECT value FROM jsonb_array_elements(
            coalesce(p_payload->'reported_failures', '[]'::JSONB)
        )
    LOOP
        BEGIN
            failure_external_id := (failure_payload->>'external_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'SERVICE_FAILURE_EXTERNAL_ID_INVALID'
                USING ERRCODE = '22023';
        END;

        INSERT INTO public.service_reported_failure (
            external_id,
            service_id,
            reported_failure_type_id,
            failure_code_snapshot,
            label_snapshot,
            display_order_snapshot,
            other_text,
            amount,
            observation,
            created_by_user_id
        )
        VALUES (
            failure_external_id,
            service_row.id,
            (failure_payload->>'reported_failure_type_id')::SMALLINT,
            '',
            '',
            1,
            nullif(btrim(failure_payload->>'other_text'), ''),
            (failure_payload->>'amount')::NUMERIC(12, 2),
            nullif(btrim(failure_payload->>'observation'), ''),
            p_actor_user_id
        );
    END LOOP;

    IF p_payload ? 'internal_notes'
       AND jsonb_typeof(p_payload->'internal_notes') <> 'array' THEN
        RAISE EXCEPTION 'SERVICE_INTERNAL_NOTES_MUST_BE_ARRAY'
            USING ERRCODE = '22023';
    END IF;

    FOR note_payload IN
        SELECT value FROM jsonb_array_elements(
            coalesce(p_payload->'internal_notes', '[]'::JSONB)
        )
    LOOP
        BEGIN
            note_external_id := (note_payload->>'external_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'SERVICE_NOTE_EXTERNAL_ID_INVALID'
                USING ERRCODE = '22023';
        END;

        INSERT INTO public.service_internal_note (
            external_id,
            service_id,
            note,
            created_by_user_id,
            updated_by_user_id
        )
        VALUES (
            note_external_id,
            service_row.id,
            btrim(note_payload->>'note'),
            p_actor_user_id,
            p_actor_user_id
        );
    END LOOP;

    RETURN public.service_public_json_v1(service_row.id)
        || jsonb_build_object('idempotent_replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_service_v1(p_payload jsonb, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    service_row public.service%ROWTYPE;
    party JSONB;
    manager_user_row public."user"%ROWTYPE;
    manager_person_row public.person%ROWTYPE;
    failure_payload JSONB;
    note_payload JSONB;
    failure_external_id UUID;
    note_external_id UUID;
    external_id_value UUID;
    expected_version_value INTEGER;
    subtotal_value NUMERIC(12, 2);
    tax_value NUMERIC(12, 2);
    manager_user_id_value TEXT;
BEGIN
    PERFORM public.assert_staff_actor_v1(p_actor_user_id);

    BEGIN
        external_id_value := (p_payload->>'external_id')::UUID;
        expected_version_value := (p_payload->>'expected_version')::INTEGER;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'SERVICE_ID_OR_VERSION_INVALID' USING ERRCODE = '22023';
    END;

    SELECT * INTO service_row
    FROM public.service
    WHERE external_id = external_id_value
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SERVICE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF service_row.line_totals_mode IS NOT NULL
       AND p_payload->>'line_totals_mode' IS NULL THEN
        RAISE EXCEPTION 'SERVICE_LINE_CONTRACT_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF service_row.version <> expected_version_value THEN
        RAISE EXCEPTION 'SERVICE_VERSION_CONFLICT current=% expected=%',
            service_row.version, expected_version_value
            USING ERRCODE = 'P0001';
    END IF;
    -- Completed orders stay editable on request; cancelled ones remain a closed record.
    IF service_row.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'SERVICE_INVALID_STATE_%', service_row.status
            USING ERRCODE = '55000';
    END IF;
    IF NOT p_payload ? 'tax_amount' OR p_payload->>'tax_amount' IS NULL THEN
        RAISE EXCEPTION 'SERVICE_TAX_AMOUNT_REQUIRED' USING ERRCODE = '23502';
    END IF;

    party := public.service_party_v1(p_payload);

    manager_user_id_value := nullif(btrim(p_payload->>'work_manager_user_id'), '');
    IF manager_user_id_value IS NOT NULL THEN
        SELECT * INTO manager_user_row FROM public."user"
        WHERE id = manager_user_id_value AND active = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'SERVICE_WORK_MANAGER_NOT_FOUND' USING ERRCODE = '23503';
        END IF;
        SELECT * INTO manager_person_row FROM public.person
        WHERE id = manager_user_row.person_id;
    END IF;

    subtotal_value := public.service_line_subtotal_v1(p_payload);
    tax_value := (p_payload->>'tax_amount')::NUMERIC(12, 2);

    UPDATE public.service
    SET service_date = CASE WHEN p_payload->>'service_date' IS NULL
            THEN NULL ELSE (p_payload->>'service_date')::DATE END,
        category = party->>'category',
        part_description = party->>'part_description',
        client_vehicle_id = (party->>'client_vehicle_id')::BIGINT,
        client_id = (party->>'client_id')::INTEGER,
        vehicle_id = (party->>'vehicle_id')::INTEGER,
        work_manager_user_id = manager_user_id_value,
        reported_failure_summary = nullif(btrim(p_payload->>'reported_failure_summary'), ''),
        authorized_work_description = nullif(btrim(p_payload->>'authorized_work_description'), ''),
        vehicle_operation_observations = nullif(btrim(p_payload->>'vehicle_operation_observations'), ''),
        important_information = nullif(btrim(p_payload->>'important_information'), ''),
        informational_note = nullif(btrim(p_payload->>'informational_note'), ''),
        compression_leak_detected = coalesce(
            (p_payload->>'compression_leak_detected')::BOOLEAN,
            false
        ),
        cooling_system_air_pressure_detected = coalesce(
            (p_payload->>'cooling_system_air_pressure_detected')::BOOLEAN,
            false
        ),
        radiator_serial_number = nullif(btrim(p_payload->>'radiator_serial_number'), ''),
        radiator_obstruction_level = CASE
            WHEN p_payload->>'radiator_obstruction_level' IS NULL THEN NULL
            ELSE (p_payload->>'radiator_obstruction_level')::SMALLINT
        END,
        line_totals_mode = p_payload->>'line_totals_mode',
        subtotal = subtotal_value,
        tax_amount = tax_value,
        total = round(coalesce(subtotal_value, 0) + tax_value, 2),
        warranty_months = CASE WHEN p_payload->>'warranty_months' IS NULL
            THEN NULL ELSE (p_payload->>'warranty_months')::SMALLINT END,
        client_snapshot = party->'client_snapshot',
        vehicle_snapshot = party->'vehicle_snapshot',
        work_manager_snapshot = CASE WHEN manager_user_id_value IS NULL THEN NULL ELSE
            jsonb_build_object(
                'user_id', manager_user_row.id,
                'name', concat_ws(' ', manager_person_row.name, manager_person_row.last_name)
            )
        END,
        legal_text_snapshot = coalesce(p_payload->'legal_text_snapshot', '{}'::JSONB),
        internal_note = CASE
            WHEN p_payload ? 'internal_note' THEN nullif(btrim(p_payload->>'internal_note'), '')
            WHEN jsonb_array_length(coalesce(p_payload->'internal_notes', '[]'::JSONB)) > 0
                THEN nullif(btrim(p_payload->'internal_notes'->-1->>'note'), '')
            ELSE service_row.internal_note
        END,
        updated_by_user_id = p_actor_user_id
    WHERE id = service_row.id;

    DELETE FROM public.service_reported_failure
    WHERE service_id = service_row.id;

    FOR failure_payload IN
        SELECT value FROM jsonb_array_elements(
            coalesce(p_payload->'reported_failures', '[]'::JSONB)
        )
    LOOP
        BEGIN
            failure_external_id := (failure_payload->>'external_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'SERVICE_FAILURE_EXTERNAL_ID_INVALID'
                USING ERRCODE = '22023';
        END;

        INSERT INTO public.service_reported_failure (
            external_id, service_id, reported_failure_type_id,
            failure_code_snapshot, label_snapshot, display_order_snapshot,
            other_text, amount, observation, created_by_user_id
        )
        VALUES (
            failure_external_id,
            service_row.id,
            (failure_payload->>'reported_failure_type_id')::SMALLINT,
            '', '', 1,
            nullif(btrim(failure_payload->>'other_text'), ''),
            (failure_payload->>'amount')::NUMERIC(12, 2),
            nullif(btrim(failure_payload->>'observation'), ''),
            p_actor_user_id
        );
    END LOOP;

    FOR note_payload IN
        SELECT value FROM jsonb_array_elements(
            coalesce(p_payload->'internal_notes', '[]'::JSONB)
        )
    LOOP
        BEGIN
            note_external_id := (note_payload->>'external_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'SERVICE_NOTE_EXTERNAL_ID_INVALID'
                USING ERRCODE = '22023';
        END;

        INSERT INTO public.service_internal_note (
            external_id, service_id, note,
            created_by_user_id, updated_by_user_id
        )
        VALUES (
            note_external_id,
            service_row.id,
            btrim(note_payload->>'note'),
            p_actor_user_id,
            p_actor_user_id
        )
        ON CONFLICT (external_id) DO NOTHING;
    END LOOP;

    RETURN public.service_public_json_v1(service_row.id)
        || jsonb_build_object('idempotent_replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_service_v1(p_external_id uuid, p_expected_version integer, p_action text, p_actor_user_id text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    service_row public.service%ROWTYPE;
    target_status TEXT;
BEGIN
    PERFORM public.assert_staff_actor_v1(p_actor_user_id);

    target_status := CASE upper(p_action)
        WHEN 'START' THEN 'IN_PROGRESS'
        WHEN 'COMPLETE' THEN 'COMPLETED'
        WHEN 'CANCEL' THEN 'CANCELLED'
        WHEN 'RESTORE' THEN 'RESTORED'
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

    -- A restored order goes back to where it was before being deleted.
    IF target_status = 'RESTORED' THEN
        target_status := CASE WHEN service_row.completed_at IS NOT NULL THEN 'COMPLETED' ELSE 'IN_PROGRESS' END;
        IF service_row.status <> 'CANCELLED' THEN
            IF service_row.status = target_status AND service_row.version = p_expected_version + 1 THEN
                RETURN public.service_public_json_v1(service_row.id)
                    || jsonb_build_object('idempotent_replay', true);
            END IF;
            RAISE EXCEPTION 'SERVICE_INVALID_STATE_%', service_row.status USING ERRCODE = '55000';
        END IF;
        IF service_row.version <> p_expected_version THEN
            RAISE EXCEPTION 'SERVICE_VERSION_CONFLICT current=% expected=%',
                service_row.version, p_expected_version
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.service
        SET status = target_status,
            cancelled_at = NULL,
            cancelled_by_user_id = NULL,
            cancellation_reason = NULL,
            updated_by_user_id = p_actor_user_id
        WHERE id = service_row.id;
        RETURN public.service_public_json_v1(service_row.id)
            || jsonb_build_object('idempotent_replay', false);
    END IF;

    -- Older screens still send START; orders are already in progress, so it is a no-op.
    IF upper(p_action) = 'START' AND service_row.status = 'IN_PROGRESS' THEN
        RETURN public.service_public_json_v1(service_row.id)
            || jsonb_build_object('idempotent_replay', true);
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
    -- Deleting (CANCEL) works on open and completed orders; a deleted order is final.
    IF service_row.status = 'CANCELLED'
       OR (service_row.status = 'COMPLETED' AND target_status <> 'CANCELLED') THEN
        RAISE EXCEPTION 'SERVICE_INVALID_STATE_%', service_row.status
            USING ERRCODE = '55000';
    END IF;
    IF target_status = 'CANCELLED' AND nullif(btrim(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'SERVICE_CANCELLATION_REASON_REQUIRED' USING ERRCODE = '23502';
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
        cancellation_reason = CASE
            WHEN target_status = 'CANCELLED' THEN btrim(p_reason)
            ELSE cancellation_reason
        END,
        updated_by_user_id = p_actor_user_id
    WHERE id = service_row.id;

    RETURN public.service_public_json_v1(service_row.id)
        || jsonb_build_object('idempotent_replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.service_public_json_v1(p_service_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT to_jsonb(s) || jsonb_build_object(
        -- Who deleted the order, for the archive of deleted folios.
        'cancelled_by_name', (
            SELECT nullif(concat_ws(' ', p.name, p.last_name), '')
            FROM public."user" u
            JOIN public.person p ON p.id = u.person_id
            WHERE u.id = s.cancelled_by_user_id
        ),
        'reported_failures', coalesce((
            SELECT jsonb_agg(
                to_jsonb(f) - 'service_id' - 'created_by_user_id'
                ORDER BY f.display_order_snapshot, f.id
            ) FROM public.service_reported_failure f WHERE f.service_id = s.id
        ), '[]'::JSONB),
        'items', coalesce((
            SELECT jsonb_agg(to_jsonb(i) ORDER BY i.display_order, i.id)
            FROM public.service_item i WHERE i.service_id = s.id
        ), '[]'::JSONB)
    )
    FROM public.service s WHERE s.id = p_service_id
$function$;
