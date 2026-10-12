// Importa las definiciones de tipos y la API del runtime de Supabase
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Importa el cliente de Supabase desde esm.sh
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/server.ts";
import { convertToSnakeCase, convertToCamelCase } from "../_shared/utils.ts"; // Solo mantenemos este por si acaso
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

console.log("Edge Function 'users' iniciada...");

/**
 * GET /users
 * Retorna todos los registros de la tabla "user" con información completa de "person" y "role".
 */
async function handleGetUsers(req: Request): Promise<Response> {
  const { data, error } = await supabase
    .from("user")
    .select("*, person(*), role(*)")
    .eq("active", true);

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify(convertToCamelCase(data)),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * GET /users?id=<ID>
 * Retorna un usuario específico de la tabla "user" con información completa de "person" y "role".
 */
async function handleGetUserById(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Missing 'id' parameter in URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data, error } = await supabase
      .from("user")
      .select("*, person(*), role(*)")
      .eq("id", id)
      .eq("active", true)
      .single();

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: error.code === "PGRST116" ? 404 : 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify(convertToCamelCase(data)),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error processing request" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * POST /users
 * Crea un nuevo usuario en la tabla "user" usando el stored procedure.
 * El ID del usuario viene desde el frontend.
 * 
 * Payload esperado:
 * {
 *   "id": "2ce2e19e-39cb-4ab2-98ef-83d6fbf2fa59",
 *   "person": {
 *     "name": "Juan",
 *     "lastName": "Pérez",
 *     "birthDate": "1990-01-01",
 *     "email": "usuario@ejemplo.com",
 *     "phoneNumber": "1234567890",
 *     "address": "Calle Falsa 123"
 *   },
 *   "roleId": 1,
 *   "active": 1
 * }
 */
async function handlePostUser(req: Request): Promise<Response> {
  try {
    const contentType = req.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return new Response(
        JSON.stringify({ error: "Content-Type must be application/json" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();

    const { password, person, roleId, active } = body;

    const email = person?.email;

    if (!email || !password || !person || !roleId) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: person.email, password, person o roleId" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 1. Crear usuario en Supabase Auth
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (authError || !authUser || !authUser.user || !authUser.user.id) {
      return new Response(
        JSON.stringify({ error: authError?.message || "No se pudo crear el usuario en Auth" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const id = authUser.user.id;

    // 2. Crear registro en la tabla user usando el ID generado
    const userData = {
      id,
      person: {
        name: person.name,
        lastName: person.lastName,
        birthDate: person.birthDate,
        email: email, // Aseguramos que el email sea el mismo
        phoneNumber: person.phoneNumber,
        address: person.address
      },
      roleId,
      active: active ?? 1
    };

    const snakeCaseUser = convertToSnakeCase(userData);

    const { data, error } = await supabase.rpc("create_user_with_person", {
      user_data: snakeCaseUser
    });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(convertToCamelCase(data)),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Invalid JSON payload o error inesperado" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * PUT /users?id=<ID>
 * Actualiza un registro existente en la tabla "user", incluyendo datos de "person".
 * 
 * Payload esperado:
 * {
 *   "person": {
 *     "name": "Juan Actualizado",
 *     "lastName": "Pérez",
 *     "birthDate": "1990-01-01",
 *     "email": "usuario@ejemplo.com",
 *     "phoneNumber": "1234567890",
 *     "address": "Calle Nueva 456"
 *   },
 *   "roleId": 2,
 *   "active": 0
 * }
 */
async function handlePutUser(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Missing 'id' parameter in URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { person, roleId, active } = body;

    // Obtener el person_id del usuario
    const { data: userData, error: fetchError } = await supabase
      .from("user")
      .select("person_id")
      .eq("id", id)
      .single();

    if (fetchError) {
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Actualizar person si se proporciona
    if (person) {
      const { error: personError } = await supabase
        .from("person")
        .update({
          name: person.name,
          last_name: person.lastName,
          birth_date: person.birthDate,
          email: person.email,
          phone_number: person.phoneNumber,
          address: person.address
        })
        .eq("id", userData.person_id);

      if (personError) {
        return new Response(
          JSON.stringify({ error: personError.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Actualizar user
    const updateData: { role_id?: number; active?: number } = {};
    if (roleId !== undefined) updateData.role_id = roleId;
    if (active !== undefined) updateData.active = active;

    const { data, error } = await supabase
      .from("user")
      .update(updateData)
      .eq("id", id)
      .select("*, person(*), role(*)")
      .single();

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(convertToCamelCase(data)),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Invalid JSON payload" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * DELETE /users?id=<ID>
 * Elimina (desactiva) un usuario existente.
 */
async function handleDeleteUser(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Missing 'id' parameter in URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: userData, error: fetchError } = await supabase
      .from("user")
      .select("*, person(*), role(*)")
      .eq("id", id)
      .single();

    if (fetchError) {
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 1. Eliminar de Supabase Auth
    const { error: authError } = await supabase.auth.admin.deleteUser(id);
    if (authError) {
      return new Response(
        JSON.stringify({ error: authError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Desactivar en la base de datos
    const { error: updateError } = await supabase
      .from("user")
      .update({ active: 0 })
      .eq("id", id);

    if (updateError) {
      return new Response(
        JSON.stringify({ error: updateError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(convertToCamelCase(userData)),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error processing request" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Función principal que enruta la petición según el método HTTP
serveWithCors(async (req: Request) => {
  const authorization = await requireAppRole(req, supabase, ["ADMINISTRADOR"]);
  if (authorization instanceof Response) return authorization;

  switch (req.method) {
    case "GET":
      if (new URL(req.url).searchParams.get("id")) {
        return await handleGetUserById(req);
      } else {
        return await handleGetUsers(req);
      }
    case "POST":
      return await handlePostUser(req);
    case "PUT":
      return await handlePutUser(req);
    case "DELETE":
      return await handleDeleteUser(req);
    default:
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
  }
});
