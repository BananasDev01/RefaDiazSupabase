-- Órdenes de pieza y solo dos estados visibles.
-- * category: VEHICLE (entra al taller) o PART (pieza suelta, sin vehículo) con part_description.
-- * Las órdenes nacen En progreso: ya no hay borradores; los existentes pasan a En progreso.
-- * CANCEL ahora es "eliminar": pide motivo, sirve también en completadas y la orden se oculta.
-- * Las órdenes viejas con placas «A LA MANO» se convierten en órdenes de pieza.
-- Las funciones parten de sus definiciones vigentes (pg_get_functiondef).

ALTER TABLE public.service
    ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'VEHICLE',
    ADD COLUMN part_description TEXT,
    ADD COLUMN cancellation_reason TEXT,
    ALTER COLUMN client_vehicle_id DROP NOT NULL,
    ALTER COLUMN vehicle_id DROP NOT NULL;

UPDATE public.service AS service
SET category = 'PART',
    part_description = nullif(concat_ws(
        ' ',
        service.vehicle_snapshot->>'brand_name',
        service.vehicle_snapshot->>'car_model_name',
        service.vehicle_snapshot->>'model_year'
    ), ''),
    client_vehicle_id = NULL,
    vehicle_id = NULL
FROM public.vehicle AS vehicle
WHERE vehicle.id = service.vehicle_id
  AND vehicle.plate_normalized = 'ALAMANO';

UPDATE public.service SET status = 'IN_PROGRESS' WHERE status = 'DRAFT';

ALTER TABLE public.service
    DROP CONSTRAINT service_status_valid,
    ADD CONSTRAINT service_status_valid
        CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    ADD CONSTRAINT service_category_valid
        CHECK (category IN ('VEHICLE', 'PART')),
    ADD CONSTRAINT service_category_vehicle_consistent CHECK (
        (category = 'VEHICLE' AND client_vehicle_id IS NOT NULL AND vehicle_id IS NOT NULL)
        OR (category = 'PART' AND client_vehicle_id IS NULL AND vehicle_id IS NULL)
    ),
    ADD CONSTRAINT service_part_description_not_blank
        CHECK (part_description IS NULL OR btrim(part_description) <> ''),
    ADD CONSTRAINT service_client_fkey FOREIGN KEY (client_id) REFERENCES public.client (id);

CREATE INDEX service_category_status_idx ON public.service (category, status);

CREATE OR REPLACE FUNCTION public.service_party_v1(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    category_value TEXT := upper(coalesce(nullif(btrim(p_payload->>'category'), ''), 'VEHICLE'));
    client_vehicle_row public.client_vehicle%ROWTYPE;
    client_row public.client%ROWTYPE;
    vehicle_row public.vehicle%ROWTYPE;
    car_model_row public.car_model%ROWTYPE;
    brand_row public.brand%ROWTYPE;
BEGIN
    IF category_value NOT IN ('VEHICLE', 'PART') THEN
        RAISE EXCEPTION 'SERVICE_CATEGORY_INVALID' USING ERRCODE = '22023';
    END IF;

    IF category_value = 'PART' THEN
        -- A loose part belongs to the client only; no vehicle is recorded.
        IF nullif(p_payload->>'client_id', '') IS NULL THEN
            RAISE EXCEPTION 'SERVICE_CLIENT_REQUIRED' USING ERRCODE = '23502';
        END IF;
        SELECT * INTO client_row
        FROM public.client
        WHERE id = (p_payload->>'client_id')::INTEGER
          AND active = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = '23503';
        END IF;
    ELSE
        IF nullif(p_payload->>'client_vehicle_id', '') IS NULL THEN
            RAISE EXCEPTION 'SERVICE_CLIENT_VEHICLE_REQUIRED' USING ERRCODE = '23502';
        END IF;
        SELECT * INTO client_vehicle_row
        FROM public.client_vehicle
        WHERE id = (p_payload->>'client_vehicle_id')::BIGINT
          AND active = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'CLIENT_VEHICLE_NOT_FOUND' USING ERRCODE = '23503';
        END IF;

        SELECT * INTO client_row FROM public.client
        WHERE id = client_vehicle_row.client_id AND active = true;
        SELECT * INTO vehicle_row FROM public.vehicle
        WHERE id = client_vehicle_row.vehicle_id AND active = true;
        IF client_row.id IS NULL OR vehicle_row.id IS NULL THEN
            RAISE EXCEPTION 'CLIENT_VEHICLE_INACTIVE' USING ERRCODE = '23503';
        END IF;

        IF vehicle_row.car_model_id IS NOT NULL THEN
            SELECT * INTO car_model_row FROM public.car_model
            WHERE id = vehicle_row.car_model_id;
            IF car_model_row.brand_id IS NOT NULL THEN
                SELECT * INTO brand_row FROM public.brand
                WHERE id = car_model_row.brand_id;
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'category', category_value,
        'client_id', client_row.id,
        'client_vehicle_id', client_vehicle_row.id,
        'vehicle_id', vehicle_row.id,
        'part_description', CASE WHEN category_value = 'PART'
            THEN nullif(btrim(p_payload->>'part_description'), '') END,
        'client_snapshot', jsonb_build_object(
            'id', client_row.id,
            'external_id', client_row.external_id,
            'client_name', client_row.client_name,
            'phone_number', client_row.phone_number,
            'secondary_phone_number', client_row.secondary_phone_number,
            'phone_normalized', client_row.phone_normalized
        ),
        'vehicle_snapshot', CASE WHEN category_value = 'PART' THEN '{}'::JSONB ELSE
            jsonb_build_object(
                'id', vehicle_row.id,
                'external_id', vehicle_row.external_id,
                'brand_id', brand_row.id,
                'brand_name', brand_row.name,
                'car_model_id', car_model_row.id,
                'car_model_name', car_model_row.name,
                'model_year', vehicle_row.model_year,
                'version', vehicle_row.version,
                'color', vehicle_row.color,
                'plate', vehicle_row.plate
            )
        END
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.service_party_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_party_v1(JSONB) TO service_role;

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

DROP FUNCTION public.transition_service_v1(UUID, INTEGER, TEXT, TEXT);

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

REVOKE ALL ON FUNCTION public.transition_service_v1(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_service_v1(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

DROP FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION public.search_services_v1(p_folio text DEFAULT NULL::text, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_phone text DEFAULT NULL::text, p_plate text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_client_id integer DEFAULT NULL::integer, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_query text DEFAULT NULL::text, p_category text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    result JSONB;
    normalized_phone TEXT := public.normalize_phone_v1(p_phone);
    normalized_plate TEXT := public.normalize_vehicle_plate_v1(p_plate);
    safe_limit INTEGER := greatest(1, least(coalesce(p_limit, 50), 100));
    safe_offset INTEGER := greatest(coalesce(p_offset, 0), 0);
BEGIN
    WITH matching_services AS (
        SELECT service.id
        FROM public.service AS service
        JOIN public.client AS client ON client.id = service.client_id
        LEFT JOIN public.vehicle AS vehicle ON vehicle.id = service.vehicle_id
        LEFT JOIN public.car_model AS car_model ON car_model.id = vehicle.car_model_id
        LEFT JOIN public.brand AS brand ON brand.id = car_model.brand_id
        WHERE (
                nullif(btrim(p_folio), '') IS NULL
                OR concat_ws('-', service.folio_series, service.folio_number::TEXT)
                    ILIKE '%' || btrim(p_folio) || '%'
                OR service.provisional_reference ILIKE '%' || btrim(p_folio) || '%'
              )
          AND (p_date_from IS NULL OR service.service_date >= p_date_from)
          AND (p_date_to IS NULL OR service.service_date <= p_date_to)
          AND (
                nullif(btrim(p_phone), '') IS NULL
                OR (normalized_phone IS NOT NULL AND client.phone_normalized = normalized_phone)
              )
          AND (
                nullif(btrim(p_plate), '') IS NULL
                OR (normalized_plate IS NOT NULL AND vehicle.plate_normalized = normalized_plate)
              )
          -- Deleted orders only show up when asked for explicitly.
          AND (
                (p_status IS NULL AND service.status <> 'CANCELLED')
                OR service.status = upper(p_status)
              )
          AND (p_category IS NULL OR service.category = upper(p_category))
          AND (p_client_id IS NULL OR service.client_id = p_client_id)
          -- Free text: every word must appear in the order, its client or its vehicle.
          AND (
                nullif(btrim(p_query), '') IS NULL
                OR NOT EXISTS (
                    SELECT 1
                    FROM regexp_split_to_table(btrim(p_query), '\s+') AS term
                    WHERE concat_ws(
                          ' ',
                          service.folio_number::TEXT,
                          service.provisional_reference,
                          client.client_name,
                          client.phone_number,
                          client.phone_normalized,
                          client.secondary_phone_number,
                          brand.name,
                          car_model.name,
                          vehicle.model_year::TEXT,
                          vehicle.color,
                          vehicle.plate,
                          vehicle.plate_normalized,
                          service.part_description,
                          service.radiator_serial_number,
                          service.reported_failure_summary
                       ) NOT ILIKE '%' || term || '%'
                )
              )
    ),
    page AS (
        SELECT service.id
        FROM matching_services
        JOIN public.service ON service.id = matching_services.id
        ORDER BY service.created_at DESC, service.id DESC
        LIMIT safe_limit OFFSET safe_offset
    )
    SELECT jsonb_build_object(
        'data', coalesce((
            SELECT jsonb_agg(public.service_public_json_v1(page.id))
            FROM page
        ), '[]'::JSONB),
        'pagination', jsonb_build_object(
            'limit', safe_limit,
            'offset', safe_offset,
            'total', (SELECT count(*) FROM matching_services)
        )
    )
    INTO result;

    RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) TO service_role;
