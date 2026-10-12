BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(4);

CREATE OR REPLACE FUNCTION pg_temp.explain_query(query TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    plan_line TEXT;
    complete_plan TEXT := '';
BEGIN
    FOR plan_line IN EXECUTE 'EXPLAIN (COSTS OFF) ' || query LOOP
        complete_plan := complete_plan || plan_line || E'\n';
    END LOOP;
    RETURN complete_plan;
END;
$$;

INSERT INTO public.client (id, client_name, phone_number)
VALUES (990101, 'Cliente para plan', '81 2000 0101');

INSERT INTO public.brand (id, name, brand_type_id)
SELECT 990101, 'Marca para plan', min(id)
FROM public.brand_type;

INSERT INTO public.car_model (id, name, brand_id)
VALUES (990101, 'Modelo para plan', 990101);

INSERT INTO public.product (id, name, product_type_id)
SELECT 990101, 'Producto para plan', min(id)
FROM public.product_type;

INSERT INTO public.product_car_model (
    product_id,
    car_model_id,
    initial_year,
    last_year
)
VALUES (990101, 990101, 2010, 2020);

INSERT INTO public.vehicle (id, car_model_id, model_year, plate)
VALUES (990101, 990101, 2015, 'plan-0101');

SET LOCAL enable_seqscan = off;

SELECT extensions.ok(
    pg_temp.explain_query(
        $$SELECT id FROM public.client
          WHERE phone_normalized = '+528120000101'$$
    ) LIKE '%client_phone_normalized_unique%',
    'normalized phone lookup can use its unique index'
);
SELECT extensions.ok(
    pg_temp.explain_query(
        $$SELECT id FROM public.vehicle
          WHERE plate_normalized = 'PLAN0101'$$
    ) LIKE '%vehicle_plate_normalized_idx%',
    'normalized plate lookup can use its search index'
);
SELECT extensions.ok(
    pg_temp.explain_query(
        $$SELECT product_id FROM public.product_car_model
          WHERE active IS TRUE
            AND car_model_id = 990101
            AND (initial_year IS NULL OR initial_year <= 2015)
            AND (last_year IS NULL OR last_year >= 2015)$$
    ) LIKE '%product_car_model_compatibility_lookup_idx%',
    'model-year compatibility lookup can use its composite index'
);
SELECT extensions.ok(
    pg_temp.explain_query(
        $$SELECT car_model_id FROM public.product_car_model
          WHERE active IS TRUE AND product_id = 990101$$
    ) LIKE '%product_car_model_product_lookup_idx%',
    'product compatibility expansion can use its product index'
);

SELECT * FROM extensions.finish();

ROLLBACK;
