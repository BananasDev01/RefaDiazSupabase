# Client and Vehicle Migration Runbook

Date: 2026-08-19

Scope: `20260819120000_adapt_clients_and_vehicles.sql` and
`20260819121000_secure_personal_data.sql`.

## Release strategy

These migrations use a **forward corrective** strategy. A destructive down
migration is intentionally not provided: after production starts accepting
offline UUIDs, normalized phones, actual vehicle years, and stable
client-vehicle identifiers, dropping those fields would lose business identity
and could orphan future services.

Before applying the release:

1. Take a database backup and record the current migration version.
2. Run the customer preflight queries below against production.
3. Reconcile invalid or duplicate customers manually; do not merge them in SQL
   without business review.
4. Deploy the schema and role-validation Edge Functions in the same release
   boundary so personal data is never exposed between steps.
5. Run the smoke and negative-access tests before enabling client capture.

If a defect is found after deployment, stop new writes and publish a new
timestamped corrective migration. Corrections may relax a constraint, repair
an index or policy, or backfill a value, but must preserve `id`, `external_id`,
`phone_normalized`, vehicle identity, and already-issued document references.
Restore from backup only if the migration fails before the application is
reopened and no post-migration writes exist.

## Production preflight

```sql
WITH normalized_clients AS (
    SELECT
        id,
        client_name,
        phone_number,
        regexp_replace(phone_number, '[^0-9]', '', 'g') AS phone_digits
    FROM public.client
)
SELECT id, client_name, phone_number
FROM normalized_clients
WHERE client_name IS NULL
   OR btrim(client_name) = ''
   OR NOT (
       phone_digits ~ '^(521?[0-9]{10}|[0-9]{10})$'
       OR (
           left(btrim(phone_number), 1) = '+'
           AND phone_digits ~ '^[1-9][0-9]{7,14}$'
       )
   );

WITH normalized_clients AS (
    SELECT
        id,
        CASE
            WHEN regexp_replace(phone_number, '[^0-9]', '', 'g') ~ '^[0-9]{10}$'
                THEN '+52' || regexp_replace(phone_number, '[^0-9]', '', 'g')
            WHEN regexp_replace(phone_number, '[^0-9]', '', 'g') ~ '^52[0-9]{10}$'
                THEN '+' || regexp_replace(phone_number, '[^0-9]', '', 'g')
            WHEN regexp_replace(phone_number, '[^0-9]', '', 'g') ~ '^521[0-9]{10}$'
                THEN '+52' || substring(
                    regexp_replace(phone_number, '[^0-9]', '', 'g') FROM 4
                )
            WHEN left(btrim(phone_number), 1) = '+'
                 AND regexp_replace(phone_number, '[^0-9]', '', 'g')
                     ~ '^[1-9][0-9]{7,14}$'
                THEN '+' || regexp_replace(phone_number, '[^0-9]', '', 'g')
        END AS phone_normalized
    FROM public.client
)
SELECT phone_normalized, array_agg(id ORDER BY id) AS client_ids
FROM normalized_clients
WHERE phone_normalized IS NOT NULL
GROUP BY phone_normalized
HAVING count(*) > 1;

SELECT vehicle_id,
       array_agg(DISTINCT NULLIF(btrim(color), '')) AS colors,
       array_agg(DISTINCT NULLIF(
           upper(regexp_replace(btrim(plate), '[^A-Za-z0-9]', '', 'g')),
           ''
       )) AS plates
FROM public.client_vehicle
GROUP BY vehicle_id
HAVING count(DISTINCT NULLIF(btrim(color), '')) > 1
    OR count(DISTINCT NULLIF(
        upper(regexp_replace(btrim(plate), '[^A-Za-z0-9]', '', 'g')),
        ''
    )) > 1;
```

The migration repeats these checks and stops with an actionable exception when
unsafe data is detected.

## Compatibility rule

`vehicle.model_year` stores the actual year of a customer's vehicle. Product
compatibility remains in `product_car_model.initial_year` and `last_year`.
Null compatibility bounds are open-ended:

```sql
SELECT product_id
FROM public.product_car_model
WHERE active IS TRUE
  AND car_model_id = :car_model_id
  AND (initial_year IS NULL OR initial_year <= :model_year)
  AND (last_year IS NULL OR last_year >= :model_year);
```

The migration adds separate indexes for lookup by product and for lookup by
model/year. The database tests force index-eligible plans with sequential scans
disabled and assert the exact index names. This demonstrates that the planner
can use them; production may still choose a sequential scan for very small
tables because it is cheaper.

## Local verification

Run from `supabase/`:

```sh
supabase db reset --local --no-seed --yes
supabase test db
supabase db lint --local --level warning
cd functions/products && deno task test
```

`--no-seed` is currently required because the historical `seed.sql` references
`storage.prefixes`, which is absent from the configured local Storage schema.
That unrelated seed drift should be repaired separately.
