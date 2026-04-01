import { supabase } from "./config.ts";
import { convertToCamelCase } from "../_shared/utils.ts";
import {
  findModelAndBrandIds,
  FoundIds,
  parseSmartQuery,
} from "./productSearchHelpers.ts";

/**
 * Construye y ejecuta la consulta de búsqueda dinámica basada en los IDs y el año.
 * @param productTypeId - El ID del tipo de producto.
 * @param modelIds - Array de IDs de modelos.
 * @param brandIds - Array de IDs de marcas.
 * @param year - El año extraído.
 * @returns Una lista de productos que coinciden.
 */
async function executeDynamicSearch(
  productTypeId: string,
  { modelIds }: FoundIds, // Ya no necesitamos brandIds aquí
  year: number | null,
) {
  console.log("search", modelIds, year);
  if ((modelIds.length == 0) && !year) return [];

  let query = supabase
    .from("product")
    .select(`
      *,
      product_type(id, name),
      product_car_model!inner(
        car_model_id,
        initial_year,
        last_year,
        car_model!inner(
          id,
          name,
          brand!inner(id, name)
        )
      )
    `)
    .eq("product_type_id", productTypeId)
    .eq("active", true)
    .eq("product_car_model.active", true);

  // --- INICIA CÓDIGO CORREGIDO Y SIMPLIFICADO ---

  // Filtro por Modelo: Se ha vuelto más potente porque modelIds ahora incluye
  // los modelos de las marcas encontradas.
  if (modelIds.length > 0) {
    // Filtramos directamente por el ID del modelo en la tabla de compatibilidad.
    query = query.in("product_car_model.car_model_id", modelIds);
  }

  // El filtro por Marca ya no es necesario aquí, está implícito en la lista de modelIds.

  // Filtro por Año (sin cambios, ya estaba correcto)
  if (year) {
    query = query.lte("product_car_model.initial_year", year);
    query = query.gte("product_car_model.last_year", year);
  }

  // --- TERMINA CÓDIGO CORREGIDO Y SIMPLIFICADO ---

  const { data, error } = await query;

  if (error) {
    console.error("Error executing dynamic search:", error);
    throw new Error(error.message);
  }

  return data;
}

/**
 * Orquesta la lógica de búsqueda inteligente.
 * @param q - La consulta de texto del usuario.
 * @param productTypeId - El ID del tipo de producto.
 * @returns La respuesta HTTP con los resultados de la búsqueda.
 */
export async function handleSmartSearch(
  q: string,
  productTypeId: string,
): Promise<Response> {
  try {
    const { dpis, year, tokens } = parseSmartQuery(q);

    // Caso 1: Búsqueda por DPI (prioridad máxima)
    if (dpis.length > 0) {
      const { data, error } = await supabase
        .from("product")
        .select("*, product_type(id, name)")
        .in("dpi", dpis)
        .eq("product_type_id", productTypeId);

      if (error) throw new Error(error.message);

      const camelCaseData = convertToCamelCase(data);
      return new Response(JSON.stringify(camelCaseData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Caso 2: Búsqueda jerárquica por tokens y año
    const { modelIds, brandIds } = await findModelAndBrandIds(tokens);

    const searchResults = await executeDynamicSearch(productTypeId, {
      modelIds,
      brandIds,
    }, year);

    // Procesar y limpiar los datos como en la función original
    const processedData = searchResults?.map((product) => ({
      ...product,
      productCarModels: product.product_car_model?.map((pcm: any) => ({
        carModelId: pcm.car_model_id,
        initialYear: pcm.initial_year,
        lastYear: pcm.last_year,
        carModel: pcm.car_model,
      })) || [],
    }));

    const cleanedData = processedData?.map((product) => {
      const { product_car_model, ...rest } = product;
      return rest;
    });

    const camelCaseData = convertToCamelCase(cleanedData);

    return new Response(JSON.stringify(camelCaseData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || "Error al procesar la búsqueda inteligente",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
