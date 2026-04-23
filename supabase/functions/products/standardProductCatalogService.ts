import { convertToCamelCase } from "../_shared/utils.ts";
import { supabase } from "./config.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import { buildProductQuery } from "./productFilterService.ts";
import {
  buildProductCatalogSelect,
  buildProductListResponse,
  normalizeProductCatalogRows,
} from "./list/responseMapper.ts";
import {
  searchProductIds,
  sortProductsByProductIds,
} from "./list/searchIdService.ts";

export async function handleGetStandardProductCatalog(
  params: ProductCatalogParams,
): Promise<Response> {
  const hasCompatibilityFilters = Boolean(
    params.brandId || params.modelId || params.modelYear,
  );

  let productIds: number[];
  let totalCount = 0;

  try {
    const searchResult = await searchProductIds(params);
    productIds = searchResult.productIds;
    totalCount = searchResult.totalCount;
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (productIds.length === 0) {
    return buildProductListResponse([], params.pagination, totalCount);
  }

  let query: any = supabase
    .from("product")
    .select(buildProductCatalogSelect(hasCompatibilityFilters))
    .in("id", productIds)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (params.name) {
    query = query.ilike("name", `%${params.name}%`);
  }

  if (params.productTypeId) {
    query = query.eq("product_type_id", params.productTypeId);
  }

  if (params.productCategoryId) {
    query = query.eq("product_category_id", params.productCategoryId);
  }

  if (hasCompatibilityFilters) {
    query = query.eq("product_car_model.active", true);
    query = buildProductQuery(query, {
      brandId: params.brandId,
      modelId: params.modelId,
      modelYear: params.modelYear,
    });
  }

  const { data, error } = await query;

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const sortedData = sortProductsByProductIds(
    (data as any[]) || [],
    productIds,
  );
  const cleanedData = normalizeProductCatalogRows(sortedData);
  const camelCaseData = convertToCamelCase(cleanedData);

  return buildProductListResponse(
    camelCaseData as any[],
    params.pagination,
    totalCount,
  );
}
