# Service Modules Remote Audit

Audit date: 2026-08-19

Project: `RefaDiazApp` (`lgebdhuewexxbvzeohkz`)

Scope: read-only comparison of the linked Supabase project against the schema, migrations, Edge Functions, and Storage configuration versioned in this repository.

## Domain terminology

The customer-facing aggregate previously described as a work order will be named **service**. A service represents the repair or workshop work performed for a customer and vehicle. New schema and API names should use `service`; `work_order` or "order" should only appear when referring to superseded planning material.

## Executive result

- The remote project is healthy and runs PostgreSQL `15.8.1.102`, consistent with the repository's PostgreSQL 15 configuration.
- All 35 local migration versions are registered remotely, with no missing or remote-only migration versions.
- The effective public schema confirms the expected legacy shape of `client`, `vehicle`, and `client_vehicle`.
- No service, quotation, folio, signature, offline identity, or idempotency tables exist remotely.
- There is no customer/vehicle data to backfill: `client`, `vehicle`, and `client_vehicle` each contain zero rows.
- The principal blocker is security: every table in the exposed `public` schema has RLS disabled and broad privileges remain granted to `anon`.
- There is operational drift outside migration history: `vehicle-notes` policies exist, but the `vehicle-notes` bucket and Edge Function are absent remotely.

## Migration history

`supabase migration list --linked` reports exact local/remote alignment from:

- `20250211060538_create_user_function.sql`
- through `20260423131000_drop_legacy_product_search_ids_rpc.sql`

This confirms migration ledger alignment. It does not by itself prove that no manual DDL or deployment changes occurred, so the effective catalogs were inspected separately.

## Effective schema relevant to the new modules

### Customers and vehicles

Remote state confirms:

- `client`
  - Integer sequence-backed `id` primary key.
  - `client_name`, `phone_number`, and `comments` only.
  - No `external_id`, normalized phone, uniqueness constraint, or phone index.
- `vehicle`
  - Integer sequence-backed `id` primary key.
  - `car_model_id` and `version` only.
  - No `external_id` or real vehicle `model_year`.
- `client_vehicle`
  - `client_id`, `vehicle_id`, `color`, `plate`, and `comments`.
  - Foreign keys exist, but there is no primary key, unique constraint, plate normalization, or supporting index.

Current row counts:

| Relation | Rows |
| --- | ---: |
| `client` | 0 |
| `vehicle` | 0 |
| `client_vehicle` | 0 |
| `person` | 10 |
| `user` | 10 |

The empty customer/vehicle tables make an incremental structural migration low-risk. Existing `person` and `user` rows mean authorization changes require compatibility testing.

### Product compatibility

- `product_car_model` contains 117 rows.
- It continues to model catalog compatibility with `initial_year` and `last_year`; it does not represent a customer's actual vehicle year.
- The deployed `search_product_ids_v1` treats a null compatibility bound as open-ended:
  - `initial_year IS NULL OR initial_year <= p_model_year`
  - `last_year IS NULL OR last_year >= p_model_year`

A future compatible-product query can therefore compare `vehicle.model_year` against the existing range semantics without copying compatibility years into `vehicle`.

### Services and quotations

No remote object exists for:

- services or service items;
- quotations, options, or quotation items;
- folio allocation;
- signatures;
- PDF versions or immutable snapshots;
- offline `external_id` values or idempotency keys.

### File metadata

`file` contains 208 rows. Its `object_id` is polymorphic and has no foreign key to an owning entity; only `file_type_id` has referential integrity. It should not be extended for private service signatures or versioned PDFs without an explicit ownership model.

## Security findings

### Public schema

Catalog inspection and the Supabase security advisor confirm:

- RLS is disabled on all 22 tables in `public`.
- `anon` has broad table and sequence privileges, including on `client`, `client_vehicle`, `vehicle`, `person`, `user`, and `file`.
- Read-only REST probes using the anonymous key returned `200` and exposed exact counts for all inspected relations, including all 10 `person` and 10 `user` rows.

This must be corrected before customer PII is inserted.

### RPC functions

The following remotely deployed functions are executable by `anon`, `authenticated`, and `service_role`:

- `create_product_with_relations` — `SECURITY DEFINER`, mutable `search_path`.
- `update_product_with_relations` — `SECURITY DEFINER`, mutable `search_path`.
- `search_product_ids_v1` — `SECURITY DEFINER`, fixed `search_path=public`.
- `create_user_with_person` — invoker security, mutable `search_path`.

The Supabase security advisor reports the anonymous and authenticated execution of the three `SECURITY DEFINER` functions as warnings. The create/update functions need explicit `search_path` hardening and execute grants must be reviewed.

### Edge Functions

Eight Edge Functions are active remotely:

- `brands`
- `files`
- `models`
- `persons`
- `product-categories`
- `products`
- `providers`
- `users`

All have platform `verify_jwt=true`, but their versioned code creates a Supabase client with `SUPABASE_SERVICE_ROLE_KEY` and does not explicitly resolve the caller or enforce an application role. A valid JWT is therefore not sufficient authorization for future PII or service endpoints.

`vehicle-notes` exists in the repository but is not deployed remotely.

## Storage findings

Remote buckets:

| Bucket | Public |
| --- | --- |
| `application` | yes |
| `brands` | yes |
| `products` | yes |
| `car-models` | no |
| `providers` | no |
| `radiators` | no |

Additional observations:

- No bucket has a bucket-level file-size or MIME-type allowlist.
- Storage RLS is enabled on `storage.buckets` and `storage.objects`.
- Public-read object policies exist for every current catalog bucket, including buckets whose `public` flag is false.
- Authenticated users can insert, update, and delete objects in those buckets without an application-role or ownership predicate.
- Policies exist for `vehicle-notes`, but the bucket itself does not exist.
- No private bucket or ownership policy exists for service signatures, service PDFs, or quotation PDFs.

## Other advisor findings

The Supabase security advisor also reports:

- `product_effective_compatibility_v1` as a security-definer view.
- leaked-password protection disabled in Auth.
- available PostgreSQL security patches for the current `15.8.1.102` build.

These are not blockers for designing the new schema, but they belong in the security remediation plan before production rollout.

## Drift classification

| Area | Result |
| --- | --- |
| Migration ledger | Aligned |
| Effective customer/vehicle schema | Matches versioned legacy schema |
| Service/quotation schema | Absent locally and remotely, as expected |
| Table RLS and grants | Insecure locally and remotely |
| Edge Function deployment | Drift: `vehicle-notes` missing remotely |
| Storage deployment | Drift: `vehicle-notes` policies exist but bucket is missing |
| Private service/PDF storage | Not implemented |

## Recommended next action

Proceed with the customer/vehicle foundation as two coordinated migrations:

1. Add offline-safe identity and data integrity to `client`, `vehicle`, and `client_vehicle`, including `external_id`, `phone_normalized`, `model_year`, normalized plate, keys, constraints, and indexes.
2. In the same release boundary, close PII access by enabling RLS, revoking anonymous mutation/read access to private relations, defining role-aware policies, and adding explicit caller/role validation for service-role Edge Functions.

The exact policy matrix and folio strategy still require product decisions before service creation APIs are implemented.

## Audit limitations

- No data values or private file contents were extracted; only metadata and aggregate counts were inspected.
- An automated shadow-database diff could not complete because a required Docker image layer stalled during download. Migration-ledger comparison, a remote schema dump, direct PostgreSQL catalog queries, REST permission probes, Storage API metadata, Edge Function metadata, and Supabase security advisors were used instead.
- Remote Edge Function source bundles were not downloaded, so deployment metadata confirms presence and JWT configuration but not byte-for-byte parity with the repository.
