/**
 * Interfaz para los parámetros de filtro de productos.
 */
export interface ProductFilterParams {
  brandId?: string;
  modelId?: string;
  modelYear?: string;
}

/**
 * Construye y aplica filtros a una consulta de Supabase para la entidad "product".
 *
 * @param query La consulta de Supabase inicial.
 * @param params Los parámetros de filtro a aplicar.
 * @returns La consulta de Supabase con los filtros aplicados.
 */
export function buildProductQuery(
  query: any,
  params: ProductFilterParams,
): any {
  let filteredQuery = query;

  // Filtrar por brandId
  if (params.brandId) {
    filteredQuery = filteredQuery.eq(
      "product_car_model.car_model.brand_id",
      params.brandId,
    );
  }

  // Filtrar por modelId
  if (params.modelId) {
    filteredQuery = filteredQuery.eq(
      "product_car_model.car_model_id",
      params.modelId,
    );
  }

  // Filtrar por modelYear
  if (params.modelYear) {
    const year = parseInt(params.modelYear, 10);
    if (!isNaN(year)) {
      filteredQuery = filteredQuery
        .lte("product_car_model.initial_year", year)
        .gte("product_car_model.last_year", year);
    }
  }
  return filteredQuery;
}
