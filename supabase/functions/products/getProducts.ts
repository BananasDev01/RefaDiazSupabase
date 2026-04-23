import {
  handleProductCatalog,
  handleProductSmartSearch,
} from "./list/catalogRouter.ts";
import { parseProductListRequest } from "./list/listRequest.ts";
import { getProductSearchProfile } from "./list/searchProfiles.ts";
import { getActiveProductTypeById } from "./productTypeService.ts";

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
    const productTypeId = url.searchParams.get("productTypeId");

    if (!productTypeId) {
      return new Response(
        JSON.stringify({
          error: "El parámetro 'productTypeId' es obligatorio.",
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

    const profile = getProductSearchProfile(productType);
    const { q, params, error } = parseProductListRequest(url, productTypeId);

    if (error) {
      return new Response(
        JSON.stringify({ error }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q) {
      return handleProductSmartSearch(q, params, profile);
    }

    return await handleProductCatalog(params, profile);
  } catch (_err) {
    return new Response(
      JSON.stringify({ error: "Error al procesar la solicitud" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
}
