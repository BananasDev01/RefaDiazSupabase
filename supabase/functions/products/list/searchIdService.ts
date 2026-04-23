import { ProductCatalogParams } from "../catalogTypes.ts";
import { supabase } from "../config.ts";

export interface ProductSearchIdParams extends ProductCatalogParams {
  modelIds?: number[];
  nameTokens?: string[];
  includeTransitiveCompatibility?: boolean;
  limit?: number;
  offset?: number;
}

export interface ProductSearchIdResult {
  productIds: number[];
  totalCount: number;
}

function parseOptionalInteger(value?: string): number | null {
  if (!value) {
    return null;
  }

  const parsedValue = parseInt(value, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

export async function searchProductIds(
  params: ProductSearchIdParams,
): Promise<ProductSearchIdResult> {
  const { data, error } = await supabase.rpc("search_product_ids_v1", {
    p_product_type_id: parseOptionalInteger(params.productTypeId) || 0,
    p_name: params.name || null,
    p_product_category_id: parseOptionalInteger(params.productCategoryId),
    p_brand_id: parseOptionalInteger(params.brandId),
    p_model_id: parseOptionalInteger(params.modelId),
    p_model_ids: params.modelIds && params.modelIds.length > 0
      ? params.modelIds
      : null,
    p_model_year: parseOptionalInteger(params.modelYear),
    p_include_transitive_compatibility: Boolean(
      params.includeTransitiveCompatibility,
    ),
    p_limit: params.pagination?.limit ?? params.limit ?? null,
    p_offset: params.pagination?.offset ?? params.offset ?? 0,
    p_name_tokens: params.nameTokens && params.nameTokens.length > 0
      ? params.nameTokens
      : null,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data || []) as Array<{
    product_id: number | null;
    total_count: number | string;
  }>;

  return {
    productIds: rows
      .map((row) => row.product_id)
      .filter((productId): productId is number => productId !== null),
    totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

export function sortProductsByProductIds<T extends { id: number }>(
  products: T[],
  productIds: number[],
): T[] {
  const orderByProductId = new Map(
    productIds.map((productId, index) => [productId, index]),
  );

  return [...products].sort((left, right) => {
    const leftOrder = orderByProductId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderByProductId.get(right.id) ??
      Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}
