export type AppRole = "ADMINISTRADOR" | "EMPLEADO";

export type AppAuthorization = {
  userId: string;
  role: AppRole;
};

type SupabaseAuthClient = {
  auth: {
    getUser: (token: string) => Promise<{
      data: { user: { id: string } | null };
      error: { message?: string } | null;
    }>;
  };
  from: (table: string) => any;
};

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function relatedRole(
  record: any,
): { description?: string; active?: boolean } | null {
  const role = record?.role;
  if (Array.isArray(role)) {
    return role[0] || null;
  }
  return role || null;
}

export async function requireAppRole(
  req: Request,
  supabase: SupabaseAuthClient,
  allowedRoles: readonly AppRole[],
): Promise<AppAuthorization | Response> {
  const token = bearerToken(req);
  if (!token) {
    return jsonError(401, "Falta un token Bearer válido");
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(
    token,
  );
  if (authError || !authData.user) {
    return jsonError(401, "Token inválido o expirado");
  }

  const { data: appUser, error: appUserError } = await supabase
    .from("user")
    .select("active, role:role_id(description, active)")
    .eq("id", authData.user.id)
    .maybeSingle();

  const roleRecord = relatedRole(appUser);
  const role = roleRecord?.description?.toUpperCase() as AppRole | undefined;

  if (
    appUserError ||
    !appUser ||
    appUser.active !== true ||
    roleRecord?.active !== true ||
    !role
  ) {
    return jsonError(403, "El usuario no tiene un rol activo en la aplicación");
  }

  if (!allowedRoles.includes(role)) {
    return jsonError(403, "El rol del usuario no permite esta operación");
  }

  return { userId: authData.user.id, role };
}
