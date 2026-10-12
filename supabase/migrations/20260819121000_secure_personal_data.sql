CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT upper(role.description)
    FROM public."user" AS app_user
    JOIN public.role AS role ON role.id = app_user.role_id
    WHERE app_user.id = (SELECT auth.uid())::TEXT
      AND app_user.active = true
      AND role.active = true
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_app_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(public.current_app_role() IN ('ADMINISTRADOR', 'EMPLEADO'), false)
$$;

CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(public.current_app_role() = 'ADMINISTRADOR', false)
$$;

REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_app_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_app_admin() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_app_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated, service_role;

ALTER TABLE public.control_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_vehicle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
    public.control_fields,
    public.client,
    public.vehicle,
    public.client_vehicle,
    public.person,
    public."user",
    public.role
FROM anon;

REVOKE ALL PRIVILEGES ON SEQUENCE
    public.client_id_seq,
    public.vehicle_id_seq,
    public.client_vehicle_id_seq,
    public.person_id_seq,
    public.role_id_seq
FROM anon;

REVOKE ALL PRIVILEGES ON TABLE
    public.control_fields,
    public.client,
    public.vehicle,
    public.client_vehicle,
    public.person,
    public."user",
    public.role
FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.client,
    public.vehicle,
    public.client_vehicle
TO authenticated;

GRANT SELECT ON TABLE
    public.person,
    public."user",
    public.role
TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE
    public.client_id_seq,
    public.vehicle_id_seq,
    public.client_vehicle_id_seq,
    public.person_id_seq,
    public.role_id_seq
TO authenticated;

DROP POLICY IF EXISTS client_staff_all ON public.client;
CREATE POLICY client_staff_all
ON public.client
FOR ALL
TO authenticated
USING (public.is_app_staff())
WITH CHECK (public.is_app_staff());

DROP POLICY IF EXISTS vehicle_staff_all ON public.vehicle;
CREATE POLICY vehicle_staff_all
ON public.vehicle
FOR ALL
TO authenticated
USING (public.is_app_staff())
WITH CHECK (public.is_app_staff());

DROP POLICY IF EXISTS client_vehicle_staff_all ON public.client_vehicle;
CREATE POLICY client_vehicle_staff_all
ON public.client_vehicle
FOR ALL
TO authenticated
USING (public.is_app_staff())
WITH CHECK (public.is_app_staff());

DROP POLICY IF EXISTS person_staff_select ON public.person;
CREATE POLICY person_staff_select
ON public.person
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS person_admin_write ON public.person;
CREATE POLICY person_admin_write
ON public.person
FOR ALL
TO authenticated
USING (public.is_app_admin())
WITH CHECK (public.is_app_admin());

DROP POLICY IF EXISTS user_admin_write ON public."user";
DROP POLICY IF EXISTS user_staff_select ON public."user";
DROP POLICY IF EXISTS user_admin_all ON public."user";
CREATE POLICY user_admin_all
ON public."user"
FOR ALL
TO authenticated
USING (public.is_app_admin())
WITH CHECK (public.is_app_admin());

DROP POLICY IF EXISTS role_staff_select ON public.role;
CREATE POLICY role_staff_select
ON public.role
FOR SELECT
TO authenticated
USING (public.is_app_staff());

DROP POLICY IF EXISTS role_admin_write ON public.role;
CREATE POLICY role_admin_write
ON public.role
FOR ALL
TO authenticated
USING (public.is_app_admin())
WITH CHECK (public.is_app_admin());
