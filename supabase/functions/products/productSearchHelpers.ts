import { supabase } from "./config.ts";

export interface ParsedQuery {
  dpis: string[];
  year: number | null;
  tokens: string[];
}

export interface FoundIds {
  modelIds: number[];
  brandIds: number[];
}

export function parseSmartQuery(query: string): ParsedQuery {
  const dpiRegex = /\b(DPI\d+)\b/gi;
  const yearRegex = /\b(\d{4})\b/g;

  const dpis = query.match(dpiRegex) || [];
  let remainingQuery = query.replace(dpiRegex, "").trim();

  const yearMatch = remainingQuery.match(yearRegex);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

  if (year) {
    remainingQuery = remainingQuery.replace(yearRegex, "").trim();
  }

  const tokens = remainingQuery.split(/\s+/).filter(Boolean);

  return { dpis, year, tokens };
}

export async function findModelAndBrandIds(
  tokens: string[],
): Promise<FoundIds> {
  const modelIdsFromTokens: number[] = [];
  const brandIdsFromTokens: number[] = [];

  for (const token of tokens) {
    const { data: modelData } = await supabase
      .from("car_model")
      .select("id")
      .ilike("name", `%${token}%`)
      .eq("active", true);

    if (modelData && modelData.length > 0) {
      modelIdsFromTokens.push(...modelData.map((model) => model.id));
    }

    const { data: brandData } = await supabase
      .from("brand")
      .select("id")
      .ilike("name", `%${token}%`)
      .eq("active", true);

    if (brandData && brandData.length > 0) {
      brandIdsFromTokens.push(...brandData.map((brand) => brand.id));
    }
  }

  if (
    modelIdsFromTokens.length > 0 &&
    brandIdsFromTokens.length > 0 &&
    tokens.length > 1
  ) {
    const { data: filteredModelData } = await supabase
      .from("car_model")
      .select("id")
      .in("id", modelIdsFromTokens)
      .in("brand_id", brandIdsFromTokens);

    const finalModelIds = filteredModelData
      ? filteredModelData.map((model) => model.id)
      : [];

    return { modelIds: [...new Set(finalModelIds)], brandIds: [] };
  }

  if (brandIdsFromTokens.length > 0) {
    const { data: modelsOfBrands } = await supabase
      .from("car_model")
      .select("id")
      .in("brand_id", brandIdsFromTokens);

    const finalModelIds = modelsOfBrands
      ? modelsOfBrands.map((model) => model.id)
      : [];

    return { modelIds: [...new Set(finalModelIds)], brandIds: [] };
  }

  return {
    modelIds: [...new Set(modelIdsFromTokens)],
    brandIds: [],
  };
}
