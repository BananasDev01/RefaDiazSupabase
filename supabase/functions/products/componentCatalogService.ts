import { convertToCamelCase } from "../_shared/utils.ts";
import { supabase } from "./config.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import {
  buildComponentProductSelect,
  loadTransitiveCompatibility,
  matchesCompatibilityFilters,
  normalizeDirectCompatibility,
} from "./componentCompatibilityService.ts";
import { buildProductListResponse } from "./list/responseMapper.ts";
import {
  searchProductIds,
  sortProductsByProductIds,
} from "./list/searchIdService.ts";

export async function handleGetComponentProductCatalog(
  params: ProductCatalogParams,
): Promise<Response> {
  let productIds: number[];
  let totalCount = 0;

  try {
    const searchResult = await searchProductIds({
      ...params,
      includeTransitiveCompatibility: true,
    });
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
    .select(buildComponentProductSelect())
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

  const transitiveCompatibilitiesByProduct = await loadTransitiveCompatibility(
    sortedData,
  );

  const processedData = sortedData?.map((product: any) => {
    const productCarModels = normalizeDirectCompatibility(product);
    const transitiveProductCarModels =
      transitiveCompatibilitiesByProduct.get(product.id) || [];

    return {
      ...product,
      productCarModels,
      transitiveProductCarModels,
      productCategory: product.product_category || null,
    };
  });

  const filteredData = processedData?.filter((product: any) =>
    matchesCompatibilityFilters(
      [
        ...(product.productCarModels || []),
        ...(product.transitiveProductCarModels || []),
      ],
      params,
    )
  );

  const cleanedData = filteredData?.map((product: any) => {
    const { product_car_model, ...rest } = product;
    return rest;
  });

  const camelCaseData = convertToCamelCase(cleanedData);

  return buildProductListResponse(
    camelCaseData as any[],
    params.pagination,
    totalCount,
  );
}
