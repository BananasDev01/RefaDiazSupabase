import { supabase } from "./config.ts";
import { ProductCatalogParams } from "./catalogTypes.ts";

export type ProductCompatibility = {
  carModelId: number;
  initialYear: number | null;
  lastYear: number | null;
  active: boolean;
  carModel: {
    id: number;
    name: string;
    brand: {
      id: number;
      name: string;
    } | null;
  } | null;
};

type ProductComponentRelation = {
  product_id: number;
  component_product_id: number;
  active: boolean;
};

type ProductIdRow = {
  id: number;
};

type ProductCarModelRow = {
  product_id: number;
  car_model_id: number;
  initial_year: number | null;
  last_year: number | null;
  active: boolean;
  car_model: any;
};

export function buildComponentProductSelect(): string {
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
    product_car_model(
      car_model_id,
      initial_year,
      last_year,
      active,
      car_model(
        id,
        name,
        brand(id, name)
      )
    )
  `;
}

export function normalizeCarModelRelation(
  carModel: any,
): ProductCompatibility["carModel"] {
  if (Array.isArray(carModel)) {
    return carModel[0] || null;
  }

  return carModel || null;
}

export function normalizeDirectCompatibility(
  product: any,
): ProductCompatibility[] {
  return product.product_car_model
    ?.map((pcm: any) => ({
      carModelId: pcm.car_model_id,
      initialYear: pcm.initial_year,
      lastYear: pcm.last_year,
      active: pcm.active,
      carModel: normalizeCarModelRelation(pcm.car_model),
    }))
    .filter((pcm: ProductCompatibility) => pcm.active) || [];
}

export function cloneCompatibility(
  compatibility: ProductCompatibility,
): ProductCompatibility {
  return {
    carModelId: compatibility.carModelId,
    initialYear: compatibility.initialYear,
    lastYear: compatibility.lastYear,
    active: compatibility.active,
    carModel: compatibility.carModel,
  };
}

export function matchesCompatibilityFilters(
  compatibilities: ProductCompatibility[],
  params: ProductCatalogParams,
): boolean {
  if (!params.brandId && !params.modelId && !params.modelYear) {
    return true;
  }

  const parsedYear = params.modelYear ? parseInt(params.modelYear, 10) : null;

  return compatibilities.some((compatibility) => {
    if (
      params.brandId &&
      String(compatibility.carModel?.brand?.id) !== params.brandId
    ) {
      return false;
    }

    if (params.modelId && String(compatibility.carModelId) !== params.modelId) {
      return false;
    }

    if (parsedYear !== null && !Number.isNaN(parsedYear)) {
      if (
        compatibility.initialYear !== null &&
        parsedYear < compatibility.initialYear
      ) {
        return false;
      }

      if (
        compatibility.lastYear !== null && parsedYear > compatibility.lastYear
      ) {
        return false;
      }
    }

    return true;
  });
}

export async function loadTransitiveCompatibility(
  products: any[],
): Promise<Map<number, ProductCompatibility[]>> {
  const productIds = products.map((product) => product.id);

  if (productIds.length === 0) {
    return new Map();
  }

  const { data: componentRelations, error: componentRelationsError } =
    await supabase
      .from("product_component")
      .select("product_id, component_product_id, active")
      .in("component_product_id", productIds)
      .eq("active", true);

  if (componentRelationsError) {
    throw new Error(componentRelationsError.message);
  }

  const activeRelations =
    ((componentRelations || []) as ProductComponentRelation[])
      .filter((relation: ProductComponentRelation) => relation.active);

  if (activeRelations.length === 0) {
    return new Map();
  }

  const parentProductIds = [
    ...new Set(
      activeRelations.map((relation: ProductComponentRelation) =>
        relation.product_id
      ),
    ),
  ];

  const { data: activeParentProducts, error: activeParentsError } =
    await supabase
      .from("product")
      .select("id")
      .in("id", parentProductIds)
      .eq("active", true);

  if (activeParentsError) {
    throw new Error(activeParentsError.message);
  }

  const activeParentIds = new Set(
    ((activeParentProducts || []) as ProductIdRow[]).map((
      product: ProductIdRow,
    ) => product.id),
  );

  const filteredRelations = activeRelations.filter((
    relation: ProductComponentRelation,
  ) => activeParentIds.has(relation.product_id));

  if (filteredRelations.length === 0) {
    return new Map();
  }

  const { data: parentCompatibilities, error: parentCompatibilitiesError } =
    await supabase
      .from("product_car_model")
      .select(`
        product_id,
        car_model_id,
        initial_year,
        last_year,
        active,
        car_model:car_model_id(
          id,
          name,
          brand:brand_id(id, name)
        )
      `)
      .in(
        "product_id",
        [
          ...new Set(
            filteredRelations.map((relation: ProductComponentRelation) =>
              relation.product_id
            ),
          ),
        ],
      )
      .eq("active", true);

  if (parentCompatibilitiesError) {
    throw new Error(parentCompatibilitiesError.message);
  }

  const compatibilitiesByParent = new Map<number, ProductCompatibility[]>();

  for (
    const compatibility
      of ((parentCompatibilities || []) as ProductCarModelRow[])
  ) {
    const normalizedCompatibility: ProductCompatibility = {
      carModelId: compatibility.car_model_id,
      initialYear: compatibility.initial_year,
      lastYear: compatibility.last_year,
      active: compatibility.active,
      carModel: normalizeCarModelRelation(compatibility.car_model),
    };

    const existingCompatibilities =
      compatibilitiesByParent.get(compatibility.product_id) || [];

    existingCompatibilities.push(normalizedCompatibility);
    compatibilitiesByParent.set(
      compatibility.product_id,
      existingCompatibilities,
    );
  }

  const transitiveCompatibilitiesByProduct = new Map<
    number,
    ProductCompatibility[]
  >();

  for (const relation of filteredRelations) {
    const parentCompatibilitiesForRelation =
      compatibilitiesByParent.get(relation.product_id) || [];
    const existingCompatibilities =
      transitiveCompatibilitiesByProduct.get(relation.component_product_id) ||
      [];
    const dedupeKeys = new Set(
      existingCompatibilities.map((compatibility) =>
        `${compatibility.carModelId}:${compatibility.initialYear}:${compatibility.lastYear}`
      ),
    );

    for (const compatibility of parentCompatibilitiesForRelation) {
      const dedupeKey =
        `${compatibility.carModelId}:${compatibility.initialYear}:${compatibility.lastYear}`;

      if (dedupeKeys.has(dedupeKey)) {
        continue;
      }

      dedupeKeys.add(dedupeKey);
      existingCompatibilities.push(cloneCompatibility(compatibility));
    }

    transitiveCompatibilitiesByProduct.set(
      relation.component_product_id,
      existingCompatibilities,
    );
  }

  return transitiveCompatibilitiesByProduct;
}
