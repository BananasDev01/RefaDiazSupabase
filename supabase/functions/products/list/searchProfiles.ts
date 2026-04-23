import type { ProductTypeSummary } from "../productTypeService.ts";

export type ProductCompatibilityMode =
  | "range"
  | "singleYear"
  | "transitiveRange";

export interface ProductSearchProfile {
  kind: "standard" | "accessory" | "transitiveCompatibility";
  supportsDpi: boolean;
  supportsNameTokens: boolean;
  compatibilityMode: ProductCompatibilityMode;
}

const TRANSITIVE_COMPATIBILITY_PRODUCT_TYPES = new Set(["tapa", "abanico"]);

export function getProductSearchProfile(
  productType: ProductTypeSummary,
): ProductSearchProfile {
  const normalizedName = productType.name?.toLowerCase() || "";

  if (normalizedName === "accesorio") {
    return {
      kind: "accessory",
      supportsDpi: false,
      supportsNameTokens: true,
      compatibilityMode: "singleYear",
    };
  }

  if (TRANSITIVE_COMPATIBILITY_PRODUCT_TYPES.has(normalizedName)) {
    return {
      kind: "transitiveCompatibility",
      supportsDpi: false,
      supportsNameTokens: false,
      compatibilityMode: "transitiveRange",
    };
  }

  return {
    kind: "standard",
    supportsDpi: normalizedName === "radiador",
    supportsNameTokens: false,
    compatibilityMode: "range",
  };
}

export function usesTransitiveCompatibilityProfile(
  profile: ProductSearchProfile,
): boolean {
  return profile.kind === "transitiveCompatibility";
}
