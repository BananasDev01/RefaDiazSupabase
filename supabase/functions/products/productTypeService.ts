import { supabase } from "./config.ts";

const TRANSITIVE_COMPATIBILITY_PRODUCT_TYPES = new Set(["tapa", "abanico"]);

export interface ProductTypeSummary {
  id: number;
  name: string;
}

export async function getActiveProductTypeById(
  productTypeId: string,
): Promise<ProductTypeSummary | null> {
  const { data, error } = await supabase
    .from("product_type")
    .select("id, name")
    .eq("id", productTypeId)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export function usesTransitiveCompatibilityCatalog(
  productType: ProductTypeSummary | null,
): boolean {
  return TRANSITIVE_COMPATIBILITY_PRODUCT_TYPES.has(
    productType?.name?.toLowerCase() || "",
  );
}
