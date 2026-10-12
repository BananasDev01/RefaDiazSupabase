-- Reuse immutable document metadata and its private bucket. No signature is
-- extracted or asserted as verified: these are scans of complete signed sheets.
ALTER TABLE public.service_document
  ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'GENERATED_PDF'
    CHECK (document_kind IN ('GENERATED_PDF', 'SIGNED_SCAN')),
  ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/pdf'
    CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  ADD COLUMN byte_size BIGINT CHECK (byte_size > 0 AND byte_size <= 10485760);

CREATE TABLE public.service_upload_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  service_id BIGINT NOT NULL REFERENCES public.service(id),
  service_version INTEGER NOT NULL,
  document_snapshot JSONB NOT NULL,
  created_by_user_id VARCHAR(500) NOT NULL REFERENCES public."user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  state TEXT NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','UPLOADING','COMPLETED','REVOKED')),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  document_id BIGINT REFERENCES public.service_document(id)
);
CREATE INDEX service_upload_session_service_idx ON public.service_upload_session(service_id, created_at DESC);
ALTER TABLE public.service_upload_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_upload_session FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.service_upload_session TO service_role;

CREATE FUNCTION public.create_service_upload_session_v1(p_external_id UUID, p_expected_version INTEGER, p_token_hash TEXT, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.service%ROWTYPE; u public.service_upload_session%ROWTYPE;
BEGIN
  PERFORM public.assert_staff_actor_v1(p_actor);
  SELECT * INTO s FROM public.service WHERE external_id = p_external_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF s.version <> p_expected_version THEN RAISE EXCEPTION 'SERVICE_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*) FROM public.service_upload_session WHERE created_by_user_id=p_actor AND expires_at>now() AND state IN ('READY','UPLOADING')) >= 20 THEN
    RAISE EXCEPTION 'SERVICE_UPLOAD_TOO_MANY_SESSIONS' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.service_upload_session(token_hash, service_id, service_version, document_snapshot, created_by_user_id)
    VALUES(p_token_hash, s.id, s.version, public.service_public_json_v1(s.id), p_actor) RETURNING * INTO u;
  RETURN jsonb_build_object('id',u.id,'expiresAt',u.expires_at,'serviceVersion',u.service_version);
END; $$;

CREATE FUNCTION public.claim_service_upload_v1(p_token_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.service_upload_session%ROWTYPE; d public.service_document%ROWTYPE;
BEGIN
  SELECT * INTO u FROM public.service_upload_session WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR u.expires_at<=now() OR u.state='REVOKED' THEN
    RAISE EXCEPTION 'SERVICE_UPLOAD_EXPIRED' USING ERRCODE='22023';
  END IF;
  IF u.state='COMPLETED' THEN
    SELECT * INTO d FROM public.service_document WHERE id=u.document_id;
    RETURN jsonb_build_object('completed',true,'documentId',d.external_id,'sha256',d.content_sha256);
  END IF;
  IF u.state='UPLOADING' AND u.lease_until>now() THEN RAISE EXCEPTION 'SERVICE_UPLOAD_BUSY' USING ERRCODE='40001'; END IF;
  IF u.attempts>=10 THEN RAISE EXCEPTION 'SERVICE_UPLOAD_ATTEMPTS_EXCEEDED' USING ERRCODE='22023'; END IF;
  UPDATE public.service_upload_session SET state='UPLOADING',lease_id=gen_random_uuid(),lease_until=now()+interval '90 seconds',attempts=attempts+1
    WHERE id=u.id RETURNING * INTO u;
  RETURN jsonb_build_object('id',u.id,'leaseId',u.lease_id,'path',u.service_id::TEXT||'/'||u.id::TEXT||'/'||u.lease_id::TEXT);
END; $$;

CREATE FUNCTION public.finish_service_upload_v1(p_token_hash TEXT, p_lease_id UUID, p_path TEXT, p_mime TEXT, p_size BIGINT, p_sha256 TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.service_upload_session%ROWTYPE; d public.service_document%ROWTYPE; v INTEGER;
BEGIN
  SELECT * INTO u FROM public.service_upload_session WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR u.state<>'UPLOADING' OR u.lease_id IS DISTINCT FROM p_lease_id OR u.expires_at<=now() OR u.lease_until<=now() THEN
    RAISE EXCEPTION 'SERVICE_UPLOAD_EXPIRED' USING ERRCODE='22023';
  END IF;
  IF p_path IS DISTINCT FROM u.service_id::TEXT||'/'||u.id::TEXT||'/'||u.lease_id::TEXT THEN
    RAISE EXCEPTION 'SERVICE_UPLOAD_PATH_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.service WHERE id=u.service_id FOR UPDATE;
  SELECT coalesce(max(document_version),0)+1 INTO v FROM public.service_document WHERE service_id=u.service_id;
  INSERT INTO public.service_document(external_id,service_id,document_version,service_version,document_status,
    folio_snapshot,template_version,legal_text_version,document_snapshot,storage_object_path,content_sha256,
    generated_by_user_id,document_kind,mime_type,byte_size)
  VALUES(gen_random_uuid(),u.service_id,v,u.service_version,
    CASE WHEN u.document_snapshot->>'status'='DRAFT' THEN 'PROVISIONAL' ELSE 'OFFICIAL' END,
    coalesce(u.document_snapshot->>'folio_number',u.document_snapshot->>'provisional_reference'),
    'signed-sheet-2026-09-28','snapshot',u.document_snapshot,p_path,p_sha256,u.created_by_user_id,'SIGNED_SCAN',p_mime,p_size)
  RETURNING * INTO d;
  UPDATE public.service_upload_session SET state='COMPLETED',document_id=d.id,lease_until=NULL WHERE id=u.id;
  RETURN jsonb_build_object('documentId',d.external_id,'serviceVersion',d.service_version);
END; $$;

REVOKE ALL ON FUNCTION public.create_service_upload_session_v1(UUID,INTEGER,TEXT,TEXT), public.claim_service_upload_v1(TEXT), public.finish_service_upload_v1(TEXT,UUID,TEXT,TEXT,BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_upload_session_v1(UUID,INTEGER,TEXT,TEXT), public.claim_service_upload_v1(TEXT), public.finish_service_upload_v1(TEXT,UUID,TEXT,TEXT,BIGINT,TEXT) TO service_role;
