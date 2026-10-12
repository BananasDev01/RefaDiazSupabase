BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(65);

INSERT INTO public.role (id, description)
VALUES
    (991001, 'ADMINISTRADOR'),
    (991002, 'EMPLEADO');

INSERT INTO public.person (id, name, last_name)
VALUES (991001, 'Empleado', 'Prueba');

INSERT INTO public."user" (id, person_id, role_id)
VALUES
    ('31111111-1111-1111-1111-111111111111', 991001, 991002),
    ('32222222-2222-2222-2222-222222222222', 991001, 991001);

INSERT INTO public.client (id, client_name, phone_number)
VALUES (991001, 'Cliente de servicio', '81 3000 1001');

INSERT INTO public.brand (id, name, brand_type_id)
SELECT 991001, 'Marca de servicio', min(id)
FROM public.brand_type;

INSERT INTO public.car_model (id, name, brand_id)
VALUES (991001, 'Modelo de servicio', 991001);

INSERT INTO public.vehicle (
    id,
    car_model_id,
    model_year,
    version,
    color,
    plate
)
VALUES (991001, 991001, 2018, 'Sport', 'Azul', 'ser-10-01');

INSERT INTO public.client_vehicle (id, client_id, vehicle_id)
VALUES (991001, 991001, 991001);

SELECT extensions.ok(
    to_regclass('public.service') IS NOT NULL,
    'service is the aggregate table name'
);
SELECT extensions.ok(
    to_regclass('public.work_order') IS NULL,
    'legacy work_order terminology was not introduced'
);
SELECT extensions.is(
    (
        SELECT start_value
        FROM pg_sequences
        WHERE schemaname = 'public'
          AND sequencename = 'service_folio_number_seq'
    ),
    5000::BIGINT,
    'official service folios start at 5000'
);
SELECT extensions.is(
    (
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'service'
          AND column_name = 'subtotal'
    ),
    'numeric',
    'service subtotal uses numeric rather than money'
);
SELECT extensions.is(
    (
        SELECT numeric_precision::INTEGER
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'service'
          AND column_name = 'subtotal'
    ),
    12,
    'service subtotal has precision 12'
);
SELECT extensions.is(
    (
        SELECT numeric_scale::INTEGER
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'service'
          AND column_name = 'subtotal'
    ),
    2,
    'service subtotal has scale 2'
);

INSERT INTO public.service (
    id,
    external_id,
    provisional_reference,
    service_date,
    client_vehicle_id,
    client_id,
    vehicle_id,
    work_manager_user_id,
    reported_failure_summary,
    authorized_work_description,
    vehicle_operation_observations,
    important_information,
    compression_leak_detected,
    cooling_system_air_pressure_detected,
    radiator_serial_number,
    radiator_obstruction_level,
    subtotal,
    tax_amount,
    total,
    warranty_months,
    client_snapshot,
    vehicle_snapshot,
    work_manager_snapshot,
    legal_text_snapshot,
    created_by_user_id,
    updated_by_user_id
)
VALUES (
    991001,
    '40000000-0000-0000-0000-000000000001',
    'PEND-SER-TEST01',
    DATE '2026-08-19',
    991001,
    991001,
    991001,
    '31111111-1111-1111-1111-111111111111',
    'Falla original',
    'Radiador autorizado',
    'El automóvil se calienta',
    'Revisar nuevamente en una semana',
    true,
    false,
    '225557',
    8,
    1000.00,
    160.00,
    1160.00,
    6,
    '{"name":"Cliente de servicio","phone":"8130001001"}',
    '{"brand":"Marca de servicio","model":"Modelo de servicio","year":2018}',
    '{"name":"Empleado Prueba"}',
    '{"version":"2026-08-19"}',
    '31111111-1111-1111-1111-111111111111',
    '31111111-1111-1111-1111-111111111111'
);

SELECT extensions.is(
    (SELECT external_id FROM public.service WHERE id = 991001),
    '40000000-0000-0000-0000-000000000001'::UUID,
    'service preserves the device-generated UUID'
);
SELECT extensions.is(
    (SELECT status FROM public.service WHERE id = 991001),
    'DRAFT',
    'service starts in draft status'
);
SELECT extensions.is(
    (SELECT version FROM public.service WHERE id = 991001),
    1,
    'service optimistic version starts at one'
);
SELECT extensions.is(
    (SELECT radiator_serial_number FROM public.service WHERE id = 991001),
    '225557',
    'external radiator label serial is captured verbatim'
);
SELECT extensions.is(
    (SELECT radiator_obstruction_level FROM public.service WHERE id = 991001),
    8::SMALLINT,
    'radiator obstruction remains a separate zero-to-ten value'
);
SELECT extensions.is(
    (SELECT tax_amount FROM public.service WHERE id = 991001),
    160.00::NUMERIC,
    'manually captured IVA is preserved'
);
SELECT extensions.ok(
    EXISTS (
        SELECT 1
        FROM public.service
        WHERE id = 991001
          AND client_vehicle_id = 991001
          AND client_id = 991001
          AND vehicle_id = 991001
    ),
    'service links a consistent client, vehicle and client-vehicle relation'
);

SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference, status,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000002', 'PEND-SER-BADSTATUS', 'UNKNOWN',
          991001, 991001, 991001, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'service rejects an unknown status'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference, warranty_months,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000003', 'PEND-SER-BADWARRANTY', 9,
          991001, 991001, 991001, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'service restricts warranty to 0, 3, 6 or 12 months'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference, radiator_obstruction_level,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000004', 'PEND-SER-BADLEVEL', 11,
          991001, 991001, 991001, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'service rejects obstruction levels above ten'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference,
          client_vehicle_id, client_id, vehicle_id,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000005', 'PEND-SER-NOTAX',
          991001, 991001, 991001,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23502', NULL, 'service requires an explicit IVA amount'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000006', 'PEND-SER-BADRELATION',
          991001, 991001, 991002, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23503', NULL, 'service rejects inconsistent customer-vehicle relations'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference, folio_number, folio_assigned_at,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000007', 'PEND-SER-BADFOLIO', 4999, now(),
          991001, 991001, 991001, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'official service folio cannot be below 5000'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference, folio_number,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000008', 'PEND-SER-NOFOLIODATE', 5000,
          991001, 991001, 991001, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'official folio assignment requires its audit timestamp'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service (
          external_id, provisional_reference,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000001', 'PEND-SER-DUPLICATEUUID',
          991001, 991001, 991001, 0,
          '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23505', NULL, 'service external UUID is idempotently unique'
);

INSERT INTO public.service_document (
    id,
    external_id,
    service_id,
    document_version,
    service_version,
    document_status,
    folio_snapshot,
    template_version,
    legal_text_version,
    document_snapshot,
    storage_object_path,
    content_sha256,
    generated_by_user_id
)
VALUES (
    991001,
    '41000000-0000-0000-0000-000000000001',
    991001,
    1,
    1,
    'PROVISIONAL',
    'PEND-SER-TEST01',
    'service-template-v1',
    'legal-v1',
    '{"reportedFailureSummary":"Falla original"}',
    'services/40000000-0000-0000-0000-000000000001/service-v1.pdf',
    repeat('a', 64),
    '31111111-1111-1111-1111-111111111111'
);

SELECT extensions.is(
    (SELECT service_version FROM public.service_document WHERE id = 991001),
    1,
    'first PDF records service version one'
);
SELECT extensions.is(
    (
        SELECT document_snapshot ->> 'reportedFailureSummary'
        FROM public.service_document
        WHERE id = 991001
    ),
    'Falla original',
    'first PDF preserves the original failure snapshot'
);

SELECT extensions.is(
    (SELECT count(*)::INTEGER FROM public.reported_failure_type),
    13,
    'physical-form failure checklist is seeded'
);
SELECT extensions.ok(
    (
        SELECT allows_free_text
        FROM public.reported_failure_type
        WHERE code = 'OTHER'
    ),
    'OTHER is the free-text checklist option'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service_reported_failure (
          external_id, service_id, reported_failure_type_id, other_text,
          created_by_user_id
      )
      SELECT
          '42000000-0000-0000-0000-000000000001', 991001, id, NULL,
          '31111111-1111-1111-1111-111111111111'
      FROM public.reported_failure_type WHERE code = 'OTHER'$$,
    '23514', NULL, 'OTHER requires free text'
);
SELECT extensions.lives_ok(
    $$INSERT INTO public.service_reported_failure (
          external_id, service_id, reported_failure_type_id, other_text,
          created_by_user_id
      )
      SELECT
          '42000000-0000-0000-0000-000000000002', 991001, id,
          'Revisar soporte especial',
          '31111111-1111-1111-1111-111111111111'
      FROM public.reported_failure_type WHERE code = 'OTHER'$$,
    'OTHER selection accepts its free text'
);
SELECT extensions.is(
    (
        SELECT label_snapshot
        FROM public.service_reported_failure
        WHERE external_id = '42000000-0000-0000-0000-000000000002'
    ),
    'Otros',
    'checklist selection preserves the historical label'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service_reported_failure (
          external_id, service_id, reported_failure_type_id, other_text,
          created_by_user_id
      )
      SELECT
          '42000000-0000-0000-0000-000000000003', 991001, id,
          'Texto indebido',
          '31111111-1111-1111-1111-111111111111'
      FROM public.reported_failure_type WHERE code = 'RADIATOR_SERVICE'$$,
    '23514', NULL, 'regular checklist options reject unrelated free text'
);
SELECT extensions.lives_ok(
    $$INSERT INTO public.service_reported_failure (
          external_id, service_id, reported_failure_type_id,
          created_by_user_id
      )
      SELECT
          '42000000-0000-0000-0000-000000000004', 991001, id,
          '31111111-1111-1111-1111-111111111111'
      FROM public.reported_failure_type WHERE code = 'RADIATOR_SERVICE'$$,
    'regular checklist selection can be captured'
);
SELECT extensions.is(
    (
        SELECT label_snapshot
        FROM public.service_reported_failure
        WHERE external_id = '42000000-0000-0000-0000-000000000004'
    ),
    'Servicio radiador',
    'regular checklist label is snapshotted'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service_reported_failure (
          external_id, service_id, reported_failure_type_id,
          created_by_user_id
      )
      SELECT
          '42000000-0000-0000-0000-000000000005', 991001, id,
          '31111111-1111-1111-1111-111111111111'
      FROM public.reported_failure_type WHERE code = 'RADIATOR_SERVICE'$$,
    '23505', NULL, 'a checklist option cannot be selected twice'
);

SELECT extensions.lives_ok(
    $$INSERT INTO public.service_internal_note (
          external_id, service_id, note,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '43000000-0000-0000-0000-000000000001', 991001,
          'Nota confidencial del taller',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    'internal note is stored separately'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service_internal_note (
          external_id, service_id, note,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '43000000-0000-0000-0000-000000000002', 991001, '',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'internal note cannot be blank'
);
SELECT extensions.ok(
    NOT (
        SELECT document_snapshot ? 'internalNotes'
        FROM public.service_document
        WHERE id = 991001
    ),
    'customer PDF snapshot excludes internal notes'
);

SELECT extensions.lives_ok(
    $$INSERT INTO public.service_signature (
          external_id, service_id, signature_type, signature_version,
          signer_name_snapshot, storage_object_path, content_sha256,
          mime_type, captured_by_user_id
      ) VALUES (
          '44000000-0000-0000-0000-000000000001', 991001,
          'WORK_MANAGER', 1, 'Empleado Prueba',
          'services/40000000-0000-0000-0000-000000000001/manager-v1.png',
          repeat('b', 64), 'image/png',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    'work manager signature metadata can be versioned'
);
SELECT extensions.lives_ok(
    $$INSERT INTO public.service_signature (
          external_id, service_id, signature_type, signature_version,
          storage_object_path, content_sha256, mime_type,
          captured_by_user_id
      ) VALUES (
          '44000000-0000-0000-0000-000000000002', 991001,
          'CUSTOMER_CONFORMITY', 1,
          'services/40000000-0000-0000-0000-000000000001/customer-v1.jpg',
          repeat('c', 64), 'image/jpeg',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    'customer conformity signature metadata can be versioned'
);
SELECT extensions.is(
    (SELECT count(*)::INTEGER FROM public.service_signature WHERE service_id = 991001),
    2,
    'the two signature types remain separate'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service_signature (
          external_id, service_id, signature_type, signature_version,
          storage_object_path, content_sha256, mime_type,
          captured_by_user_id
      ) VALUES (
          '44000000-0000-0000-0000-000000000003', 991001,
          'UNKNOWN', 1, 'services/unknown.png', repeat('d', 64), 'image/png',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'unknown signature types are rejected'
);
SELECT extensions.throws_ok(
    $$INSERT INTO public.service_signature (
          external_id, service_id, signature_type, signature_version,
          storage_object_path, content_sha256, mime_type,
          captured_by_user_id
      ) VALUES (
          '44000000-0000-0000-0000-000000000004', 991001,
          'WORK_MANAGER', 2, 'services/badhash.png', 'bad-hash', 'image/png',
          '31111111-1111-1111-1111-111111111111'
      )$$,
    '23514', NULL, 'signature requires a lowercase SHA-256 hash'
);
SELECT extensions.throws_ok(
    $$UPDATE public.service_signature
      SET signer_name_snapshot = 'Cambio'
      WHERE external_id = '44000000-0000-0000-0000-000000000001'$$,
    '22000', NULL, 'issued signature metadata is immutable'
);

SELECT extensions.lives_ok(
    $$UPDATE public.service
      SET reported_failure_summary = 'Falla actualizada'
      WHERE id = 991001 AND version = 1$$,
    'current service can be edited with an optimistic version predicate'
);
SELECT extensions.is(
    (SELECT version FROM public.service WHERE id = 991001),
    2,
    'service update increments the optimistic version'
);
SELECT extensions.is(
    (SELECT reported_failure_summary FROM public.service WHERE id = 991001),
    'Falla actualizada',
    'service keeps the current updated information'
);
SELECT extensions.throws_ok(
    $$UPDATE public.service SET version = 3 WHERE id = 991001$$,
    '22000', NULL, 'clients cannot set the optimistic version directly'
);

SELECT extensions.lives_ok(
    $$INSERT INTO public.service_document (
          external_id, service_id, document_version, service_version,
          document_status, folio_snapshot, template_version,
          legal_text_version, document_snapshot, storage_object_path,
          content_sha256, generated_by_user_id, supersedes_document_id
      ) VALUES (
          '41000000-0000-0000-0000-000000000002', 991001, 2, 2,
          'PROVISIONAL', 'PEND-SER-TEST01', 'service-template-v1',
          'legal-v1', '{"reportedFailureSummary":"Falla actualizada"}',
          'services/40000000-0000-0000-0000-000000000001/service-v2.pdf',
          repeat('d', 64), '31111111-1111-1111-1111-111111111111', 991001
      )$$,
    'reprinting current service creates a new PDF version'
);
SELECT extensions.is(
    (
        SELECT service_version
        FROM public.service_document
        WHERE service_id = 991001
        ORDER BY document_version DESC
        LIMIT 1
    ),
    2,
    'latest reprint points to the current service version'
);
SELECT extensions.is(
    (
        SELECT document_snapshot ->> 'reportedFailureSummary'
        FROM public.service_document
        WHERE id = 991001
    ),
    'Falla original',
    'older PDF remains historically unchanged after service edits'
);
SELECT extensions.throws_ok(
    $$UPDATE public.service_document
      SET template_version = 'changed'
      WHERE id = 991001$$,
    '22000', NULL, 'issued PDF metadata cannot be overwritten'
);
SELECT extensions.throws_ok(
    $$DELETE FROM public.service_document WHERE id = 991001$$,
    '22000', NULL, 'issued PDF metadata cannot be deleted'
);

SELECT extensions.is(
    (
        SELECT count(*)::INTEGER
        FROM pg_class
        WHERE oid IN (
            'public.service'::regclass,
            'public.reported_failure_type'::regclass,
            'public.service_reported_failure'::regclass,
            'public.service_internal_note'::regclass,
            'public.service_signature'::regclass,
            'public.service_document'::regclass
        )
          AND relrowsecurity
    ),
    6,
    'RLS is enabled on every service-domain table'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.service; RESET ROLE',
    '42501', NULL, 'anon cannot read services'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.reported_failure_type; RESET ROLE',
    '42501', NULL, 'anon cannot read the service checklist'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.service_reported_failure; RESET ROLE',
    '42501', NULL, 'anon cannot read reported failures'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.service_internal_note; RESET ROLE',
    '42501', NULL, 'anon cannot read confidential notes'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.service_signature; RESET ROLE',
    '42501', NULL, 'anon cannot read signatures'
);
SELECT extensions.throws_ok(
    'SET LOCAL ROLE anon; SELECT count(*) FROM public.service_document; RESET ROLE',
    '42501', NULL, 'anon cannot read PDF metadata'
);
SELECT extensions.ok(
    NOT (SELECT public FROM storage.buckets WHERE id = 'service-documents'),
    'service document bucket is private'
);
SELECT extensions.ok(
    NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND 'anon' = ANY(roles)
          AND coalesce(qual, with_check, '') LIKE '%service-documents%'
    ),
    'service document bucket has no anonymous policy'
);

SELECT set_config(
    'request.jwt.claim.sub',
    '31111111-1111-1111-1111-111111111111',
    true
);
SET LOCAL ROLE authenticated;
SELECT extensions.is(
    (SELECT count(*)::INTEGER FROM public.service WHERE id = 991001),
    1,
    'authenticated employee can read services through RLS'
);
SELECT extensions.is(
    (SELECT count(*)::INTEGER FROM public.service_internal_note WHERE service_id = 991001),
    1,
    'authenticated employee can read staff-only internal notes'
);
RESET ROLE;
SELECT extensions.throws_ok(
    $$SET LOCAL ROLE authenticated;
      INSERT INTO public.service (
          external_id, provisional_reference,
          client_vehicle_id, client_id, vehicle_id, tax_amount,
          client_snapshot, vehicle_snapshot,
          created_by_user_id, updated_by_user_id
      ) VALUES (
          '40000000-0000-0000-0000-000000000099', 'PEND-SER-DIRECT',
          991001, 991001, 991001, 0, '{}', '{}',
          '31111111-1111-1111-1111-111111111111',
          '31111111-1111-1111-1111-111111111111'
      );
      RESET ROLE$$,
    '42501', NULL, 'authenticated users cannot bypass the future aggregate RPC'
);
SELECT extensions.ok(
    NOT has_sequence_privilege(
        'authenticated',
        'public.service_folio_number_seq',
        'USAGE'
    ),
    'authenticated clients cannot allocate official folios directly'
);
SELECT extensions.ok(
    EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'service_document'
          AND indexname = 'service_document_service_id_idx'
    ),
    'PDF history has a latest-version lookup index'
);
SELECT extensions.ok(
    EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'service'
          AND indexname = 'service_status_date_idx'
    ),
    'service status and date search has an index'
);

SELECT * FROM extensions.finish();

ROLLBACK;
