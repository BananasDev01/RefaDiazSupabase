-- All fixture data is rolled back. Does not reset existing data.
BEGIN;
INSERT INTO public.role(id,description) VALUES(995601,'EMPLEADO');
INSERT INTO public.person(id,name,last_name) VALUES(995601,'Prueba','Documentos');
INSERT INTO public."user"(id,person_id,role_id) VALUES('95611111-1111-4111-8111-111111111111',995601,995601);
INSERT INTO public.brand(id,name,brand_type_id) SELECT 995601,'Prueba documentos',min(id) FROM public.brand_type;
INSERT INTO public.car_model(id,name,brand_id) VALUES(995601,'Prueba',995601);
DO $test$
DECLARE actor TEXT:='95611111-1111-4111-8111-111111111111'; vehicle_link BIGINT; other_id INTEGER; standard_id INTEGER;
  payload JSONB; result JSONB; rows_value JSONB; session JSONB; claim JSONB; finished JSONB; hash TEXT:=repeat('a',64); first_uuid UUID:=gen_random_uuid();
BEGIN
  PERFORM public.save_client_with_vehicles_v1(jsonb_build_object('external_id',gen_random_uuid(),'client_name','Prueba documentos','phone_number','8199560101',
    'vehicles',jsonb_build_array(jsonb_build_object('external_id','95600000-0000-4000-8000-000000000002','car_model_id',995601,'model_year',2020))),actor);
  SELECT cv.id INTO STRICT vehicle_link FROM public.client_vehicle cv JOIN public.vehicle v ON v.id=cv.vehicle_id WHERE v.external_id='95600000-0000-4000-8000-000000000002';
  SELECT id INTO other_id FROM public.reported_failure_type WHERE code='OTHER';
  SELECT id INTO standard_id FROM public.reported_failure_type WHERE code='RADIATOR_SERVICE';
  rows_value:=jsonb_build_array(
    jsonb_build_object('external_id',first_uuid,'reported_failure_type_id',other_id,'amount',100,'observation','Uno'),
    jsonb_build_object('external_id',gen_random_uuid(),'reported_failure_type_id',other_id,'amount',200,'observation','Dos'),
    jsonb_build_object('external_id',gen_random_uuid(),'reported_failure_type_id',other_id,'amount',300,'observation','Tres'));
  payload:=jsonb_build_object('external_id',gen_random_uuid(),'client_vehicle_id',vehicle_link,'tax_amount',0,'line_totals_mode','LINES','reported_failures',rows_value);
  result:=public.create_service_v1(payload,actor);
  ASSERT jsonb_array_length(result->'reported_failures')=3;
  ASSERT (result->>'subtotal')::NUMERIC=600;
  ASSERT result#>>'{reported_failures,0,external_id}'=first_uuid::TEXT;
  BEGIN
    PERFORM public.create_service_v1(payload||jsonb_build_object('external_id',gen_random_uuid(),'reported_failures',
      jsonb_build_array(jsonb_build_object('external_id',gen_random_uuid(),'reported_failure_type_id',standard_id),jsonb_build_object('external_id',gen_random_uuid(),'reported_failure_type_id',standard_id))),actor);
    RAISE EXCEPTION 'Expected duplicate standard rejection';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  session:=public.create_service_upload_session_v1((result->>'external_id')::UUID,(result->>'version')::INTEGER,hash,actor);
  BEGIN
    PERFORM public.create_service_upload_session_v1((result->>'external_id')::UUID,999,repeat('b',64),actor);
    RAISE EXCEPTION 'Expected version rejection';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  claim:=public.claim_service_upload_v1(hash);
  BEGIN
    PERFORM public.claim_service_upload_v1(hash);
    RAISE EXCEPTION 'Expected concurrent upload rejection';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  -- Editing the order must not change the snapshot authorized for the upload.
  result:=public.update_service_v1(payload||jsonb_build_object('expected_version',result->'version','reported_failures',rows_value - 1),actor);
  ASSERT jsonb_array_length(result->'reported_failures')=2;
  ASSERT (result->>'subtotal')::NUMERIC=400;
  finished:=public.finish_service_upload_v1(hash,(claim->>'leaseId')::UUID,claim->>'path','image/png',123,repeat('c',64));
  ASSERT (finished->>'serviceVersion')::INTEGER=1;
  ASSERT (public.claim_service_upload_v1(hash)->>'completed')::BOOLEAN;
  ASSERT (SELECT jsonb_array_length(document_snapshot->'reported_failures') FROM public.service_document WHERE external_id=(finished->>'documentId')::UUID)=3;
  ASSERT NOT (SELECT document_snapshot ? 'internal_notes' FROM public.service_document WHERE external_id=(finished->>'documentId')::UUID);
  BEGIN
    UPDATE public.service_document SET folio_snapshot='changed' WHERE external_id=(finished->>'documentId')::UUID;
    RAISE EXCEPTION 'Expected immutable rejection';
  EXCEPTION WHEN SQLSTATE '22000' THEN NULL; END;
  UPDATE public.service_upload_session SET expires_at=now()-interval '1 minute' WHERE id=(session->>'id')::UUID;
  BEGIN
    PERFORM public.claim_service_upload_v1(hash);
    RAISE EXCEPTION 'Expected expiry rejection';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END; $test$;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.service_upload_session; RAISE EXCEPTION 'Expected denied'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.claim_service_upload_v1(repeat('a',64)); RAISE EXCEPTION 'Expected denied RPC'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
