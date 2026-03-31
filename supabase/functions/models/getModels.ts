import { convertToCamelCase } from "../_shared/utils.ts";
import { supabase } from "./config.ts";

/**
 * GET /models
 * Retorna todos los registros de la tabla "car_model" con su "brand" relacionado.
 * Soporta búsqueda por nombre con el parámetro "name".
 */
export async function handleGetModels(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get("name");
    const brandId = url.searchParams.get("brandId");

    let query = supabase
      .from("car_model")
      .select("*, brand(name, brand_type_id)")
      .eq("active", true)
      .order("name", { ascending: true });

    if (name) {
      query = query.ilike("name", `%${name}%`);
    }
    if (brandId) {
      query = query.eq("brand_id", brandId);
    }

    const { data, error } = await query;

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
