CREATE OR REPLACE FUNCTION public.normalize_phone_v1(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    digits TEXT;
BEGIN
    IF value IS NULL OR btrim(value) = '' THEN
        RETURN NULL;
    END IF;

    digits := regexp_replace(value, '[^0-9]', '', 'g');

    -- Mexican local numbers are stored in E.164 form using country code 52.
    IF digits ~ '^[0-9]{10}$' THEN
        RETURN '+52' || digits;
    END IF;

    -- Already-normalized Mexican number without the plus sign.
    IF digits ~ '^52[0-9]{10}$' THEN
        RETURN '+' || digits;
    END IF;

    -- Legacy Mexican mobile notation (+52 1) is normalized to current E.164.
    IF digits ~ '^521[0-9]{10}$' THEN
        RETURN '+52' || substring(digits FROM 4);
    END IF;

    -- Other explicitly international numbers retain their country code.
    IF left(btrim(value), 1) = '+' AND digits ~ '^[1-9][0-9]{7,14}$' THEN
        RETURN '+' || digits;
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_phone_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_phone_v1(TEXT) TO authenticated, service_role;

DO $$
DECLARE
    invalid_client_count INTEGER;
    duplicate_phone TEXT;
BEGIN
    SELECT count(*)
    INTO invalid_client_count
    FROM public.client
    WHERE client_name IS NULL
       OR btrim(client_name) = ''
       OR public.normalize_phone_v1(phone_number) IS NULL;

    IF invalid_client_count > 0 THEN
        RAISE EXCEPTION
            'Cannot adapt client: % row(s) have a blank name or a phone that cannot be normalized',
            invalid_client_count;
    END IF;

    SELECT public.normalize_phone_v1(phone_number)
    INTO duplicate_phone
    FROM public.client
    GROUP BY public.normalize_phone_v1(phone_number)
    HAVING count(*) > 1
    LIMIT 1;

    IF duplicate_phone IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot adapt client: duplicate normalized phone % must be reconciled first',
            duplicate_phone;
    END IF;
END;
$$;

ALTER TABLE public.client
    ADD COLUMN external_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN phone_normalized TEXT
        GENERATED ALWAYS AS (public.normalize_phone_v1(phone_number)) STORED;

ALTER TABLE public.client
    ALTER COLUMN client_name SET NOT NULL,
    ALTER COLUMN phone_number SET NOT NULL,
    ALTER COLUMN phone_normalized SET NOT NULL,
    ADD CONSTRAINT client_external_id_unique UNIQUE (external_id),
    ADD CONSTRAINT client_phone_normalized_unique UNIQUE (phone_normalized),
    ADD CONSTRAINT client_name_not_blank CHECK (btrim(client_name) <> ''),
    ADD CONSTRAINT client_phone_number_not_blank CHECK (btrim(phone_number) <> '');

CREATE INDEX client_name_search_idx
    ON public.client (lower(btrim(client_name)) text_pattern_ops);

COMMENT ON COLUMN public.client.external_id IS
    'Stable device-generated UUID used for offline identity and idempotency; not the primary key.';
COMMENT ON COLUMN public.client.phone_normalized IS
    'Generated E.164-like business matching key. The internal integer id remains the primary key.';

CREATE OR REPLACE FUNCTION public.normalize_vehicle_plate_v1(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT NULLIF(upper(regexp_replace(btrim(value), '[^A-Za-z0-9]', '', 'g')), '')
$$;

REVOKE ALL ON FUNCTION public.normalize_vehicle_plate_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_vehicle_plate_v1(TEXT) TO authenticated, service_role;

DO $$
DECLARE
    conflicting_vehicle_id INTEGER;
    duplicate_client_id INTEGER;
    duplicate_vehicle_id INTEGER;
    duplicate_relation_count INTEGER;
BEGIN
    SELECT vehicle_id
    INTO conflicting_vehicle_id
    FROM public.client_vehicle
    GROUP BY vehicle_id
    HAVING count(DISTINCT NULLIF(btrim(color), '')) > 1
        OR count(DISTINCT public.normalize_vehicle_plate_v1(plate)) > 1
    LIMIT 1;

    IF conflicting_vehicle_id IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot adapt vehicle %: client_vehicle contains conflicting color or plate values',
            conflicting_vehicle_id;
    END IF;

    SELECT client_id, vehicle_id, count(*)
    INTO duplicate_client_id, duplicate_vehicle_id, duplicate_relation_count
    FROM public.client_vehicle
    GROUP BY client_id, vehicle_id
    HAVING count(*) > 1
    LIMIT 1;

    IF duplicate_client_id IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot adapt client_vehicle: duplicate relation client_id %, vehicle_id % occurs % times',
            duplicate_client_id,
            duplicate_vehicle_id,
            duplicate_relation_count;
    END IF;
END;
$$;

ALTER TABLE public.vehicle
    ADD COLUMN external_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN model_year SMALLINT,
    ADD COLUMN color VARCHAR(100),
    ADD COLUMN plate VARCHAR(20),
    ADD COLUMN plate_normalized TEXT
        GENERATED ALWAYS AS (public.normalize_vehicle_plate_v1(plate)) STORED;

UPDATE public.vehicle AS vehicle
SET color = source.color,
    plate = source.plate
FROM (
    SELECT
        vehicle_id,
        max(NULLIF(btrim(color), '')) AS color,
        max(NULLIF(btrim(plate), '')) AS plate
    FROM public.client_vehicle
    GROUP BY vehicle_id
) AS source
WHERE source.vehicle_id = vehicle.id;

ALTER TABLE public.vehicle
    ADD CONSTRAINT vehicle_external_id_unique UNIQUE (external_id),
    ADD CONSTRAINT vehicle_model_year_valid
        CHECK (model_year IS NULL OR model_year BETWEEN 1886 AND 2100),
    ADD CONSTRAINT vehicle_color_not_blank
        CHECK (color IS NULL OR btrim(color) <> ''),
    ADD CONSTRAINT vehicle_plate_not_blank
        CHECK (plate IS NULL OR btrim(plate) <> '');

CREATE INDEX vehicle_plate_normalized_idx
    ON public.vehicle (plate_normalized)
    WHERE plate_normalized IS NOT NULL;

CREATE INDEX vehicle_model_year_compatibility_idx
    ON public.vehicle (car_model_id, model_year)
    WHERE car_model_id IS NOT NULL AND model_year IS NOT NULL;

CREATE INDEX product_car_model_product_lookup_idx
    ON public.product_car_model (product_id)
    WHERE active IS TRUE;

CREATE INDEX product_car_model_compatibility_lookup_idx
    ON public.product_car_model (
        car_model_id,
        initial_year,
        last_year,
        product_id
    )
    WHERE active IS TRUE;

COMMENT ON COLUMN public.vehicle.external_id IS
    'Stable device-generated UUID used for offline identity and document association.';
COMMENT ON COLUMN public.vehicle.model_year IS
    'Actual model year of this customer vehicle; distinct from product compatibility ranges.';
COMMENT ON COLUMN public.vehicle.plate_normalized IS
    'Generated uppercase alphanumeric plate used for lookup; uniqueness is intentionally deferred.';

ALTER TABLE public.client_vehicle
    ADD COLUMN id BIGINT GENERATED BY DEFAULT AS IDENTITY;

ALTER TABLE public.client_vehicle
    ADD CONSTRAINT client_vehicle_pkey PRIMARY KEY (id),
    ADD CONSTRAINT client_vehicle_client_vehicle_unique UNIQUE (client_id, vehicle_id),
    DROP COLUMN color,
    DROP COLUMN plate;

CREATE INDEX client_vehicle_client_id_idx
    ON public.client_vehicle (client_id);

CREATE INDEX client_vehicle_vehicle_id_idx
    ON public.client_vehicle (vehicle_id);

COMMENT ON TABLE public.client_vehicle IS
    'Stable customer-to-vehicle relationship. Physical vehicle attributes live on vehicle.';
