import { convertToCamelCase } from "../_shared/utils.ts";
import { supabase } from "./config.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import {
  buildComponentProductSelect,
  loadTransitiveCompatibility,
  matchesCompatibilityFilters,
  normalizeDirectCompatibility,
} from "./componentCompatibilityService.ts";

export async function handleGetComponentProductCatalog(
  params: ProductCatalogParams,
): Promise<Response> {
  let query: any = supabase
    .from("product")
    .select(buildComponentProductSelect())
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

  const transitiveCompatibilitiesByProduct = await loadTransitiveCompatibility(
    (data as any[]) || [],
  );

  const processedData = (data as any[])?.map((product: any) => {
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

  return new Response(
    JSON.stringify(camelCaseData),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
