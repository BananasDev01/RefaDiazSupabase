import { convertToCamelCase } from "../_shared/utils.ts";
import { supabase } from "./config.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import { buildProductQuery } from "./productFilterService.ts";

function buildProductSelect(includeCompatibilityJoin: boolean): string {
  const compatibilityRelation = includeCompatibilityJoin
    ? `product_car_model!inner(
          car_model_id,
          initial_year,
          last_year,
          active,
          car_model!inner(
            id,
            name,
            brand!inner(id, name)
          )
        )`
    : `product_car_model(
          car_model_id,
          initial_year,
          last_year,
          active,
          car_model(
            id,
            name,
            brand(id, name)
          )
        )`;

  return `
    *,
    product_type(id, name),
    product_category:product_category_id(
      id,
      name,
      description,
      product_type_id,
      order_id,
      active
    ),
    ${compatibilityRelation}
  `;
}

export async function handleGetStandardProductCatalog(
  params: ProductCatalogParams,
): Promise<Response> {
  const hasCompatibilityFilters = Boolean(
    params.brandId || params.modelId || params.modelYear,
  );

  let query: any = supabase
    .from("product")
    .select(buildProductSelect(hasCompatibilityFilters))
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

  const processedData = (data as any[])?.map((product: any) => ({
    ...product,
    productCarModels: product.product_car_model
      ?.map((pcm: any) => ({
        carModelId: pcm.car_model_id,
        initialYear: pcm.initial_year,
        lastYear: pcm.last_year,
        active: pcm.active,
        carModel: pcm.car_model,
      }))
      .filter((pcm: any) => pcm.active) || [],
    productCategory: product.product_category || null,
  }));

  const cleanedData = processedData?.map((product: any) => {
    const { product_car_model, ...rest } = product;
    return rest;
  });

  const camelCaseData = convertToCamelCase(cleanedData);

  return new Response(
    JSON.stringify(camelCaseData),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
