INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'service-documents',
    'service-documents',
    false,
    10485760,
    ARRAY['application/pdf', 'image/png', 'image/jpeg']::TEXT[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.service ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reported_failure_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_reported_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_internal_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_signature ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_document ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
    public.service,
    public.reported_failure_type,
    public.service_reported_failure,
    public.service_internal_note,
    public.service_signature,
    public.service_document
FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON SEQUENCE
    public.service_id_seq,
    public.service_folio_number_seq,
    public.reported_failure_type_id_seq,
    public.service_reported_failure_id_seq,
    public.service_internal_note_id_seq,
    public.service_signature_id_seq,
    public.service_document_id_seq
FROM anon, authenticated;

GRANT SELECT ON TABLE
    public.service,
    public.reported_failure_type,
    public.service_reported_failure,
    public.service_internal_note,
    public.service_signature,
    public.service_document
TO authenticated;

DROP POLICY IF EXISTS service_staff_select ON public.service;
CREATE POLICY service_staff_select
ON public.service
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS reported_failure_type_staff_select
ON public.reported_failure_type;
CREATE POLICY reported_failure_type_staff_select
ON public.reported_failure_type
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS service_reported_failure_staff_select
ON public.service_reported_failure;
CREATE POLICY service_reported_failure_staff_select
ON public.service_reported_failure
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS service_internal_note_staff_select
ON public.service_internal_note;
CREATE POLICY service_internal_note_staff_select
ON public.service_internal_note
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS service_signature_staff_select
ON public.service_signature;
CREATE POLICY service_signature_staff_select
ON public.service_signature
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS service_document_staff_select
ON public.service_document;
CREATE POLICY service_document_staff_select
ON public.service_document
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS service_documents_staff_read ON storage.objects;
CREATE POLICY service_documents_staff_read
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'service-documents'
    AND public.is_app_staff()
);

DROP POLICY IF EXISTS service_documents_staff_insert ON storage.objects;
CREATE POLICY service_documents_staff_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'service-documents'
    AND public.is_app_staff()
);
