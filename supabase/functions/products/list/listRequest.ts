import { ProductCatalogParams } from "../catalogTypes.ts";

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

export interface ProductListRequest {
  q?: string;
  params: ProductCatalogParams;
  error?: string;
}

function parsePaginationParams(url: URL) {
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  if (!limitParam && !offsetParam) {
    return { pagination: undefined };
  }

  const limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_PAGE_LIMIT;
  const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return {
      error:
        `El parámetro 'limit' debe ser un entero entre 1 y ${MAX_PAGE_LIMIT}.`,
    };
  }

  if (!Number.isInteger(offset) || offset < 0) {
    return {
      error: "El parámetro 'offset' debe ser un entero mayor o igual a 0.",
    };
  }

  return {
    pagination: {
      limit,
      offset,
    },
  };
}

export function parseProductListRequest(
  url: URL,
  productTypeId: string,
): ProductListRequest {
  const { pagination, error } = parsePaginationParams(url);

  if (error) {
    return {
      error,
      params: {
        productTypeId,
      },
    };
  }

  return {
    q: url.searchParams.get("q") || undefined,
    params: {
      name: url.searchParams.get("name") || undefined,
      productTypeId,
      brandId: url.searchParams.get("brandId") || undefined,
      modelId: url.searchParams.get("modelId") || undefined,
      modelYear: url.searchParams.get("modelYear") || undefined,
      productCategoryId: url.searchParams.get("productCategoryId") ||
        undefined,
      pagination,
    },
  };
}
