import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAppRole } from "../_shared/auth.ts";
import { serveWithCors } from "../_shared/server.ts";
import { handleClientsRequest } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

serveWithCors(async (req: Request) => {
  const authorization = await requireAppRole(
    req,
    supabase,
    ["ADMINISTRADOR", "EMPLEADO"],
  );
  if (authorization instanceof Response) return authorization;
  return await handleClientsRequest(req, supabase, authorization);
});
