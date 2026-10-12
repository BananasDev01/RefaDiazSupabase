-- Native service rows. Additive migration; no historical order or amount is rewritten.
ALTER TABLE public.service
    ADD COLUMN line_totals_mode TEXT
    CHECK (line_totals_mode IN ('LINES', 'LEGACY'));

ALTER TABLE public.service_reported_failure
    ADD COLUMN amount NUMERIC(12, 2) CHECK (amount >= 0),
    ADD COLUMN observation TEXT CHECK (char_length(observation) <= 4000);

COMMENT ON COLUMN public.service.line_totals_mode IS
    'NULL: historical contract; LINES: server sums row amounts; LEGACY: native rows with historical aggregate subtotal.';
COMMENT ON COLUMN public.service_reported_failure.other_text IS
    'Custom detail for types that allow free text; never a container for row costs or observations.';

CREATE OR REPLACE FUNCTION public.service_line_subtotal_v1(p_payload JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
    mode_value TEXT := p_payload->>'line_totals_mode';
    row_value JSONB;
    amount_value NUMERIC;
    sum_value NUMERIC := 0;
BEGIN
    IF mode_value IS NOT NULL AND mode_value NOT IN ('LINES', 'LEGACY') THEN
        RAISE EXCEPTION 'SERVICE_LINE_TOTALS_MODE_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_payload ? 'reported_failures'
       AND jsonb_typeof(p_payload->'reported_failures') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'SERVICE_REPORTED_FAILURES_MUST_BE_ARRAY' USING ERRCODE = '22023';
    END IF;

    FOR row_value IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'reported_failures', '[]'::JSONB))
    LOOP
        IF jsonb_typeof(row_value) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'SERVICE_FAILURE_INVALID' USING ERRCODE = '22023';
        END IF;
        IF mode_value IS NULL AND (row_value ? 'amount' OR row_value ? 'observation') THEN
            RAISE EXCEPTION 'SERVICE_LINE_TOTALS_MODE_REQUIRED' USING ERRCODE = '22023';
        END IF;
        IF row_value->>'amount' IS NOT NULL THEN
            IF jsonb_typeof(row_value->'amount') IS DISTINCT FROM 'number' THEN
                RAISE EXCEPTION 'SERVICE_LINE_AMOUNT_INVALID' USING ERRCODE = '22023';
            END IF;
            amount_value := (row_value->>'amount')::NUMERIC;
            IF amount_value < 0 OR amount_value > 9999999999.99 OR amount_value <> round(amount_value, 2) THEN
                RAISE EXCEPTION 'SERVICE_LINE_AMOUNT_INVALID' USING ERRCODE = '22023';
            END IF;
            IF mode_value = 'LEGACY' THEN
                RAISE EXCEPTION 'SERVICE_LEGACY_SUBTOTAL_WITH_LINE_AMOUNTS' USING ERRCODE = '22023';
            END IF;
            sum_value := sum_value + amount_value;
        END IF;
        IF row_value->>'observation' IS NOT NULL AND (
            jsonb_typeof(row_value->'observation') IS DISTINCT FROM 'string'
            OR char_length(row_value->>'observation') > 4000
        ) THEN
            RAISE EXCEPTION 'SERVICE_LINE_OBSERVATION_INVALID' USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF mode_value = 'LINES' THEN
        RETURN sum_value;
    END IF;
    RETURN (p_payload->>'subtotal')::NUMERIC(12, 2);
END;
$function$;

REVOKE ALL ON FUNCTION public.service_line_subtotal_v1(JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_service_v1(p_payload jsonb, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    service_row public.service%ROWTYPE;
    existing_row public.service%ROWTYPE;
    client_vehicle_row public.client_vehicle%ROWTYPE;
    client_row public.client%ROWTYPE;
    vehicle_row public.vehicle%ROWTYPE;
    car_model_row public.car_model%ROWTYPE;
    brand_row public.brand%ROWTYPE;
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
                (p_payload->>'client_vehicle_id')::BIGINT
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

    IF NOT p_payload ? 'client_vehicle_id' THEN
        RAISE EXCEPTION 'SERVICE_CLIENT_VEHICLE_REQUIRED' USING ERRCODE = '23502';
    END IF;
    IF NOT p_payload ? 'tax_amount' OR p_payload->>'tax_amount' IS NULL THEN
        RAISE EXCEPTION 'SERVICE_TAX_AMOUNT_REQUIRED' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO client_vehicle_row
    FROM public.client_vehicle
    WHERE id = (p_payload->>'client_vehicle_id')::BIGINT
      AND active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CLIENT_VEHICLE_NOT_FOUND' USING ERRCODE = '23503';
    END IF;

    SELECT * INTO client_row
    FROM public.client
    WHERE id = client_vehicle_row.client_id
      AND active = true;
    SELECT * INTO vehicle_row
    FROM public.vehicle
    WHERE id = client_vehicle_row.vehicle_id
      AND active = true;

    IF client_row.id IS NULL OR vehicle_row.id IS NULL THEN
        RAISE EXCEPTION 'CLIENT_VEHICLE_INACTIVE' USING ERRCODE = '23503';
    END IF;

    IF vehicle_row.car_model_id IS NOT NULL THEN
        SELECT * INTO car_model_row
        FROM public.car_model WHERE id = vehicle_row.car_model_id;
        IF car_model_row.brand_id IS NOT NULL THEN
            SELECT * INTO brand_row
            FROM public.brand WHERE id = car_model_row.brand_id;
        END IF;
    END IF;

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
        'DRAFT',
        CASE WHEN p_payload->>'service_date' IS NULL
            THEN NULL ELSE (p_payload->>'service_date')::DATE END,
        client_vehicle_row.id,
        client_vehicle_row.client_id,
        client_vehicle_row.vehicle_id,
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
        jsonb_build_object(
            'id', client_row.id,
            'external_id', client_row.external_id,
            'client_name', client_row.client_name,
            'phone_number', client_row.phone_number,
            'phone_normalized', client_row.phone_normalized
        ),
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
        ),
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
    client_vehicle_row public.client_vehicle%ROWTYPE;
    client_row public.client%ROWTYPE;
    vehicle_row public.vehicle%ROWTYPE;
    car_model_row public.car_model%ROWTYPE;
    brand_row public.brand%ROWTYPE;
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
    IF service_row.status IN ('COMPLETED', 'CANCELLED') THEN
        RAISE EXCEPTION 'SERVICE_INVALID_STATE_%', service_row.status
            USING ERRCODE = '55000';
    END IF;
    IF NOT p_payload ? 'client_vehicle_id' THEN
        RAISE EXCEPTION 'SERVICE_CLIENT_VEHICLE_REQUIRED' USING ERRCODE = '23502';
    END IF;
    IF NOT p_payload ? 'tax_amount' OR p_payload->>'tax_amount' IS NULL THEN
        RAISE EXCEPTION 'SERVICE_TAX_AMOUNT_REQUIRED' USING ERRCODE = '23502';
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
        client_vehicle_id = client_vehicle_row.id,
        client_id = client_vehicle_row.client_id,
        vehicle_id = client_vehicle_row.vehicle_id,
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
        client_snapshot = jsonb_build_object(
            'id', client_row.id,
            'external_id', client_row.external_id,
            'client_name', client_row.client_name,
            'phone_number', client_row.phone_number,
            'phone_normalized', client_row.phone_normalized
        ),
        vehicle_snapshot = jsonb_build_object(
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
        ),
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

CREATE OR REPLACE FUNCTION public.set_reported_failure_snapshot_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    failure_type public.reported_failure_type%ROWTYPE;
BEGIN
    SELECT *
    INTO failure_type
    FROM public.reported_failure_type
    WHERE id = NEW.reported_failure_type_id
      AND active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reported failure type % is missing or inactive',
            NEW.reported_failure_type_id
            USING ERRCODE = '23514';
    END IF;

    -- Legacy requests keep their original requirement. Native rows may put all
    -- additional information in observation, including rows of type Others.
    IF failure_type.allows_free_text AND nullif(btrim(NEW.other_text), '') IS NULL
       AND (SELECT line_totals_mode FROM public.service WHERE id = NEW.service_id) IS NULL THEN
        RAISE EXCEPTION 'Reported failure type % requires other_text', failure_type.code
            USING ERRCODE = '23514';
    END IF;

    IF NOT failure_type.allows_free_text AND NEW.other_text IS NOT NULL THEN
        RAISE EXCEPTION 'Reported failure type % does not allow other_text', failure_type.code
            USING ERRCODE = '23514';
    END IF;

    NEW.failure_code_snapshot := failure_type.code;
    NEW.label_snapshot := failure_type.label;
    NEW.display_order_snapshot := failure_type.display_order;
    RETURN NEW;
END;
$function$;
