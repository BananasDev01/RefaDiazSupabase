BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(46);

INSERT INTO public.role (id, description)
VALUES
    (993101, 'EMPLEADO'),
    (993102, 'CLIENTE');

INSERT INTO public.person (id, name, last_name)
VALUES
    (993101, 'Empleado', 'API'),
    (993102, 'Sin', 'Permisos');

INSERT INTO public."user" (id, person_id, role_id)
VALUES
    ('71111111-1111-4111-8111-111111111111', 993101, 993101),
    ('72222222-2222-4222-8222-222222222222', 993102, 993102);

INSERT INTO public.brand (id, name, brand_type_id)
SELECT 993101, 'Nissan API', min(id)
FROM public.brand_type;

INSERT INTO public.car_model (id, name, brand_id)
VALUES
    (993101, 'Versa', 993101),
    (993102, 'March', 993101);

SELECT extensions.ok(
    to_regprocedure('public.save_client_with_vehicles_v1(jsonb,text)') IS NOT NULL,
    'client aggregate RPC exists'
);
SELECT extensions.ok(
    to_regprocedure('public.create_service_v1(jsonb,text)') IS NOT NULL,
    'service creation RPC exists'
);
SELECT extensions.ok(
    NOT has_function_privilege(
        'anon',
        'public.create_service_v1(jsonb,text)',
        'EXECUTE'
    ),
    'anon cannot execute service creation RPC'
);
SELECT extensions.ok(
    NOT has_function_privilege(
        'authenticated',
        'public.create_service_v1(jsonb,text)',
        'EXECUTE'
    ),
    'authenticated cannot bypass the Edge authorization boundary'
);

SELECT public.save_client_with_vehicles_v1(
    jsonb_build_object(
        'external_id', '70000000-0000-4000-8000-000000000001',
        'client_name', 'Cliente API Original',
        'phone_number', '81 4567 8901',
        'vehicles', jsonb_build_array(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000011',
                'car_model_id', 993101,
                'model_year', 2019,
                'version', 'Advance',
                'color', 'Gris',
                'plate', 'ver-2019',
                'comments', 'Vehículo principal'
            ),
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000012',
                'car_model_id', 993102,
                'model_year', 2020,
                'color', 'Rojo',
                'plate', 'mar-2020'
            )
        )
    ),
    '71111111-1111-4111-8111-111111111111'
);

SELECT extensions.is(
    (SELECT count(*) FROM public.client WHERE phone_normalized = '+528145678901'),
    1::BIGINT,
    'client aggregate creates one client'
);
SELECT extensions.is(
    (SELECT count(*) FROM public.vehicle WHERE external_id::TEXT LIKE '70000000-0000-4000-8000-00000000001%'),
    2::BIGINT,
    'client aggregate creates multiple vehicles'
);
SELECT extensions.is(
    (
        SELECT count(*)
        FROM public.client_vehicle
        WHERE client_id = (
            SELECT id FROM public.client WHERE phone_normalized = '+528145678901'
        )
    ),
    2::BIGINT,
    'both vehicles are associated with the client'
);
SELECT extensions.is(
    (SELECT phone_normalized FROM public.client WHERE phone_number = '81 4567 8901'),
    '+528145678901',
    'phone is normalized for matching'
);
SELECT extensions.is(
    (
        SELECT model_year
        FROM public.vehicle
        WHERE external_id = '70000000-0000-4000-8000-000000000011'
    ),
    2019::SMALLINT,
    'vehicle stores its actual model year'
);
SELECT extensions.is(
    (public.search_clients_v1('Nissan API Versa 2019', NULL, NULL, NULL, 50, 0)#>>'{pagination,total}')::INTEGER,
    1,
    'client search matches brand, model and year together'
);
SELECT extensions.is(
    (public.search_clients_v1(NULL, '8145678901', NULL, NULL, 50, 0)#>>'{pagination,total}')::INTEGER,
    1,
    'client search matches normalized phone'
);
SELECT extensions.is(
    (public.search_clients_v1(NULL, NULL, 993101, 2019::SMALLINT, 50, 0)#>>'{pagination,total}')::INTEGER,
    1,
    'client search filters by car model and actual year'
);

SELECT extensions.is(
    (
        public.save_client_with_vehicles_v1(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000001',
                'client_name', 'Cliente API Original',
                'phone_number', '81 4567 8901',
                'vehicles', jsonb_build_array(
                    jsonb_build_object(
                        'external_id', '70000000-0000-4000-8000-000000000011',
                        'car_model_id', 993101,
                        'model_year', 2019,
                        'plate', 'ver-2019'
                    )
                )
            ),
            '71111111-1111-4111-8111-111111111111'
        )->>'idempotent_replay'
    )::BOOLEAN,
    true,
    'repeating the client external id is identified as an idempotent replay'
);

SELECT extensions.is(
    (SELECT count(*) FROM public.client WHERE phone_normalized = '+528145678901'),
    1::BIGINT,
    'repeating the same client external id does not duplicate the client'
);
SELECT extensions.is(
    (SELECT count(*) FROM public.vehicle WHERE external_id = '70000000-0000-4000-8000-000000000011'),
    1::BIGINT,
    'repeating the same vehicle external id does not duplicate the vehicle'
);

SELECT extensions.is(
    (
        public.save_client_with_vehicles_v1(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000002',
                'client_name', 'Nombre capturado sin conexión',
                'phone_number', '8145678901',
                'vehicles', jsonb_build_array(
                    jsonb_build_object(
                        'external_id', '70000000-0000-4000-8000-000000000013',
                        'car_model_id', 993101,
                        'model_year', 2021,
                        'plate', 'new-2021'
                    )
                )
            ),
            '71111111-1111-4111-8111-111111111111'
        )->>'reconciled_by_phone'
    )::BOOLEAN,
    true,
    'offline client is reconciled with an existing normalized phone'
);
SELECT extensions.is(
    (SELECT count(*) FROM public.client WHERE phone_normalized = '+528145678901'),
    1::BIGINT,
    'phone reconciliation keeps a single client row'
);
SELECT extensions.is(
    (SELECT client_name FROM public.client WHERE phone_normalized = '+528145678901'),
    'Cliente API Original',
    'phone reconciliation preserves the existing client data'
);
SELECT extensions.is(
    (
        SELECT count(*)
        FROM public.client_vehicle
        WHERE client_id = (
            SELECT id FROM public.client WHERE phone_normalized = '+528145678901'
        )
    ),
    3::BIGINT,
    'phone reconciliation can attach a newly captured vehicle'
);
SELECT extensions.throws_ok(
    $$SELECT public.save_client_with_vehicles_v1(
        '{"external_id":"70000000-0000-4000-8000-000000000099","client_name":"No autorizado","phone_number":"8111111111"}',
        '72222222-2222-4222-8222-222222222222'
    )$$,
    '42501',
    NULL,
    'RPC validates that the actor has a staff role'
);

SELECT public.create_service_v1(
    jsonb_build_object(
        'external_id', '70000000-0000-4000-8000-000000000021',
        'provisional_reference', 'PEND-SER-API-21',
        'client_vehicle_id', (
            SELECT client_vehicle.id
            FROM public.client_vehicle
            JOIN public.vehicle ON vehicle.id = client_vehicle.vehicle_id
            WHERE vehicle.external_id = '70000000-0000-4000-8000-000000000011'
        ),
        'service_date', '2026-08-19',
        'subtotal', 1000,
        'tax_amount', 160,
        'reported_failure_summary', 'Se calienta',
        'reported_failures', jsonb_build_array(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000022',
                'reported_failure_type_id', (
                    SELECT id FROM public.reported_failure_type
                    WHERE code = 'RADIATOR_SERVICE'
                )
            ),
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000023',
                'reported_failure_type_id', (
                    SELECT id FROM public.reported_failure_type
                    WHERE code = 'OTHER'
                ),
                'other_text', 'Ruido adicional'
            )
        ),
        'internal_notes', jsonb_build_array(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000024',
                'note', 'SECRETO_API_NO_PUBLICAR'
            )
        )
    ),
    '71111111-1111-4111-8111-111111111111'
);

SELECT extensions.is(
    (SELECT total FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    1160.00::NUMERIC,
    'service RPC calculates total from captured subtotal and IVA amount'
);
SELECT extensions.ok(
    (SELECT folio_number >= 5000 FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    'synchronization assigns an official folio'
);
SELECT extensions.is(
    (
        SELECT count(*) FROM public.service_reported_failure
        WHERE service_id = (
            SELECT id FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'
        )
    ),
    2::BIGINT,
    'service creation writes all failure selections atomically'
);
SELECT extensions.is(
    (
        SELECT label_snapshot FROM public.service_reported_failure
        WHERE external_id = '70000000-0000-4000-8000-000000000023'
    ),
    'Otros',
    'failure selection preserves the catalog label snapshot'
);
SELECT extensions.is(
    (
        SELECT count(*) FROM public.service_internal_note
        WHERE note = 'SECRETO_API_NO_PUBLICAR'
    ),
    1::BIGINT,
    'private note is stored separately'
);
SELECT extensions.ok(
    NOT (public.get_service_v1(NULL, '70000000-0000-4000-8000-000000000021') ? 'internal_notes'),
    'service detail contract has no internal_notes field'
);
SELECT extensions.is(
    (SELECT count(*) FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    1::BIGINT,
    'service creation writes one aggregate root'
);

SELECT extensions.is(
    (
        public.create_service_v1(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000021',
                'provisional_reference', 'PEND-SER-API-21',
                'client_vehicle_id', (
                    SELECT client_vehicle_id FROM public.service
                    WHERE external_id = '70000000-0000-4000-8000-000000000021'
                ),
                'tax_amount', 160
            ),
            '71111111-1111-4111-8111-111111111111'
        )->>'idempotent_replay'
    )::BOOLEAN,
    true,
    'repeating service creation by external id returns an idempotent replay'
);
SELECT extensions.is(
    (SELECT count(*) FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    1::BIGINT,
    'idempotent replay does not duplicate the service'
);
SELECT extensions.is(
    (public.search_services_v1(NULL, NULL, NULL, '8145678901', NULL, NULL, NULL, 50, 0)#>>'{pagination,total}')::INTEGER,
    1,
    'service listing filters by client phone'
);
SELECT extensions.is(
    (public.search_services_v1(NULL, NULL, NULL, NULL, 'VER 2019', NULL, NULL, 50, 0)#>>'{pagination,total}')::INTEGER,
    1,
    'service listing filters by normalized plate'
);
SELECT extensions.is(
    (
        public.search_services_v1(
            NULL, NULL, NULL, NULL, NULL, NULL,
            (SELECT id FROM public.client WHERE phone_normalized = '+528145678901'),
            50, 0
        )#>>'{pagination,total}'
    )::INTEGER,
    1,
    'service history can be listed by client id'
);

SELECT public.update_service_v1(
    jsonb_build_object(
        'external_id', '70000000-0000-4000-8000-000000000021',
        'expected_version', 1,
        'client_vehicle_id', (
            SELECT client_vehicle_id FROM public.service
            WHERE external_id = '70000000-0000-4000-8000-000000000021'
        ),
        'service_date', '2026-08-20',
        'subtotal', 1200,
        'tax_amount', 192,
        'reported_failure_summary', 'Falla actualizada',
        'reported_failures', jsonb_build_array(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000025',
                'reported_failure_type_id', (
                    SELECT id FROM public.reported_failure_type
                    WHERE code = 'COOLING_SYSTEM_WASH'
                )
            )
        ),
        'internal_notes', jsonb_build_array(
            jsonb_build_object(
                'external_id', '70000000-0000-4000-8000-000000000026',
                'note', 'SEGUNDA_NOTA_PRIVADA'
            )
        )
    ),
    '71111111-1111-4111-8111-111111111111'
);

SELECT extensions.is(
    (SELECT total FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    1392.00::NUMERIC,
    'service update recalculates total atomically'
);
SELECT extensions.is(
    (SELECT version FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    2,
    'service update increments optimistic version'
);
SELECT extensions.is(
    (
        SELECT count(*) FROM public.service_reported_failure
        WHERE service_id = (
            SELECT id FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'
        )
    ),
    1::BIGINT,
    'service update replaces current failure selections'
);
SELECT extensions.is(
    (
        SELECT count(*) FROM public.service_internal_note
        WHERE service_id = (
            SELECT id FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'
        )
    ),
    2::BIGINT,
    'service update appends private notes without exposing them'
);
SELECT extensions.ok(
    position(
        'SEGUNDA_NOTA_PRIVADA' IN
        public.get_service_v1(NULL, '70000000-0000-4000-8000-000000000021')::TEXT
    ) = 0,
    'private note text never appears in service detail'
);
SELECT extensions.throws_ok(
    $$SELECT public.update_service_v1(
        '{"external_id":"70000000-0000-4000-8000-000000000021","expected_version":1,"client_vehicle_id":1,"tax_amount":0}',
        '71111111-1111-4111-8111-111111111111'
    )$$,
    'P0001',
    NULL,
    'stale service update reports an optimistic concurrency conflict'
);

SELECT extensions.is(
    (
        public.transition_service_v1(
            '70000000-0000-4000-8000-000000000021',
            2,
            'COMPLETE',
            '71111111-1111-4111-8111-111111111111'
        )->>'status'
    ),
    'COMPLETED',
    'valid transition completes the service'
);
SELECT extensions.is(
    (SELECT version FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    3,
    'completion increments service version'
);
SELECT extensions.is(
    (
        public.transition_service_v1(
            '70000000-0000-4000-8000-000000000021',
            2,
            'COMPLETE',
            '71111111-1111-4111-8111-111111111111'
        )->>'idempotent_replay'
    )::BOOLEAN,
    true,
    'repeated completion returns an idempotent replay'
);
SELECT extensions.is(
    (SELECT version FROM public.service WHERE external_id = '70000000-0000-4000-8000-000000000021'),
    3,
    'repeated completion does not mutate the service again'
);
SELECT extensions.throws_ok(
    $$SELECT public.update_service_v1(
        '{"external_id":"70000000-0000-4000-8000-000000000021","expected_version":3,"client_vehicle_id":1,"tax_amount":0}',
        '71111111-1111-4111-8111-111111111111'
    )$$,
    '55000',
    NULL,
    'completed service cannot be edited'
);

SELECT public.create_service_v1(
    jsonb_build_object(
        'external_id', '70000000-0000-4000-8000-000000000031',
        'provisional_reference', 'PEND-SER-API-31',
        'client_vehicle_id', (
            SELECT id FROM public.client_vehicle ORDER BY id LIMIT 1
        ),
        'tax_amount', 0
    ),
    '71111111-1111-4111-8111-111111111111'
);
SELECT extensions.is(
    (
        public.transition_service_v1(
            '70000000-0000-4000-8000-000000000031',
            1,
            'CANCEL',
            '71111111-1111-4111-8111-111111111111'
        )->>'status'
    ),
    'CANCELLED',
    'valid transition cancels a draft service'
);
SELECT extensions.ok(
    has_function_privilege(
        'service_role',
        'public.create_service_v1(jsonb,text)',
        'EXECUTE'
    ),
    'service role can execute RPC after Edge authorization'
);
SELECT extensions.ok(
    NOT (
        public.search_services_v1(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 50, 0)
        #> '{data,0}' ? 'internal_notes'
    ),
    'service list contract has no internal_notes field'
);

SELECT * FROM extensions.finish();

ROLLBACK;
