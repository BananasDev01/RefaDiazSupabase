import { ProductCatalogParams } from "../catalogTypes.ts";
import { handleAccessorySearch } from "../accessorySearchService.ts";
import { handleGetComponentProductCatalog } from "../componentCatalogService.ts";
import { handleComponentSmartSearch } from "../componentSearchService.ts";
import { handleSmartSearch } from "../productSearchService.ts";
import { handleGetStandardProductCatalog } from "../standardProductCatalogService.ts";
import {
  ProductSearchProfile,
  usesTransitiveCompatibilityProfile,
} from "./searchProfiles.ts";

export function handleProductSmartSearch(
  q: string,
  params: ProductCatalogParams,
  profile: ProductSearchProfile,
): Promise<Response> {
  const productTypeId = params.productTypeId || "";

  if (profile.kind === "accessory") {
    return handleAccessorySearch(q, productTypeId, params);
  }

  if (usesTransitiveCompatibilityProfile(profile)) {
    return handleComponentSmartSearch(q, productTypeId, params);
  }

  return handleSmartSearch(q, productTypeId, params);
}

export function handleProductCatalog(
  params: ProductCatalogParams,
  profile: ProductSearchProfile,
): Promise<Response> {
  if (usesTransitiveCompatibilityProfile(profile)) {
    return handleGetComponentProductCatalog(params);
  }

  return handleGetStandardProductCatalog(params);
}
