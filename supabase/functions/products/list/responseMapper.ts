import { ProductPaginationParams } from "../catalogTypes.ts";

export function buildProductCatalogSelect(
  includeCompatibilityJoin: boolean,
): string {
  const compatibilityRelation = includeCompatibilityJoin
    ? `product_car_model!inner(
          car_model_id,
          initial_year,
          last_year,
          active,
          car_model!inner(
            id,
            name,
            brand!inner(id, name)
          )
        )`
    : `product_car_model(
          car_model_id,
          initial_year,
          last_year,
          active,
          car_model(
            id,
            name,
            brand(id, name)
          )
        )`;

  return `
    *,
    product_type(id, name),
    product_category:product_category_id(
      id,
      name,
      description,
      product_type_id,
      order_id,
      active
    ),
    ${compatibilityRelation}
  `;
}

export function normalizeProductCatalogRows(
  products: any[] | null | undefined,
): any[] {
  const processedData = (products || []).map((product: any) => ({
    ...product,
    productCarModels: product.product_car_model
      ?.map((pcm: any) => ({
        carModelId: pcm.car_model_id,
        initialYear: pcm.initial_year,
        lastYear: pcm.last_year,
        active: pcm.active,
        carModel: pcm.car_model,
      }))
      .filter((pcm: any) => pcm.active) || [],
    productCategory: product.product_category || null,
  }));

  return processedData.map((product: any) => {
    const { product_car_model, ...rest } = product;
    return rest;
  });
}

export function buildProductListResponse(
  data: any[],
  pagination: ProductPaginationParams | undefined,
  total: number,
): Response {
  const body = pagination
    ? {
      data,
      pagination: {
        limit: pagination.limit,
        offset: pagination.offset,
        total,
      },
    }
    : data;

  return new Response(
    JSON.stringify(body),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
