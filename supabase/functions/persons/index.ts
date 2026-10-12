// Importa las definiciones de tipos y la API del runtime de Supabase
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Importa el cliente de Supabase desde esm.sh
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/server.ts";
import { convertToCamelCase, convertToSnakeCase } from "../_shared/utils.ts";
import { requireAppRole } from "../_shared/auth.ts";

// Obtén las variables de entorno necesarias para la conexión
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.");
  Deno.exit(1);
}

// Inicializa el cliente de Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Edge Function 'persons' iniciada...");

/**
 * Obtiene todas las personas.
 */
async function handleGetPersons(req: Request): Promise<Response> {
  const { data, error } = await supabase
    .from("person")
    .select("*");

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  
  // Convertir a camelCase antes de enviar la respuesta
  const camelCaseData = convertToCamelCase(data);
  
  return new Response(
    JSON.stringify(camelCaseData),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Crea una nueva persona.
 * Acepta datos en formato camelCase y los convierte a snake_case para la base de datos.
 */
async function handlePostPerson(req: Request): Promise<Response> {
  try {
    // Convertir el cuerpo de la solicitud de camelCase a snake_case
    const camelCaseBody = await req.json();
    const body = convertToSnakeCase(camelCaseBody);
    
    const { data, error } = await supabase
      .from("person")
      .insert(body)
      .select("*");

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    
    // Convertir a camelCase antes de enviar la respuesta
    const camelCaseData = convertToCamelCase(data);
    
    return new Response(
      JSON.stringify(camelCaseData),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Actualiza una persona existente.
 * Se espera que el ID se reciba como parámetro de consulta (?id=...)
 * Acepta datos en formato camelCase y los convierte a snake_case para la base de datos.
 */
async function handlePutPerson(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Falta el parámetro 'id' en la URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Convertir el cuerpo de la solicitud de camelCase a snake_case
    const camelCaseBody = await req.json();
    const body = convertToSnakeCase(camelCaseBody);

    const { data, error } = await supabase
      .from("person")
      .update(body)
      .eq("id", id)
      .select("*");

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    
    // Convertir a camelCase antes de enviar la respuesta
    const camelCaseData = convertToCamelCase(data);
    
    return new Response(
      JSON.stringify(camelCaseData),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Elimina una persona.
 * Se espera que el ID se reciba como parámetro de consulta (?id=...)
 */
async function handleDeletePerson(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Falta el parámetro 'id' en la URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data, error } = await supabase
      .from("person")
      .delete()
      .eq("id", id)
      .select("*");

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    
    // Convertir a camelCase antes de enviar la respuesta
    const camelCaseData = convertToCamelCase(data);
    
    return new Response(
      JSON.stringify(camelCaseData),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error al procesar la solicitud" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Función principal que enruta la petición según el método HTTP
serveWithCors(async (req: Request) => {
  const allowedRoles = req.method === "GET"
    ? ["ADMINISTRADOR", "EMPLEADO"] as const
    : ["ADMINISTRADOR"] as const;
  const authorization = await requireAppRole(req, supabase, allowedRoles);
  if (authorization instanceof Response) return authorization;

  switch (req.method) {
    case "GET":
      return await handleGetPersons(req);
    case "POST":
      return await handlePostPerson(req);
    case "PUT":
      return await handlePutPerson(req);
    case "DELETE":
      return await handleDeletePerson(req);
    default:
      return new Response(
        JSON.stringify({ error: "Método no permitido" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
  }
});
