-- Búsqueda por palabras: cada palabra debe aparecer en algún dato, en cualquier orden.
-- Clientes: agrega el color del vehículo. Órdenes: nuevo parámetro p_query de texto
-- libre (folio, cliente, teléfonos, marca, modelo, año, color, placas, serie del
-- radiador y motivo de ingreso). Parte de las definiciones vigentes.

CREATE OR REPLACE FUNCTION public.search_clients_v1(p_query text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_car_model_id integer DEFAULT NULL::integer, p_model_year smallint DEFAULT NULL::smallint, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
              -- Every word must appear somewhere in the client or one of its vehicles.
              OR NOT EXISTS (
                  SELECT 1
                  FROM regexp_split_to_table(btrim(p_query), '\s+') AS term
                  WHERE concat_ws(
                        ' ',
                        client.client_name,
                        client.phone_number,
                        client.phone_normalized,
                        client.secondary_phone_number,
                        public.normalize_phone_v1(client.secondary_phone_number),
                        brand.name,
                        car_model.name,
                        vehicle.model_year::TEXT,
                        vehicle.color,
                        vehicle.plate,
                        vehicle.plate_normalized
                     ) NOT ILIKE '%' || term || '%'
              )
          )
          AND (
              nullif(btrim(p_phone), '') IS NULL
              OR (normalized_phone IS NOT NULL AND (client.phone_normalized = normalized_phone OR public.normalize_phone_v1(client.secondary_phone_number) = normalized_phone))
              OR (normalized_phone IS NULL AND client.phone_normalized LIKE '%' ||
                    regexp_replace(p_phone, '[^0-9]', '', 'g') || '%')
              OR (normalized_phone IS NULL AND public.normalize_phone_v1(client.secondary_phone_number) LIKE '%' || regexp_replace(p_phone, '[^0-9]', '', 'g') || '%')
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
$function$;

DROP FUNCTION IF EXISTS public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.search_services_v1(p_folio text DEFAULT NULL::text, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_phone text DEFAULT NULL::text, p_plate text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_client_id integer DEFAULT NULL::integer, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_query text DEFAULT NULL::text)
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
        JOIN public.vehicle AS vehicle ON vehicle.id = service.vehicle_id
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
          AND (p_status IS NULL OR service.status = upper(p_status))
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

REVOKE ALL ON FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_services_v1(TEXT, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT) TO service_role;
