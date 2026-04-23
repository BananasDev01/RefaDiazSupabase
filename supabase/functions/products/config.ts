import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export let supabase: any;

export function setSupabaseClientForTests(client: any): void {
  if (Deno.env.get("SUPABASE_TEST_MODE") !== "true") {
    throw new Error("setSupabaseClientForTests solo puede usarse en tests.");
  }

  supabase = client;
}

if (Deno.env.get("SUPABASE_TEST_MODE") === "true") {
  supabase = null;
} else {
  // Obtén las variables de entorno necesarias para la conexión
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "Error: Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.",
    );
    Deno.exit(1);
  }

  // Inicializa el cliente de Supabase
  supabase = createClient(supabaseUrl, supabaseKey);
}
