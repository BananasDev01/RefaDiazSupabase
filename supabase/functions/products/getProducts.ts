import { handleAccessorySearch } from "./accessorySearchService.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";
import { handleGetComponentProductCatalog } from "./componentCatalogService.ts";
import { handleComponentSmartSearch } from "./componentSearchService.ts";
import {
  getActiveProductTypeById,
  usesTransitiveCompatibilityCatalog,
} from "./productTypeService.ts";
import { handleSmartSearch } from "./productSearchService.ts";
import { handleGetStandardProductCatalog } from "./standardProductCatalogService.ts";

/**
 * GET /products
 * Retorna registros de la tabla "product".
 * Si se proporciona el parámetro 'q', realiza una búsqueda inteligente.
 * De lo contrario, despacha al catálogo estándar o a un catálogo especializado
 * según el tipo de producto.
 */
export async function handleGetProducts(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q");
    const productTypeId = url.searchParams.get("productTypeId");

    if (q) {
      if (!productTypeId) {
        return new Response(
          JSON.stringify({
            error:
              "El parámetro 'productTypeId' es obligatorio para la búsqueda inteligente.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const productType = await getActiveProductTypeById(productTypeId);

      if (!productType) {
        return new Response(
          JSON.stringify({
            error: "El productTypeId no existe o no está activo.",
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      if (productType.name?.toLowerCase() === "accesorio") {
        return handleAccessorySearch(q, productTypeId);
      }

      if (usesTransitiveCompatibilityCatalog(productType)) {
        return handleComponentSmartSearch(q, productTypeId);
      }

      return handleSmartSearch(q, productTypeId);
    }

    const params: ProductCatalogParams = {
      name: url.searchParams.get("name") || undefined,
      productTypeId: productTypeId || undefined,
      brandId: url.searchParams.get("brandId") || undefined,
      modelId: url.searchParams.get("modelId") || undefined,
      modelYear: url.searchParams.get("modelYear") || undefined,
      productCategoryId: url.searchParams.get("productCategoryId") || undefined,
    };

    const productType = productTypeId
      ? await getActiveProductTypeById(productTypeId)
      : null;

    if (usesTransitiveCompatibilityCatalog(productType)) {
      return await handleGetComponentProductCatalog(params);
    }

    return await handleGetStandardProductCatalog(params);
  } catch (_err) {
    return new Response(
      JSON.stringify({ error: "Error al procesar la solicitud" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
}
