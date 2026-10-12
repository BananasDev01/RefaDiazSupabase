-- Only OTHER is repeatable. The snapshot is assigned by the existing trigger,
-- not trusted from callers. Existing UUIDs and rows are preserved.
ALTER TABLE public.service_reported_failure
  DROP CONSTRAINT service_reported_failure_selection_unique;
CREATE UNIQUE INDEX service_reported_failure_standard_unique
  ON public.service_reported_failure(service_id, reported_failure_type_id)
  WHERE failure_code_snapshot <> 'OTHER';
-- The write RPCs already insert in payload order; their new identity IDs preserve
-- that order within each catalog type. external_id is the stable row identity.
