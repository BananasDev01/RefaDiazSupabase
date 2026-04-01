import { convertToCamelCase } from "../_shared/utils.ts";
import { supabase } from "./config.ts";
import {
  buildComponentProductSelect,
  loadTransitiveCompatibility,
  normalizeDirectCompatibility,
  ProductCompatibility,
} from "./componentCompatibilityService.ts";
import {
  findModelAndBrandIds,
  parseSmartQuery,
} from "./productSearchHelpers.ts";

function matchesSearchCriteria(
  compatibilities: ProductCompatibility[],
  modelIds: number[],
  year: number | null,
): boolean {
  return compatibilities.some((compatibility) => {
    if (modelIds.length > 0 && !modelIds.includes(compatibility.carModelId)) {
      return false;
    }

    if (year !== null) {
      if (
        compatibility.initialYear !== null &&
        year < compatibility.initialYear
      ) {
        return false;
      }

      if (compatibility.lastYear !== null && year > compatibility.lastYear) {
        return false;
      }
    }

    return true;
  });
}

export async function handleComponentSmartSearch(
  q: string,
  productTypeId: string,
): Promise<Response> {
  try {
    const { dpis, year, tokens } = parseSmartQuery(q);

    if (dpis.length > 0) {
      const { data, error } = await supabase
        .from("product")
        .select("*, product_type(id, name)")
        .in("dpi", dpis)
        .eq("product_type_id", productTypeId);

      if (error) {
        throw new Error(error.message);
      }

      const camelCaseData = convertToCamelCase(data);
      return new Response(JSON.stringify(camelCaseData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { modelIds } = await findModelAndBrandIds(tokens);

    if (modelIds.length === 0 && year === null) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data, error } = await supabase
      .from("product")
      .select(buildComponentProductSelect())
      .eq("product_type_id", productTypeId)
      .eq("active", true)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
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
    }).filter((product: any) =>
      matchesSearchCriteria(
        [
          ...(product.productCarModels || []),
          ...(product.transitiveProductCarModels || []),
        ],
        modelIds,
        year,
      )
    );

    const cleanedData = processedData?.map((product: any) => {
      const { product_car_model, ...rest } = product;
      return rest;
    });

    const camelCaseData = convertToCamelCase(cleanedData);

    return new Response(JSON.stringify(camelCaseData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || "Error al procesar la búsqueda inteligente",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
