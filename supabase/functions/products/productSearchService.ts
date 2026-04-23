import { supabase } from "./config.ts";
import { convertToCamelCase } from "../_shared/utils.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import {
  findModelAndBrandIds,
  FoundIds,
  parseSmartQuery,
} from "./productSearchHelpers.ts";
import {
  searchProductIds,
  sortProductsByProductIds,
} from "./list/searchIdService.ts";
import { buildProductListResponse } from "./list/responseMapper.ts";

interface SmartSearchResult {
  products: any[];
  totalCount: number;
}

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
  params: ProductCatalogParams,
): Promise<SmartSearchResult> {
  if ((modelIds.length == 0) && !year) {
    return { products: [], totalCount: 0 };
  }

  const { productIds, totalCount } = await searchProductIds({
    productTypeId,
    modelIds,
    modelYear: year !== null ? String(year) : undefined,
    pagination: params.pagination,
  });

  if (productIds.length === 0) {
    return { products: [], totalCount };
  }

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
    .in("id", productIds)
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

  return {
    products: sortProductsByProductIds((data as any[]) || [], productIds),
    totalCount,
  };
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
  params: ProductCatalogParams = { productTypeId },
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

      const rows = (data as any[]) || [];
      const paginatedRows = params.pagination
        ? rows.slice(
          params.pagination.offset,
          params.pagination.offset + params.pagination.limit,
        )
        : rows;

      const camelCaseData = convertToCamelCase(paginatedRows);
      return buildProductListResponse(
        camelCaseData as any[],
        params.pagination,
        rows.length,
      );
    }

    // Caso 2: Búsqueda jerárquica por tokens y año
    const { modelIds, brandIds } = await findModelAndBrandIds(tokens);

    const searchResult = await executeDynamicSearch(
      productTypeId,
      {
        modelIds,
        brandIds,
      },
      year,
      params,
    );

    // Procesar y limpiar los datos como en la función original
    const processedData = (searchResult.products as any[])?.map((
      product: any,
    ) => ({
      ...product,
      productCarModels: product.product_car_model?.map((pcm: any) => ({
        carModelId: pcm.car_model_id,
        initialYear: pcm.initial_year,
        lastYear: pcm.last_year,
        carModel: pcm.car_model,
      })) || [],
    }));

    const cleanedData = processedData?.map((product: any) => {
      const { product_car_model, ...rest } = product;
      return rest;
    });

    const camelCaseData = convertToCamelCase(cleanedData);

    return buildProductListResponse(
      camelCaseData as any[],
      params.pagination,
      searchResult.totalCount,
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || "Error al procesar la búsqueda inteligente",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
