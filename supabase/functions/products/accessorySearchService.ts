import { convertToCamelCase } from "../_shared/utils.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import { supabase } from "./config.ts";
import {
  buildProductCatalogSelect,
  buildProductListResponse,
  normalizeProductCatalogRows,
} from "./list/responseMapper.ts";
import {
  searchProductIds,
  sortProductsByProductIds,
} from "./list/searchIdService.ts";

interface AccessoryQueryAnalysis {
  tokens: string[];
  year: number | null;
}

interface TokenMatchIds {
  modelIds: number[];
  brandIds: number[];
  nameTokens: string[];
}

interface IdRow {
  id: number;
}

interface AccessorySearchResult {
  products: any[];
  totalCount: number;
}

function parseAccessoryQuery(query: string): AccessoryQueryAnalysis {
  const yearRegex = /\b(\d{4})\b/g;
  const yearMatch = query.match(yearRegex);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
  const remainingQuery = year
    ? query.replace(yearRegex, " ").trim()
    : query.trim();

  return {
    tokens: remainingQuery.split(/\s+/).filter(Boolean),
    year,
  };
}

function matchesCompatibilityYear(
  compatibility: { initial_year: number | null; last_year: number | null },
  year: number,
): boolean {
  const { initial_year, last_year } = compatibility;

  if (initial_year === null && last_year === null) {
    return true;
  }

  if (initial_year !== null && year < initial_year) {
    return false;
  }

  if (last_year !== null && year > last_year) {
    return false;
  }

  return true;
}

async function findTokenMatchIds(tokens: string[]): Promise<TokenMatchIds> {
  const modelIdsFromTokens: number[] = [];
  const brandIdsFromTokens: number[] = [];
  const nameTokens: string[] = [];

  for (const token of tokens) {
    const [
      { data: modelData, error: modelError },
      { data: brandData, error: brandError },
    ] = await Promise.all([
      supabase
        .from("car_model")
        .select("id")
        .ilike("name", `%${token}%`)
        .eq("active", true),
      supabase
        .from("brand")
        .select("id")
        .ilike("name", `%${token}%`)
        .eq("active", true),
    ]);

    if (modelError) {
      throw new Error(modelError.message);
    }

    if (brandError) {
      throw new Error(brandError.message);
    }

    const matchedModelIds = ((modelData || []) as IdRow[]).map((
      model: IdRow,
    ) => model.id);
    const matchedBrandIds = ((brandData || []) as IdRow[]).map((
      brand: IdRow,
    ) => brand.id);

    if (matchedModelIds.length > 0) {
      modelIdsFromTokens.push(...matchedModelIds);
    }

    if (matchedBrandIds.length > 0) {
      brandIdsFromTokens.push(...matchedBrandIds);
    }

    if (matchedModelIds.length === 0 && matchedBrandIds.length === 0) {
      nameTokens.push(token);
    }
  }

  return {
    modelIds: [...new Set(modelIdsFromTokens)],
    brandIds: [...new Set(brandIdsFromTokens)],
    nameTokens,
  };
}

async function resolveCompatibilityModelIds(
  modelIds: number[],
  brandIds: number[],
): Promise<number[]> {
  if (modelIds.length > 0 && brandIds.length > 0) {
    const { data, error } = await supabase
      .from("car_model")
      .select("id")
      .in("id", modelIds)
      .in("brand_id", brandIds)
      .eq("active", true);

    if (error) {
      throw new Error(error.message);
    }

    return [
      ...new Set(((data || []) as IdRow[]).map((
        model: IdRow,
      ) => model.id)),
    ];
  }

  if (brandIds.length > 0) {
    const { data, error } = await supabase
      .from("car_model")
      .select("id")
      .in("brand_id", brandIds)
      .eq("active", true);

    if (error) {
      throw new Error(error.message);
    }

    return [
      ...new Set(((data || []) as IdRow[]).map((
        model: IdRow,
      ) => model.id)),
    ];
  }

  return [...new Set(modelIds)];
}

async function executeAccessorySearch(
  productTypeId: string,
  nameTokens: string[],
  compatibilityModelIds: number[],
  year: number | null,
  params: ProductCatalogParams,
): Promise<AccessorySearchResult> {
  const includeCompatibilityJoin = compatibilityModelIds.length > 0;
  const { productIds, totalCount } = await searchProductIds({
    productTypeId,
    nameTokens,
    modelIds: compatibilityModelIds,
    modelYear: includeCompatibilityJoin && year !== null
      ? String(year)
      : undefined,
    pagination: params.pagination,
  });

  if (productIds.length === 0) {
    return { products: [], totalCount };
  }

  let query: any = supabase
    .from("product")
    .select(buildProductCatalogSelect(includeCompatibilityJoin))
    .in("id", productIds)
    .eq("product_type_id", productTypeId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (includeCompatibilityJoin) {
    query = query
      .eq("product_car_model.active", true)
      .in("product_car_model.car_model_id", compatibilityModelIds);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const sortedData = sortProductsByProductIds(
    (data as any[]) || [],
    productIds,
  );

  if (!year || !includeCompatibilityJoin) {
    return { products: sortedData, totalCount };
  }

  const filteredProducts = sortedData
    .map((product: any) => ({
      ...product,
      product_car_model: (product.product_car_model || []).filter(
        (compatibility: any) =>
          compatibility.active &&
          matchesCompatibilityYear(compatibility, year),
      ),
    }))
    .filter((product: any) => product.product_car_model.length > 0);

  return { products: filteredProducts, totalCount };
}

/**
 * Búsqueda para accesorios basada en tokens:
 * - tokens que coinciden con modelos se usan como compatibilidad
 * - tokens que coinciden con marcas expanden a los modelos de la marca
 * - si hay marca + modelo, se usa la intersección
 * - tokens que no coinciden con marca/modelo se usan como filtro AND sobre product.name
 * - si la consulta incluye un año y un modelo/marca, el año profundiza el filtro
 *   sobre la compatibilidad encontrada
 */
export async function handleAccessorySearch(
  q: string,
  productTypeId: string,
  params: ProductCatalogParams = { productTypeId },
): Promise<Response> {
  try {
    const trimmedQuery = q.trim();

    if (!trimmedQuery) {
      return buildProductListResponse([], params.pagination, 0);
    }

    const { tokens, year } = parseAccessoryQuery(trimmedQuery);

    if (tokens.length === 0) {
      return buildProductListResponse([], params.pagination, 0);
    }

    const { modelIds, brandIds, nameTokens } = await findTokenMatchIds(tokens);
    const compatibilityModelIds = await resolveCompatibilityModelIds(
      modelIds,
      brandIds,
    );

    if (
      tokens.length > 0 &&
      modelIds.length === 0 &&
      brandIds.length === 0 &&
      nameTokens.length === 0
    ) {
      return buildProductListResponse([], params.pagination, 0);
    }

    if (
      (modelIds.length > 0 || brandIds.length > 0) &&
      compatibilityModelIds.length === 0
    ) {
      return buildProductListResponse([], params.pagination, 0);
    }

    const searchResult = await executeAccessorySearch(
      productTypeId,
      nameTokens,
      compatibilityModelIds,
      year,
      params,
    );

    const normalizedProducts = normalizeProductCatalogRows(
      searchResult.products,
    );
    const camelCaseData = convertToCamelCase(normalizedProducts);

    return buildProductListResponse(
      camelCaseData as any[],
      params.pagination,
      searchResult.totalCount,
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || "Error al procesar la búsqueda de accesorios",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
