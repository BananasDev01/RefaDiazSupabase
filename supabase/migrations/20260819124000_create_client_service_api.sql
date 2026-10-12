CREATE OR REPLACE FUNCTION public.assert_staff_actor_v1(p_actor_user_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public."user" AS app_user
        JOIN public.role AS role ON role.id = app_user.role_id
        WHERE app_user.id = p_actor_user_id
          AND app_user.active = true
          AND role.active = true
          AND upper(role.description) IN ('ADMINISTRADOR', 'EMPLEADO')
    ) THEN
        RAISE EXCEPTION 'APP_ACTOR_FORBIDDEN'
            USING ERRCODE = '42501';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_public_json_v1(p_client_id INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', client.id,
        'external_id', client.external_id,
        'client_name', client.client_name,
        'phone_number', client.phone_number,
        'phone_normalized', client.phone_normalized,
        'comments', client.comments,
        'active', client.active,
        'created_at', client.created_at,
        'updated_at', client.updated_at,
        'vehicles', coalesce((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'client_vehicle_id', client_vehicle.id,
                    'id', vehicle.id,
                    'external_id', vehicle.external_id,
                    'car_model_id', vehicle.car_model_id,
                    'model_year', vehicle.model_year,
                    'version', vehicle.version,
                    'color', vehicle.color,
                    'plate', vehicle.plate,
                    'plate_normalized', vehicle.plate_normalized,
                    'comments', client_vehicle.comments,
                    'active', vehicle.active,
                    'car_model', CASE WHEN car_model.id IS NULL THEN NULL ELSE
                        jsonb_build_object(
                            'id', car_model.id,
                            'name', car_model.name,
                            'brand', CASE WHEN brand.id IS NULL THEN NULL ELSE
                                jsonb_build_object('id', brand.id, 'name', brand.name)
                            END
                        )
                    END
                )
                ORDER BY vehicle.created_at, vehicle.id
            )
            FROM public.client_vehicle AS client_vehicle
            JOIN public.vehicle AS vehicle
              ON vehicle.id = client_vehicle.vehicle_id
             AND vehicle.active = true
            LEFT JOIN public.car_model AS car_model
              ON car_model.id = vehicle.car_model_id
            LEFT JOIN public.brand AS brand
              ON brand.id = car_model.brand_id
            WHERE client_vehicle.client_id = client.id
              AND client_vehicle.active = true
        ), '[]'::JSONB)
    )
    FROM public.client AS client
    WHERE client.id = p_client_id
      AND client.active = true
$$;

CREATE OR REPLACE FUNCTION public.save_client_with_vehicles_v1(
    p_payload JSONB,
    p_actor_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    client_row public.client%ROWTYPE;
    vehicle_row public.vehicle%ROWTYPE;
    vehicle_payload JSONB;
    client_external_id UUID;
    vehicle_external_id UUID;
    normalized_phone TEXT;
    car_model_id_value INTEGER;
    model_year_value SMALLINT;
    client_was_reconciled BOOLEAN := false;
    client_was_idempotent_replay BOOLEAN := false;
BEGIN
    PERFORM public.assert_staff_actor_v1(p_actor_user_id);

    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'CLIENT_PAYLOAD_INVALID' USING ERRCODE = '22023';
    END IF;

    IF p_payload ? 'client_id' THEN
        SELECT *
        INTO client_row
        FROM public.client
        WHERE id = (p_payload->>'client_id')::INTEGER
          AND active = true
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'CLIENT_NOT_FOUND' USING ERRCODE = 'P0002';
        END IF;
    ELSE
        BEGIN
            client_external_id := (p_payload->>'external_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'CLIENT_EXTERNAL_ID_INVALID' USING ERRCODE = '22023';
        END;

        IF nullif(btrim(p_payload->>'client_name'), '') IS NULL THEN
            RAISE EXCEPTION 'CLIENT_NAME_REQUIRED' USING ERRCODE = '23502';
        END IF;

        normalized_phone := public.normalize_phone_v1(p_payload->>'phone_number');
        IF normalized_phone IS NULL THEN
            RAISE EXCEPTION 'CLIENT_PHONE_INVALID' USING ERRCODE = '22023';
        END IF;

        PERFORM pg_advisory_xact_lock(hashtextextended(normalized_phone, 0));

        SELECT *
        INTO client_row
        FROM public.client
        WHERE external_id = client_external_id
        FOR UPDATE;

        client_was_idempotent_replay := FOUND;

        IF FOUND AND client_row.phone_normalized <> normalized_phone THEN
            RAISE EXCEPTION 'CLIENT_EXTERNAL_ID_CONFLICT'
                USING ERRCODE = '23505';
        END IF;

        IF NOT FOUND THEN
            SELECT *
            INTO client_row
            FROM public.client
            WHERE phone_normalized = normalized_phone
              AND active = true
            FOR UPDATE;

            client_was_reconciled := FOUND;
        END IF;

        IF NOT FOUND THEN
            INSERT INTO public.client (
                external_id,
                client_name,
                phone_number,
                comments
            )
            VALUES (
                client_external_id,
                btrim(p_payload->>'client_name'),
                btrim(p_payload->>'phone_number'),
                nullif(btrim(p_payload->>'comments'), '')
            )
            RETURNING * INTO client_row;
        END IF;
    END IF;

    IF p_payload ? 'vehicles'
       AND jsonb_typeof(p_payload->'vehicles') <> 'array' THEN
        RAISE EXCEPTION 'CLIENT_VEHICLES_MUST_BE_ARRAY' USING ERRCODE = '22023';
    END IF;

    FOR vehicle_payload IN
        SELECT value
        FROM jsonb_array_elements(coalesce(p_payload->'vehicles', '[]'::JSONB))
    LOOP
        IF jsonb_typeof(vehicle_payload) <> 'object' THEN
            RAISE EXCEPTION 'VEHICLE_PAYLOAD_INVALID' USING ERRCODE = '22023';
        END IF;

        BEGIN
            vehicle_external_id := (vehicle_payload->>'external_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'VEHICLE_EXTERNAL_ID_INVALID' USING ERRCODE = '22023';
        END;

        car_model_id_value := NULL;
        model_year_value := NULL;
        IF vehicle_payload ? 'car_model_id'
           AND vehicle_payload->>'car_model_id' IS NOT NULL THEN
            car_model_id_value := (vehicle_payload->>'car_model_id')::INTEGER;

            IF NOT EXISTS (
                SELECT 1
                FROM public.car_model
                WHERE id = car_model_id_value
                  AND active = true
            ) THEN
                RAISE EXCEPTION 'VEHICLE_CAR_MODEL_NOT_FOUND'
                    USING ERRCODE = '23503';
            END IF;
        END IF;

        IF vehicle_payload ? 'model_year'
           AND vehicle_payload->>'model_year' IS NOT NULL THEN
            model_year_value := (vehicle_payload->>'model_year')::SMALLINT;
        END IF;

        SELECT *
        INTO vehicle_row
        FROM public.vehicle
        WHERE external_id = vehicle_external_id
        FOR UPDATE;

        IF FOUND THEN
            IF vehicle_row.car_model_id IS DISTINCT FROM car_model_id_value
               OR vehicle_row.model_year IS DISTINCT FROM model_year_value
               OR vehicle_row.plate_normalized IS DISTINCT FROM
                    public.normalize_vehicle_plate_v1(vehicle_payload->>'plate') THEN
                RAISE EXCEPTION 'VEHICLE_EXTERNAL_ID_CONFLICT'
                    USING ERRCODE = '23505';
            END IF;
        ELSE
            INSERT INTO public.vehicle (
                external_id,
                car_model_id,
                model_year,
                version,
                color,
                plate
            )
            VALUES (
                vehicle_external_id,
                car_model_id_value,
                model_year_value,
                nullif(btrim(vehicle_payload->>'version'), ''),
                nullif(btrim(vehicle_payload->>'color'), ''),
                nullif(btrim(vehicle_payload->>'plate'), '')
            )
            RETURNING * INTO vehicle_row;
        END IF;

        INSERT INTO public.client_vehicle (
            client_id,
            vehicle_id,
            comments,
            active
        )
        VALUES (
            client_row.id,
            vehicle_row.id,
            nullif(btrim(vehicle_payload->>'comments'), ''),
            true
        )
        ON CONFLICT (client_id, vehicle_id)
        DO UPDATE SET
            comments = coalesce(EXCLUDED.comments, public.client_vehicle.comments),
            active = true,
            updated_at = now();
    END LOOP;

    RETURN public.client_public_json_v1(client_row.id)
        || jsonb_build_object(
            'reconciled_by_phone', client_was_reconciled,
            'idempotent_replay', client_was_idempotent_replay
        );
END;
$$;

CREATE OR REPLACE FUNCTION public.search_clients_v1(
    p_query TEXT DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_car_model_id INTEGER DEFAULT NULL,
    p_model_year SMALLINT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    result JSONB;
    normalized_phone TEXT;
    safe_limit INTEGER := greatest(1, least(coalesce(p_limit, 50), 100));
    safe_offset INTEGER := greatest(coalesce(p_offset, 0), 0);
BEGIN
    normalized_phone := public.normalize_phone_v1(p_phone);

    WITH matching_clients AS (
        SELECT DISTINCT client.id
        FROM public.client AS client
        LEFT JOIN public.client_vehicle AS client_vehicle
          ON client_vehicle.client_id = client.id
         AND client_vehicle.active = true
        LEFT JOIN public.vehicle AS vehicle
          ON vehicle.id = client_vehicle.vehicle_id
         AND vehicle.active = true
        LEFT JOIN public.car_model AS car_model
          ON car_model.id = vehicle.car_model_id
        LEFT JOIN public.brand AS brand
          ON brand.id = car_model.brand_id
        WHERE client.active = true
          AND (
              nullif(btrim(p_query), '') IS NULL
              OR concat_ws(
                    ' ',
                    client.client_name,
                    client.phone_number,
                    client.phone_normalized,
                    brand.name,
                    car_model.name,
                    vehicle.model_year::TEXT,
                    vehicle.plate,
                    vehicle.plate_normalized
                 ) ILIKE '%' || btrim(p_query) || '%'
          )
          AND (
              nullif(btrim(p_phone), '') IS NULL
              OR (normalized_phone IS NOT NULL AND client.phone_normalized = normalized_phone)
              OR (normalized_phone IS NULL AND client.phone_normalized LIKE '%' ||
                    regexp_replace(p_phone, '[^0-9]', '', 'g') || '%')
          )
          AND (p_car_model_id IS NULL OR vehicle.car_model_id = p_car_model_id)
          AND (p_model_year IS NULL OR vehicle.model_year = p_model_year)
    ),
    page AS (
        SELECT matching_clients.id
        FROM matching_clients
        JOIN public.client ON client.id = matching_clients.id
        ORDER BY lower(client.client_name), client.id
        LIMIT safe_limit OFFSET safe_offset
    )
    SELECT jsonb_build_object(
        'data', coalesce((
            SELECT jsonb_agg(public.client_public_json_v1(page.id))
            FROM page
        ), '[]'::JSONB),
        'pagination', jsonb_build_object(
            'limit', safe_limit,
            'offset', safe_offset,
            'total', (SELECT count(*) FROM matching_clients)
        )
    )
    INTO result;

    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.service_public_json_v1(p_service_id BIGINT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT to_jsonb(service)
        || jsonb_build_object(
            'reported_failures', coalesce((
                SELECT jsonb_agg(
                    to_jsonb(failure) - 'service_id' - 'created_by_user_id'
                    ORDER BY failure.display_order_snapshot, failure.id
                )
                FROM public.service_reported_failure AS failure
                WHERE failure.service_id = service.id
            ), '[]'::JSONB)
        )
    FROM public.service AS service
    WHERE service.id = p_service_id
$$;

CREATE OR REPLACE FUNCTION public.create_service_v1(
    p_payload JSONB,
    p_actor_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

    subtotal_value := CASE WHEN p_payload->>'subtotal' IS NULL
        THEN NULL ELSE (p_payload->>'subtotal')::NUMERIC(12, 2) END;
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
$$;

CREATE OR REPLACE FUNCTION public.update_service_v1(
    p_payload JSONB,
    p_actor_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

    subtotal_value := CASE WHEN p_payload->>'subtotal' IS NULL
        THEN NULL ELSE (p_payload->>'subtotal')::NUMERIC(12, 2) END;
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
            other_text, created_by_user_id
        )
        VALUES (
            failure_external_id,
            service_row.id,
            (failure_payload->>'reported_failure_type_id')::SMALLINT,
            '', '', 1,
            nullif(btrim(failure_payload->>'other_text'), ''),
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
$$;

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

CREATE OR REPLACE FUNCTION public.get_service_v1(
    p_service_id BIGINT DEFAULT NULL,
    p_external_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    service_id_value BIGINT;
BEGIN
    SELECT id INTO service_id_value
    FROM public.service
    WHERE (p_service_id IS NOT NULL AND id = p_service_id)
       OR (p_external_id IS NOT NULL AND external_id = p_external_id)
    ORDER BY CASE WHEN p_external_id IS NOT NULL AND external_id = p_external_id THEN 0 ELSE 1 END
    LIMIT 1;

    IF service_id_value IS NULL THEN
        RAISE EXCEPTION 'SERVICE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    RETURN public.service_public_json_v1(service_id_value);
END;
$$;

CREATE OR REPLACE FUNCTION public.search_services_v1(
    p_folio TEXT DEFAULT NULL,
    p_date_from DATE DEFAULT NULL,
    p_date_to DATE DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_plate TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_client_id INTEGER DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
        JOIN public.vehicle AS vehicle ON vehicle.id = service.vehicle_id
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
          AND (p_status IS NULL OR service.status = upper(p_status))
          AND (p_client_id IS NULL OR service.client_id = p_client_id)
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
$$;

REVOKE ALL ON FUNCTION public.assert_staff_actor_v1(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_public_json_v1(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_client_with_vehicles_v1(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_clients_v1(TEXT, TEXT, INTEGER, SMALLINT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_public_json_v1(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_service_v1(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_service_v1(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_service_v1(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_service_v1(BIGINT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.assert_staff_actor_v1(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_public_json_v1(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_client_with_vehicles_v1(JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_clients_v1(TEXT, TEXT, INTEGER, SMALLINT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_public_json_v1(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_service_v1(JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_service_v1(JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_service_v1(UUID, INTEGER, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_service_v1(BIGINT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;

COMMENT ON FUNCTION public.save_client_with_vehicles_v1(JSONB, TEXT) IS
    'Atomically creates or reconciles a client by normalized phone and attaches one or more device-identified vehicles.';
COMMENT ON FUNCTION public.create_service_v1(JSONB, TEXT) IS
    'Atomically creates the complete service aggregate and assigns the official folio when the offline record synchronizes.';
COMMENT ON FUNCTION public.update_service_v1(JSONB, TEXT) IS
    'Atomically replaces mutable service fields and failure selections using optimistic locking.';
COMMENT ON FUNCTION public.transition_service_v1(UUID, INTEGER, TEXT, TEXT) IS
    'Atomically completes or cancels a service; repeated identical transitions are idempotent.';
