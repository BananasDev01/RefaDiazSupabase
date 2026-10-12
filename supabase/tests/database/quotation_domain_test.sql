BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(35);

INSERT INTO public.role (id, description)
VALUES (994001, 'EMPLEADO');
INSERT INTO public.person (id, name, last_name)
VALUES (994001, 'Empleado', 'Cotizaciones');
INSERT INTO public."user" (id, person_id, role_id)
VALUES ('81111111-1111-4111-8111-111111111111', 994001, 994001);
INSERT INTO public.client (id, client_name, phone_number)
VALUES (994001, 'Cliente Cotización', '81 5555 4001');
INSERT INTO public.brand (id, name, brand_type_id)
SELECT 994001, 'Marca Cotización', min(id) FROM public.brand_type;
INSERT INTO public.car_model (id, name, brand_id)
VALUES (994001, 'Modelo Cotización', 994001);
INSERT INTO public.vehicle (id, car_model_id, model_year, color, plate)
VALUES (994001, 994001, 2020, 'Gris', 'COT-4001');
INSERT INTO public.client_vehicle (id, client_id, vehicle_id)
VALUES (994001, 994001, 994001);

SELECT extensions.ok(to_regclass('public.quotation') IS NOT NULL, 'quotation exists');
SELECT extensions.ok(to_regclass('public.quotation_option') IS NOT NULL, 'quotation_option exists');
SELECT extensions.ok(to_regclass('public.quotation_item') IS NOT NULL, 'quotation_item exists');
SELECT extensions.ok(to_regclass('public.service_item') IS NOT NULL, 'service_item exists');
SELECT extensions.ok(to_regclass('public.quotation_document') IS NOT NULL, 'quotation_document exists');
SELECT extensions.is(
    (SELECT start_value FROM pg_sequences WHERE schemaname = 'public'
        AND sequencename = 'quotation_folio_number_seq'),
    5000::BIGINT,
    'quotation official folios start at 5000'
);
SELECT extensions.ok(
    NOT has_table_privilege('anon', 'public.quotation', 'SELECT'),
    'anon cannot read quotations'
);
SELECT extensions.ok(
    NOT has_function_privilege('authenticated',
        'public.create_quotation_v1(jsonb,text)', 'EXECUTE'),
    'authenticated cannot bypass quotation Edge authorization'
);

SELECT public.create_quotation_v1(
    jsonb_build_object(
        'external_id', '80000000-0000-4000-8000-000000000001',
        'provisional_reference', 'PEND-COT-TEST-1',
        'quotation_date', CURRENT_DATE,
        'valid_until', CURRENT_DATE + 15,
        'client_vehicle_id', 994001,
        'attended_by_user_id', '81111111-1111-4111-8111-111111111111',
        'options', jsonb_build_array(
            jsonb_build_object(
                'external_id', '80000000-0000-4000-8000-000000000011',
                'name', 'Radiador nuevo',
                'tax_amount', 400,
                'warranty_months', 6,
                'items', jsonb_build_array(
                    jsonb_build_object(
                        'external_id', '80000000-0000-4000-8000-000000000111',
                        'description', 'Radiador', 'quantity', 2,
                        'unit_price', 1000, 'warranty_months', 6
                    ),
                    jsonb_build_object(
                        'external_id', '80000000-0000-4000-8000-000000000112',
                        'description', 'Instalación', 'quantity', 1,
                        'unit_price', 500
                    )
                )
            ),
            jsonb_build_object(
                'external_id', '80000000-0000-4000-8000-000000000012',
                'name', 'Reconstruido',
                'tax_amount', 288,
                'items', jsonb_build_array(jsonb_build_object(
                    'external_id', '80000000-0000-4000-8000-000000000121',
                    'description', 'Radiador reconstruido', 'quantity', 1,
                    'unit_price', 1800
                ))
            )
        )
    ),
    '81111111-1111-4111-8111-111111111111'
);

SELECT extensions.is((SELECT count(*) FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'), 1::BIGINT,
    'aggregate creates one quotation');
SELECT extensions.is((SELECT folio_series FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'), 'COT',
    'quotation uses independent COT series');
SELECT extensions.ok((SELECT folio_number >= 5000 FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'),
    'quotation receives an official folio');
SELECT extensions.is((SELECT count(*) FROM public.quotation_option o
    JOIN public.quotation q ON q.id = o.quotation_id
    WHERE q.external_id = '80000000-0000-4000-8000-000000000001'), 2::BIGINT,
    'quotation stores mutually exclusive options');
SELECT extensions.is((SELECT subtotal FROM public.quotation_option
    WHERE external_id = '80000000-0000-4000-8000-000000000011'),
    2500.00::NUMERIC, 'backend calculates option subtotal from items');
SELECT extensions.is((SELECT tax_amount FROM public.quotation_option
    WHERE external_id = '80000000-0000-4000-8000-000000000011'),
    400.00::NUMERIC, 'manual IVA is preserved exactly');
SELECT extensions.is((SELECT total FROM public.quotation_option
    WHERE external_id = '80000000-0000-4000-8000-000000000011'),
    2900.00::NUMERIC, 'backend calculates option total');
SELECT extensions.is((SELECT total FROM public.quotation_option
    WHERE external_id = '80000000-0000-4000-8000-000000000012'),
    2088.00::NUMERIC, 'alternative total is calculated independently');
SELECT extensions.is((SELECT accepted_total FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'),
    NULL::NUMERIC, 'mutually exclusive alternatives are not mixed into a header total');
SELECT extensions.is(
    (public.create_quotation_v1(jsonb_build_object(
        'external_id', '80000000-0000-4000-8000-000000000001',
        'client_vehicle_id', 994001,
        'options', jsonb_build_array(jsonb_build_object(
            'external_id', gen_random_uuid(), 'name', 'Ignored', 'tax_amount', 0,
            'items', jsonb_build_array(jsonb_build_object(
                'external_id', gen_random_uuid(), 'description', 'Ignored',
                'quantity', 1, 'unit_price', 0
            ))
        ))
    ), '81111111-1111-4111-8111-111111111111')->>'idempotent_replay')::BOOLEAN,
    true, 'create retry is idempotent'
);
SELECT extensions.is((SELECT count(*) FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'), 1::BIGINT,
    'create retry does not duplicate the quotation');

SELECT extensions.throws_ok(
    $$SELECT public.create_quotation_v1(
        '{"external_id":"80000000-0000-4000-8000-000000000099","client_vehicle_id":994001,"options":[{"external_id":"80000000-0000-4000-8000-000000000098","name":"Inválida","tax_amount":0,"items":[{"external_id":"80000000-0000-4000-8000-000000000097","description":"Precio negativo","quantity":1,"unit_price":-1}]}]}',
        '81111111-1111-4111-8111-111111111111')$$,
    '22023', NULL, 'negative prices are rejected atomically'
);
SELECT extensions.is((SELECT count(*) FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000099'), 0::BIGINT,
    'failed aggregate leaves no quotation behind');

SELECT public.convert_quotation_to_service_v1(
    '80000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000011', 1,
    '80000000-0000-4000-8000-000000000201', 'PEND-SER-COT-1', CURRENT_DATE,
    '81111111-1111-4111-8111-111111111111'
);

SELECT extensions.is((SELECT status FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'), 'ACCEPTED',
    'conversion accepts exactly one option');
SELECT extensions.is((SELECT accepted_total FROM public.quotation
    WHERE external_id = '80000000-0000-4000-8000-000000000001'),
    2900.00::NUMERIC, 'accepted total comes from the selected option only');
SELECT extensions.is((SELECT count(*) FROM public.service
    WHERE source_quotation_id = (SELECT id FROM public.quotation
        WHERE external_id = '80000000-0000-4000-8000-000000000001')),
    1::BIGINT, 'one quotation creates at most one service');
SELECT extensions.is((SELECT total FROM public.service
    WHERE external_id = '80000000-0000-4000-8000-000000000201'),
    2900.00::NUMERIC, 'converted service preserves selected totals');
SELECT extensions.is((SELECT count(*) FROM public.service_item si
    JOIN public.service s ON s.id = si.service_id
    WHERE s.external_id = '80000000-0000-4000-8000-000000000201'),
    2::BIGINT, 'conversion copies selected option concepts without recapture');
SELECT extensions.is((SELECT count(*) FROM public.service_item si
    JOIN public.service s ON s.id = si.service_id
    WHERE s.external_id = '80000000-0000-4000-8000-000000000201'
      AND si.description_snapshot = 'Radiador reconstruido'),
    0::BIGINT, 'conversion does not mix concepts from another alternative');
SELECT extensions.is((public.convert_quotation_to_service_v1(
    '80000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000011', 1,
    '80000000-0000-4000-8000-000000000201', 'PEND-SER-COT-1', CURRENT_DATE,
    '81111111-1111-4111-8111-111111111111')->>'idempotent_replay')::BOOLEAN,
    true, 'conversion retry returns the original service');
SELECT extensions.throws_ok(
    $$SELECT public.convert_quotation_to_service_v1(
        '80000000-0000-4000-8000-000000000001',
        '80000000-0000-4000-8000-000000000012', 2,
        '80000000-0000-4000-8000-000000000201', 'PEND-SER-COT-1', CURRENT_DATE,
        '81111111-1111-4111-8111-111111111111')$$,
    '23505', 'QUOTATION_ALREADY_CONVERTED',
    'idempotent conversion requires the same accepted option'
);

SELECT public.create_quotation_v1(jsonb_build_object(
    'external_id', '80000000-0000-4000-8000-000000000301',
    'quotation_date', CURRENT_DATE - 10, 'valid_until', CURRENT_DATE - 1,
    'client_vehicle_id', 994001,
    'options', jsonb_build_array(jsonb_build_object(
        'external_id', '80000000-0000-4000-8000-000000000311',
        'name', 'Vencida', 'tax_amount', 0,
        'items', jsonb_build_array(jsonb_build_object(
            'external_id', '80000000-0000-4000-8000-000000000312',
            'description', 'Servicio', 'quantity', 1, 'unit_price', 100
        ))
    ))
), '81111111-1111-4111-8111-111111111111');

SELECT extensions.is((public.get_quotation_v1(NULL,
    '80000000-0000-4000-8000-000000000301')->>'status'), 'EXPIRED',
    'expired status is derived from validity');
SELECT extensions.throws_ok(
    $$SELECT public.convert_quotation_to_service_v1(
        '80000000-0000-4000-8000-000000000301',
        '80000000-0000-4000-8000-000000000311', 1,
        '80000000-0000-4000-8000-000000000321', NULL, CURRENT_DATE,
        '81111111-1111-4111-8111-111111111111')$$,
    '55000', 'QUOTATION_EXPIRED', 'expiration blocks conversion'
);
SELECT extensions.is((public.transition_quotation_v1(
    '80000000-0000-4000-8000-000000000301', 1, 'REACTIVATE', CURRENT_DATE + 30,
    '81111111-1111-4111-8111-111111111111')->>'status'), 'DRAFT',
    'explicit reactivation restores an expired quotation to draft');

SELECT public.create_service_v1(jsonb_build_object(
    'external_id', '80000000-0000-4000-8000-000000000322',
    'client_vehicle_id', 994001, 'tax_amount', 0
), '81111111-1111-4111-8111-111111111111');
SELECT extensions.throws_ok(
    $$SELECT public.convert_quotation_to_service_v1(
        '80000000-0000-4000-8000-000000000301',
        '80000000-0000-4000-8000-000000000311', 2,
        '80000000-0000-4000-8000-000000000322', NULL, CURRENT_DATE,
        '81111111-1111-4111-8111-111111111111')$$,
    '23505', 'QUOTATION_SERVICE_EXTERNAL_ID_CONFLICT',
    'conversion cannot reuse or hijack an existing service external id'
);

SELECT extensions.is((public.duplicate_quotation_v1(
    '80000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000401', 'PEND-COT-COPY',
    CURRENT_DATE, CURRENT_DATE + 20,
    '81111111-1111-4111-8111-111111111111')->>'status'), 'DRAFT',
    'duplication creates a new draft quotation');
SELECT extensions.is((SELECT count(*) FROM public.quotation_option o
    JOIN public.quotation q ON q.id = o.quotation_id
    WHERE q.external_id = '80000000-0000-4000-8000-000000000401'),
    2::BIGINT, 'duplication copies all alternatives');

SELECT * FROM extensions.finish();
ROLLBACK;
