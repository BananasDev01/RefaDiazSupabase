BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(43);

SELECT extensions.is(
    public.normalize_phone_v1('(81) 1234-5678'),
    '+528112345678',
    'Mexican local phones are normalized to E.164'
);
SELECT extensions.is(
    public.normalize_phone_v1('+52 1 81 1234 5678'),
    '+528112345678',
    'legacy Mexican mobile prefixes are normalized'
);
SELECT extensions.is(
    public.normalize_phone_v1('+1 (210) 555-0100'),
    '+12105550100',
    'explicit international phone numbers keep their country code'
);
SELECT extensions.is(
    public.normalize_phone_v1('not-a-phone'),
    NULL::TEXT,
    'invalid phone numbers cannot be normalized'
);

INSERT INTO public.client (id, client_name, phone_number)
VALUES (990001, 'Cliente de prueba', '81 1234 5678');

SELECT extensions.ok(
    (SELECT external_id IS NOT NULL FROM public.client WHERE id = 990001),
    'clients receive an offline external UUID'
);
SELECT extensions.is(
    (SELECT phone_normalized FROM public.client WHERE id = 990001),
    '+528112345678',
    'the normalized phone is stored as the business matching key'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.client (client_name, phone_number)
      VALUES ('Duplicado', '+52 81 1234 5678')$$,
    '23505',
    NULL,
    'alternate formatting cannot create a duplicate normalized phone'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.client (client_name, phone_number)
      VALUES ('', '81 0000 0001')$$,
    '23514',
    NULL,
    'client name cannot be blank'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.client (client_name, phone_number)
      VALUES ('Telefono invalido', 'sin telefono')$$,
    '23502',
    NULL,
    'client phone must be normalizable'
);

INSERT INTO public.brand (id, name, brand_type_id)
SELECT 990001, 'Marca de prueba', min(id)
FROM public.brand_type;

INSERT INTO public.car_model (id, name, brand_id)
VALUES (990001, 'Modelo de prueba', 990001);

INSERT INTO public.product (id, name, product_type_id)
SELECT 990001, 'Producto compatible de prueba', min(id)
FROM public.product_type;

INSERT INTO public.product (id, name, product_type_id)
SELECT 990002, 'Producto con compatibilidad abierta', min(id)
FROM public.product_type;

INSERT INTO public.product_car_model (
    product_id,
    car_model_id,
    initial_year,
    last_year
)
VALUES (990001, 990001, 2010, 2020);

INSERT INTO public.product_car_model (
    product_id,
    car_model_id,
    initial_year,
    last_year
)
VALUES (990002, 990001, NULL, 2012);

INSERT INTO public.vehicle (
    id,
    car_model_id,
    model_year,
    version,
    color,
    plate
)
VALUES (990001, 990001, 2015, 'Sport', 'Rojo', 'abc-12-34');

SELECT extensions.ok(
    (SELECT external_id IS NOT NULL FROM public.vehicle WHERE id = 990001),
    'vehicles receive an offline external UUID'
);
SELECT extensions.is(
    (SELECT model_year FROM public.vehicle WHERE id = 990001),
    2015::SMALLINT,
    'vehicle stores its actual model year'
);
SELECT extensions.is(
    (SELECT plate_normalized FROM public.vehicle WHERE id = 990001),
    'ABC1234',
    'vehicle plate is normalized for lookup'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.vehicle (car_model_id, model_year)
      VALUES (990001, 1800)$$,
    '23514',
    NULL,
    'vehicle rejects an impossible model year'
);

INSERT INTO public.client_vehicle (client_id, vehicle_id)
VALUES (990001, 990001);

SELECT extensions.ok(
    (
        SELECT id IS NOT NULL
        FROM public.client_vehicle
        WHERE client_id = 990001 AND vehicle_id = 990001
    ),
    'client-vehicle relationships receive a stable primary key'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.client_vehicle (client_id, vehicle_id)
      VALUES (990001, 990001)$$,
    '23505',
    NULL,
    'the same vehicle cannot be linked twice to the same client'
);
SELECT extensions.is(
    (
        SELECT count(*)::INTEGER
        FROM public.vehicle AS vehicle
        JOIN public.product_car_model AS compatibility
          ON compatibility.car_model_id = vehicle.car_model_id
        WHERE vehicle.id = 990001
          AND vehicle.model_year >= compatibility.initial_year
          AND vehicle.model_year <= compatibility.last_year
    ),
    1,
    'product compatibility can be matched against the actual vehicle year'
);
SELECT extensions.ok(
    (
        SELECT vehicle.model_year <> compatibility.initial_year
        FROM public.vehicle AS vehicle
        JOIN public.product_car_model AS compatibility
          ON compatibility.car_model_id = vehicle.car_model_id
        WHERE vehicle.id = 990001
          AND compatibility.product_id = 990001
    ),
    'vehicle year remains distinct from the compatibility range'
);
SELECT extensions.is(
    (
        SELECT count(*)::INTEGER
        FROM public.search_product_ids_v1(
            (SELECT product_type_id FROM public.product WHERE id = 990001),
            p_model_id => 990001,
            p_model_year => 2015
        )
        WHERE product_id = 990001
    ),
    1,
    'the product search RPC includes a product inside its model-year range'
);
SELECT extensions.is(
    (
        SELECT count(*)::INTEGER
        FROM public.search_product_ids_v1(
            (SELECT product_type_id FROM public.product WHERE id = 990001),
            p_model_id => 990001,
            p_model_year => 2009
        )
        WHERE product_id = 990001
    ),
    0,
    'the product search RPC excludes a product outside its model-year range'
);
SELECT extensions.is(
    (
        SELECT count(*)::INTEGER
        FROM public.search_product_ids_v1(
            (SELECT product_type_id FROM public.product WHERE id = 990001),
            p_model_id => 990001,
            p_model_year => 2011
        )
        WHERE product_id IN (990001, 990002)
    ),
    2,
    'the product search RPC preserves open-ended compatibility ranges'
);

SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.client; RESET ROLE',
    '42501', NULL, 'anon cannot read clients'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.vehicle; RESET ROLE',
    '42501', NULL, 'anon cannot read vehicles'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.client_vehicle; RESET ROLE',
    '42501', NULL, 'anon cannot read client-vehicle links'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.person; RESET ROLE',
    '42501', NULL, 'anon cannot read people'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public."user"; RESET ROLE',
    '42501', NULL, 'anon cannot read application users'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.role; RESET ROLE',
    '42501', NULL, 'anon cannot read application roles'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.control_fields; RESET ROLE',
    '42501', NULL, 'anon cannot operate on the inherited control table'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT public.is_app_staff(); RESET ROLE',
    '42501', NULL, 'anon cannot execute authorization helpers'
);
SELECT extensions.is(
    (
        SELECT count(*)::INTEGER
        FROM pg_class
        WHERE oid IN (
            'public.control_fields'::regclass,
            'public.client'::regclass,
            'public.vehicle'::regclass,
            'public.client_vehicle'::regclass,
            'public.person'::regclass,
            'public.user'::regclass,
            'public.role'::regclass
        )
          AND relrowsecurity
    ),
    7,
    'RLS is enabled on all personal-data tables in scope'
);

INSERT INTO public.role (id, description)
VALUES
    (990001, 'ADMINISTRADOR'),
    (990002, 'EMPLEADO');

INSERT INTO public.person (id, name, last_name)
VALUES (990001, 'Persona', 'Prueba');

INSERT INTO public."user" (id, person_id, role_id)
VALUES
    ('11111111-1111-1111-1111-111111111111', 990001, 990002),
    ('22222222-2222-2222-2222-222222222222', 990001, 990001);

SELECT set_config(
    'request.jwt.claim.sub',
    '11111111-1111-1111-1111-111111111111',
    true
);
SELECT extensions.is(
    public.current_app_role(),
    'EMPLEADO',
    'active employee identity resolves from the JWT subject'
);
SELECT extensions.ok(public.is_app_staff(), 'employee is recognized as staff');
SELECT extensions.ok(NOT public.is_app_admin(), 'employee is not recognized as admin');
SELECT extensions.lives_ok(
    'SET LOCAL ROLE authenticated; SELECT count(*) FROM public.client; RESET ROLE',
    'authenticated staff can read clients through RLS'
);
SELECT extensions.lives_ok(
    'SET LOCAL ROLE authenticated; SELECT count(*) FROM public.person; RESET ROLE',
    'authenticated staff can read people through RLS'
);
SET LOCAL ROLE authenticated;
SELECT extensions.is(
    (SELECT count(*)::INTEGER FROM public."user"),
    0,
    'employees cannot read application users through RLS'
);
RESET ROLE;

SELECT set_config(
    'request.jwt.claim.sub',
    '22222222-2222-2222-2222-222222222222',
    true
);
SELECT extensions.is(
    public.current_app_role(),
    'ADMINISTRADOR',
    'active administrator identity resolves from the JWT subject'
);
SELECT extensions.ok(public.is_app_admin(), 'administrator is recognized as admin');
SELECT extensions.throws_ok(
    $$SET LOCAL ROLE authenticated;
      UPDATE public.person SET name = 'Cambio directo' WHERE id = 990001;
      RESET ROLE$$,
    '42501',
    NULL,
    'administrator PII writes remain behind the validated Edge API'
);

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT extensions.ok(
    NOT public.is_app_staff(),
    'a request without an authenticated application user is not staff'
);
SELECT extensions.ok(
    NOT has_table_privilege('authenticated', 'public.client', 'DELETE'),
    'authenticated clients cannot delete customer records directly'
);
SELECT extensions.ok(
    EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.client'::regclass
          AND conname = 'client_phone_normalized_unique'
    ),
    'normalized customer phone has a uniqueness constraint'
);
SELECT extensions.ok(
    EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'vehicle'
          AND indexname = 'vehicle_plate_normalized_idx'
    ),
    'normalized vehicle plate has a lookup index'
);
SELECT extensions.ok(
    EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.client_vehicle'::regclass
          AND conname = 'client_vehicle_pkey'
          AND contype = 'p'
    ),
    'client-vehicle relationship has a primary key'
);

SELECT * FROM extensions.finish();

ROLLBACK;
