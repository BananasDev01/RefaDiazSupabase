-- Permite editar nombre y comentarios de un cliente existente e impide que un
-- mismo cliente tenga dos vehículos activos con las mismas placas («SIN PLACAS»
-- y «A LA MANO» pueden repetirse). Parte de la definición vigente de
-- save_client_with_vehicles_v1; el resto del contrato es idéntico.

CREATE OR REPLACE FUNCTION public.save_client_with_vehicles_v1(p_payload jsonb, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

    IF p_payload ? 'secondary_phone_number' THEN
        IF jsonb_typeof(p_payload->'secondary_phone_number') NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'CLIENT_SECONDARY_PHONE_INVALID' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(p_payload->>'secondary_phone_number'), '') IS NOT NULL
           AND public.normalize_phone_v1(p_payload->>'secondary_phone_number') IS NULL THEN
            RAISE EXCEPTION 'CLIENT_SECONDARY_PHONE_INVALID' USING ERRCODE = '22023';
        END IF;
        IF public.normalize_phone_v1(p_payload->>'secondary_phone_number') = client_row.phone_normalized THEN
            RAISE EXCEPTION 'CLIENT_SECONDARY_PHONE_DUPLICATE' USING ERRCODE = '22023';
        END IF;
        -- A retry or phone reconciliation must never overwrite an existing contact.
        IF NOT (p_payload ? 'client_id') AND (client_was_reconciled OR client_was_idempotent_replay) THEN
            IF nullif(btrim(p_payload->>'secondary_phone_number'), '') IS NOT NULL
               AND public.normalize_phone_v1(p_payload->>'secondary_phone_number')
               IS DISTINCT FROM public.normalize_phone_v1(client_row.secondary_phone_number) THEN
                RAISE EXCEPTION 'CLIENT_SECONDARY_PHONE_CONFLICT' USING ERRCODE = '23505';
            END IF;
        ELSE
            UPDATE public.client SET secondary_phone_number = nullif(btrim(p_payload->>'secondary_phone_number'), ''),
                updated_at = now() WHERE id = client_row.id;
        END IF;
    END IF;

    -- Editing an existing client may update its name and comments.
    IF p_payload ? 'client_id' THEN
        IF p_payload ? 'client_name' THEN
            IF nullif(btrim(p_payload->>'client_name'), '') IS NULL THEN
                RAISE EXCEPTION 'CLIENT_NAME_REQUIRED' USING ERRCODE = '23502';
            END IF;
            UPDATE public.client SET client_name = btrim(p_payload->>'client_name'), updated_at = now()
            WHERE id = client_row.id;
        END IF;
        IF p_payload ? 'comments' THEN
            UPDATE public.client SET comments = nullif(btrim(p_payload->>'comments'), ''), updated_at = now()
            WHERE id = client_row.id;
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
            -- A client cannot hold two active vehicles with the same plate; the shop's
            -- placeholders for vehicles without plates or parts brought by hand may repeat.
            IF public.normalize_vehicle_plate_v1(vehicle_payload->>'plate') IS NOT NULL
               AND public.normalize_vehicle_plate_v1(vehicle_payload->>'plate') NOT IN ('SINPLACAS', 'ALAMANO')
               AND EXISTS (
                   SELECT 1
                   FROM public.client_vehicle AS existing_link
                   JOIN public.vehicle AS existing_vehicle ON existing_vehicle.id = existing_link.vehicle_id
                   WHERE existing_link.client_id = client_row.id
                     AND existing_link.active = true
                     AND existing_vehicle.active = true
                     AND existing_vehicle.plate_normalized = public.normalize_vehicle_plate_v1(vehicle_payload->>'plate')
               ) THEN
                RAISE EXCEPTION 'VEHICLE_PLATE_DUPLICATE' USING ERRCODE = '23505';
            END IF;
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
$function$;
