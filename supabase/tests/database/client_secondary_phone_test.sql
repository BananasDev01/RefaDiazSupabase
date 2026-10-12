-- Local regression only. Every fixture is rolled back.
BEGIN;
INSERT INTO public.role (id, description) VALUES (995515, 'EMPLEADO');
INSERT INTO public.person (id, name, last_name) VALUES (995515, 'Prueba', 'Contacto');
INSERT INTO public."user" (id, person_id, role_id) VALUES ('95515111-1111-4111-8111-111111111111', 995515, 995515);
INSERT INTO public.brand (id, name, brand_type_id) SELECT 995515, 'Prueba contacto', min(id) FROM public.brand_type;
INSERT INTO public.car_model (id, name, brand_id) VALUES (995515, 'Prueba', 995515);
DO $test$
DECLARE
  actor TEXT := '95515111-1111-4111-8111-111111111111';
  customer JSONB;
  result JSONB;
  service_result JSONB;
  payload JSONB;
BEGIN
  payload := jsonb_build_object('external_id', '95515000-0000-4000-8000-000000000001',
    'client_name', 'Prueba contacto', 'phone_number', '8199551501', 'secondary_phone_number', '81 9955 1502',
    'vehicles', jsonb_build_array(jsonb_build_object('external_id', '95515000-0000-4000-8000-000000000002', 'car_model_id', 995515, 'model_year', 2020)));
  customer := public.save_client_with_vehicles_v1(payload, actor);
  ASSERT customer->>'secondary_phone_number' = '81 9955 1502';
  ASSERT (public.save_client_with_vehicles_v1(payload, actor)->>'id') = customer->>'id';
  ASSERT (public.search_clients_v1(p_phone => '8199551502')#>>'{pagination,total}')::INTEGER = 1;
  ASSERT (public.search_clients_v1(p_query => '8199551502')#>>'{pagination,total}')::INTEGER = 1;
  BEGIN
    PERFORM public.save_client_with_vehicles_v1(jsonb_build_object('client_id', customer->'id', 'secondary_phone_number', '8199551501'), actor);
    RAISE EXCEPTION 'Expected duplicate contact rejection';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    ASSERT SQLERRM = 'CLIENT_SECONDARY_PHONE_DUPLICATE';
  END;
  service_result := public.create_service_v1(jsonb_build_object(
    'external_id', '95515000-0000-4000-8000-000000000003',
    'client_vehicle_id', customer#>'{vehicles,0,client_vehicle_id}',
    'line_totals_mode', 'LINES', 'tax_amount', 0, 'reported_failures', '[]'::JSONB), actor);
  ASSERT service_result#>>'{client_snapshot,secondary_phone_number}' = '81 9955 1502';
  result := public.save_client_with_vehicles_v1(jsonb_build_object('client_id', customer->'id', 'secondary_phone_number', NULL), actor);
  ASSERT result->>'secondary_phone_number' IS NULL;
  ASSERT public.service_public_json_v1((service_result->>'id')::BIGINT)#>>'{client_snapshot,secondary_phone_number}' = '81 9955 1502', 'Existing document snapshots must not be retroactively rewritten';
  result := public.save_client_with_vehicles_v1(jsonb_build_object('client_id', customer->'id', 'secondary_phone_number', '8199551503'), actor);
  ASSERT result->>'secondary_phone_number' = '8199551503';
END;
$test$;
ROLLBACK;
