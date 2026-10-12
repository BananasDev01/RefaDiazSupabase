-- Run with psql -v ON_ERROR_STOP=1. All fixtures are rolled back.
BEGIN;
INSERT INTO public.role (id, description) VALUES (995501, 'EMPLEADO');
INSERT INTO public.person (id, name, last_name) VALUES (995501, 'Prueba', 'Renglones');
INSERT INTO public."user" (id, person_id, role_id)
VALUES ('95511111-1111-4111-8111-111111111111', 995501, 995501);
INSERT INTO public.brand (id, name, brand_type_id)
SELECT 995501, 'Prueba renglones', min(id) FROM public.brand_type;
INSERT INTO public.car_model (id, name, brand_id) VALUES (995501, 'Prueba', 995501);

DO $test$
DECLARE
    actor TEXT := '95511111-1111-4111-8111-111111111111';
    vehicle_link BIGINT;
    payload JSONB;
    result JSONB;
    rows_value JSONB;
    invalid_amount JSONB;
BEGIN
    PERFORM public.save_client_with_vehicles_v1(jsonb_build_object(
        'external_id', '95500000-0000-4000-8000-000000000001',
        'client_name', 'Prueba renglones', 'phone_number', '8199550101',
        'vehicles', jsonb_build_array(jsonb_build_object(
            'external_id', '95500000-0000-4000-8000-000000000002',
            'car_model_id', 995501, 'model_year', 2020
        ))
    ), actor);
    SELECT cv.id INTO STRICT vehicle_link FROM public.client_vehicle cv
    JOIN public.vehicle v ON v.id = cv.vehicle_id
    WHERE v.external_id = '95500000-0000-4000-8000-000000000002';

    SELECT jsonb_agg(jsonb_build_object(
        'external_id', gen_random_uuid(), 'reported_failure_type_id', id,
        'amount', CASE code WHEN 'RADIATOR_SERVICE' THEN 3800 WHEN 'OTHER' THEN 1800 WHEN 'WATER_PUMP' THEN 0 END,
        'observation', CASE code WHEN 'OTHER' THEN 'Corregir fuga en tubo de bomba' ELSE 'Servicio preventivo' END
    ) ORDER BY id) INTO rows_value FROM public.reported_failure_type
    WHERE code IN ('RADIATOR_SERVICE', 'OTHER', 'WATER_PUMP', 'COOLANT');
    payload := jsonb_build_object(
        'external_id', '95500000-0000-4000-8000-000000000003',
        'client_vehicle_id', vehicle_link, 'line_totals_mode', 'LINES',
        'subtotal', 999, 'tax_amount', 896, 'reported_failures', rows_value
    );
    result := public.create_service_v1(payload, actor);
    ASSERT (result->>'subtotal')::NUMERIC = 5600, 'Server must sum row amounts';
    ASSERT (result->>'total')::NUMERIC = 6496, 'Server must add explicit IVA';
    ASSERT result->>'line_totals_mode' = 'LINES';
    ASSERT result#>>'{reported_failures,0,other_text}' IS NULL, 'Standard type must not use other_text';
    ASSERT (result#>>'{reported_failures,0,amount}')::NUMERIC = 3800;
    ASSERT result#>>'{reported_failures,0,observation}' = 'Servicio preventivo';
    ASSERT (result#>>'{reported_failures,1,amount}')::NUMERIC = 0, 'Zero must remain explicit';
    ASSERT result#>>'{reported_failures,2,amount}' IS NULL, 'Missing cost must remain null';
    ASSERT (public.create_service_v1(payload, actor)->>'id') = result->>'id', 'Retry must be idempotent';

    payload := payload || jsonb_build_object('expected_version', result->'version');
    BEGIN
        PERFORM public.update_service_v1(payload - 'line_totals_mode', actor);
        RAISE EXCEPTION 'Expected contract downgrade rejection';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        ASSERT SQLERRM = 'SERVICE_LINE_CONTRACT_REQUIRED';
    END;
    payload := jsonb_set(payload, '{reported_failures,0,amount}', '250');
    payload := jsonb_set(payload, '{reported_failures,0,observation}', '"Revisión actualizada"');
    result := public.update_service_v1(payload, actor);
    ASSERT (result->>'subtotal')::NUMERIC = 2050;
    ASSERT result#>>'{reported_failures,0,observation}' = 'Revisión actualizada';
    ASSERT (result->>'version')::INTEGER = 2;

    SELECT jsonb_agg(value || '{"amount":null}'::JSONB) INTO rows_value
    FROM jsonb_array_elements(payload->'reported_failures');
    payload := payload || jsonb_build_object('expected_version', result->'version', 'reported_failures', rows_value);
    result := public.update_service_v1(payload, actor);
    ASSERT (result->>'subtotal')::NUMERIC = 0, 'Clearing every cost must not restore stale subtotal';
    ASSERT result#>>'{reported_failures,0,amount}' IS NULL;

    FOREACH invalid_amount IN ARRAY ARRAY['-1'::JSONB, '0.001'::JSONB, '"1800"'::JSONB, '10000000000'::JSONB] LOOP
        BEGIN
            PERFORM public.service_line_subtotal_v1(jsonb_set(payload, '{reported_failures,0,amount}', invalid_amount));
            RAISE EXCEPTION 'Expected invalid amount rejection';
        EXCEPTION WHEN SQLSTATE '22023' THEN
            ASSERT SQLERRM = 'SERVICE_LINE_AMOUNT_INVALID';
        END;
    END LOOP;
    BEGIN
        PERFORM public.create_service_v1(jsonb_set(payload || jsonb_build_object('external_id', gen_random_uuid()),
            '{reported_failures,0,other_text}', '"RDROW1:invalid"'), actor);
        RAISE EXCEPTION 'Expected standard other_text rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    payload := payload || jsonb_build_object('external_id', gen_random_uuid(), 'reported_failures', '[]'::JSONB, 'subtotal', 999);
    payload := payload - 'line_totals_mode';
    result := public.create_service_v1(payload, actor);
    ASSERT (result->>'subtotal')::NUMERIC = 999, 'Old contract must preserve aggregate subtotal';
    SELECT jsonb_agg(value || jsonb_build_object('external_id', gen_random_uuid())) INTO rows_value
    FROM jsonb_array_elements(rows_value);
    payload := payload || jsonb_build_object('expected_version', result->'version', 'line_totals_mode', 'LEGACY', 'reported_failures', rows_value);
    result := public.update_service_v1(payload, actor);
    ASSERT (result->>'subtotal')::NUMERIC = 999, 'Historical subtotal must survive migration to native observations';
    ASSERT NOT has_function_privilege('authenticated', 'public.create_service_v1(jsonb,text)', 'EXECUTE');
    ASSERT NOT has_function_privilege('anon', 'public.service_line_subtotal_v1(jsonb)', 'EXECUTE');
    RAISE NOTICE 'Native service row regression assertions passed';
END;
$test$;
ROLLBACK;
