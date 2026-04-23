type FilterOp =
  | { type: "eq"; path: string; value: unknown }
  | { type: "in"; path: string; values: unknown[] }
  | { type: "ilike"; path: string; pattern: string }
  | { type: "lte"; path: string; value: number }
  | { type: "gte"; path: string; value: number };

type TableName =
  | "brand"
  | "car_model"
  | "product"
  | "product_car_model"
  | "product_component"
  | "product_type";

type FixtureDb = Record<TableName, any[]>;

interface ProductSearchIdRpcArgs {
  p_product_type_id: number;
  p_name: string | null;
  p_product_category_id: number | null;
  p_brand_id: number | null;
  p_model_id: number | null;
  p_model_ids: number[] | null;
  p_model_year: number | null;
  p_include_transitive_compatibility: boolean;
  p_limit: number | null;
  p_offset: number;
  p_name_tokens?: string[] | null;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getByPath(row: any, path: string): unknown {
  return path.split(".").reduce((current, key) => current?.[key], row);
}

function normalizeComparable(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

function matchesIlike(value: unknown, pattern: string): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(String(value));
}

function compatibilityMatches(compatibility: any, op: FilterOp): boolean {
  const path = op.path.replace("product_car_model.", "");
  const value = getByPath(compatibility, path);

  if (op.type === "eq") {
    return normalizeComparable(value) === normalizeComparable(op.value);
  }

  if (op.type === "in") {
    return op.values.map(normalizeComparable).includes(
      normalizeComparable(value),
    );
  }

  if (op.type === "lte") {
    return typeof value === "number" && value <= op.value;
  }

  if (op.type === "gte") {
    return typeof value === "number" && value >= op.value;
  }

  return matchesIlike(value, op.pattern);
}

function rowMatches(row: any, op: FilterOp): boolean {
  const value = getByPath(row, op.path);

  if (op.type === "eq") {
    return normalizeComparable(value) === normalizeComparable(op.value);
  }

  if (op.type === "in") {
    return op.values.map(normalizeComparable).includes(
      normalizeComparable(value),
    );
  }

  if (op.type === "lte") {
    return typeof value === "number" && value <= op.value;
  }

  if (op.type === "gte") {
    return typeof value === "number" && value >= op.value;
  }

  return matchesIlike(value, op.pattern);
}

class FakeQuery {
  private filters: FilterOp[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private maybeSingleResult = false;

  constructor(
    private readonly table: TableName,
    private readonly db: FixtureDb,
  ) {}

  select(_columns: string): FakeQuery {
    return this;
  }

  eq(path: string, value: unknown): FakeQuery {
    this.filters.push({ type: "eq", path, value });
    return this;
  }

  in(path: string, values: unknown[]): FakeQuery {
    this.filters.push({ type: "in", path, values });
    return this;
  }

  ilike(path: string, pattern: string): FakeQuery {
    this.filters.push({ type: "ilike", path, pattern });
    return this;
  }

  lte(path: string, value: number): FakeQuery {
    this.filters.push({ type: "lte", path, value });
    return this;
  }

  gte(path: string, value: number): FakeQuery {
    this.filters.push({ type: "gte", path, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): FakeQuery {
    this.orderBy = { column, ascending: options.ascending ?? true };
    return this;
  }

  maybeSingle(): FakeQuery {
    this.maybeSingleResult = true;
    return this;
  }

  then(
    resolve: (value: { data: any; error: null }) => unknown,
    reject?: (reason?: unknown) => unknown,
  ): Promise<unknown> {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  private execute(): { data: any; error: null } {
    let rows = deepClone(this.db[this.table]);

    if (this.table === "product") {
      rows = rows.map((row) => ({ ...row }));

      const compatibilityFilters = this.filters.filter((op) =>
        op.path.startsWith("product_car_model.")
      );
      const rowFilters = this.filters.filter((op) =>
        !op.path.startsWith("product_car_model.")
      );

      for (const op of rowFilters) {
        rows = rows.filter((row) => rowMatches(row, op));
      }

      if (compatibilityFilters.length > 0) {
        rows = rows
          .map((row) => ({
            ...row,
            product_car_model: (row.product_car_model || []).filter(
              (compatibility: any) =>
                compatibilityFilters.every((op) =>
                  compatibilityMatches(compatibility, op)
                ),
            ),
          }))
          .filter((row) => row.product_car_model.length > 0);
      }
    } else {
      for (const op of this.filters) {
        rows = rows.filter((row) => rowMatches(row, op));
      }
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows.sort((left, right) => {
        const leftValue = String(getByPath(left, column) ?? "");
        const rightValue = String(getByPath(right, column) ?? "");

        if (leftValue === rightValue) {
          return 0;
        }

        const direction = ascending ? 1 : -1;
        return leftValue > rightValue ? direction : -direction;
      });
    }

    if (this.maybeSingleResult) {
      return { data: rows[0] || null, error: null };
    }

    return { data: rows, error: null };
  }
}

function brand(id: number, name: string) {
  return { id, name, active: true };
}

function model(id: number, name: string, brandRecord: any) {
  return {
    id,
    name,
    brand_id: brandRecord.id,
    brand: brandRecord,
    active: true,
  };
}

function compatibility(
  productId: number,
  carModel: any,
  initialYear: number | null,
  lastYear: number | null,
) {
  return {
    product_id: productId,
    car_model_id: carModel.id,
    initial_year: initialYear,
    last_year: lastYear,
    active: true,
    car_model: carModel,
  };
}

function matchesCompatibilityYear(compatibility: any, year: number): boolean {
  return (
    (compatibility.initial_year === null ||
      compatibility.initial_year <= year) &&
    (compatibility.last_year === null || compatibility.last_year >= year)
  );
}

function buildEffectiveCompatibilities(
  db: FixtureDb,
  includeTransitiveCompatibility: boolean,
) {
  const productsById = new Map(
    db.product.map((product) => [product.id, product]),
  );
  const compatibilities = db.product_car_model.map((compatibility) => ({
    ...compatibility,
    brand_id: compatibility.car_model?.brand_id,
    compatibility_source: "direct",
  }));

  if (!includeTransitiveCompatibility) {
    return compatibilities;
  }

  for (const relation of db.product_component) {
    if (!relation.active) {
      continue;
    }

    const parentProduct = productsById.get(relation.product_id);

    if (!parentProduct?.active) {
      continue;
    }

    for (const compatibility of parentProduct.product_car_model || []) {
      if (!compatibility.active) {
        continue;
      }

      compatibilities.push({
        ...compatibility,
        product_id: relation.component_product_id,
        brand_id: compatibility.car_model?.brand_id,
        compatibility_source: "transitive",
      });
    }
  }

  return compatibilities;
}

function executeProductSearchIdsRpc(
  db: FixtureDb,
  args: ProductSearchIdRpcArgs,
) {
  const modelIds = args.p_model_ids || [];
  const hasCompatibilityFilters = Boolean(
    args.p_brand_id ||
      args.p_model_id ||
      modelIds.length > 0 ||
      args.p_model_year,
  );
  const effectiveCompatibilities = buildEffectiveCompatibilities(
    db,
    args.p_include_transitive_compatibility,
  );

  let products = db.product.filter((product) =>
    product.active &&
    product.product_type_id === args.p_product_type_id &&
    (!args.p_name || matchesIlike(product.name, `%${args.p_name}%`)) &&
    (
      !args.p_name_tokens ||
      args.p_name_tokens.length === 0 ||
      args.p_name_tokens.every((token) =>
        !token || matchesIlike(product.name, `%${token}%`)
      )
    ) &&
    (
      args.p_product_category_id === null ||
      product.product_category_id === args.p_product_category_id
    )
  );

  if (hasCompatibilityFilters) {
    products = products.filter((product) =>
      effectiveCompatibilities.some((compatibility) => {
        if (compatibility.product_id !== product.id) {
          return false;
        }

        if (args.p_brand_id && compatibility.brand_id !== args.p_brand_id) {
          return false;
        }

        if (args.p_model_id && compatibility.car_model_id !== args.p_model_id) {
          return false;
        }

        if (
          modelIds.length > 0 &&
          !modelIds.includes(compatibility.car_model_id)
        ) {
          return false;
        }

        if (
          args.p_model_year !== null &&
          !matchesCompatibilityYear(compatibility, args.p_model_year)
        ) {
          return false;
        }

        return true;
      })
    );
  }

  products.sort((left, right) => {
    if (left.created_at === right.created_at) {
      return right.id - left.id;
    }

    return left.created_at > right.created_at ? -1 : 1;
  });

  const totalCount = products.length;
  const offset = Math.max(args.p_offset || 0, 0);
  const pagedProducts = typeof args.p_limit === "number"
    ? products.slice(offset, offset + Math.max(args.p_limit, 0))
    : products.slice(offset);

  return {
    data: pagedProducts.length > 0
      ? pagedProducts.map((product) => ({
        product_id: product.id,
        total_count: totalCount,
      }))
      : [{
        product_id: null,
        total_count: totalCount,
      }],
    error: null,
  };
}

export function createProductsFakeSupabase() {
  const toyota = brand(10, "Toyota");
  const nissan = brand(11, "Nissan");
  const corolla = model(20, "Corolla", toyota);
  const sentra = model(21, "Sentra", nissan);

  const productTypes = [
    { id: 1, name: "RADIADOR", active: true },
    { id: 2, name: "ACCESORIO", active: true },
    { id: 3, name: "TAPA", active: true },
  ];

  const category = {
    id: 50,
    name: "Mangueras",
    description: null,
    product_type_id: 2,
    order_id: 1,
    active: true,
  };

  const products = [
    {
      id: 100,
      name: "Radiador Corolla",
      comments: null,
      stock_count: 4,
      dpi: "DPI100",
      product_type_id: 1,
      product_type: productTypes[0],
      product_category_id: null,
      product_category: null,
      active: true,
      created_at: "2026-01-03T00:00:00.000Z",
      product_car_model: [compatibility(100, corolla, 2018, 2022)],
    },
    {
      id: 101,
      name: "Radiador Inactivo",
      comments: null,
      stock_count: 0,
      dpi: "DPI999",
      product_type_id: 1,
      product_type: productTypes[0],
      product_category_id: null,
      product_category: null,
      active: false,
      created_at: "2026-01-04T00:00:00.000Z",
      product_car_model: [compatibility(101, sentra, 2015, 2017)],
    },
    {
      id: 200,
      name: "Manguera Superior",
      comments: null,
      stock_count: null,
      dpi: null,
      product_type_id: 2,
      product_type: productTypes[1],
      product_category_id: 50,
      product_category: category,
      active: true,
      created_at: "2026-01-05T00:00:00.000Z",
      product_car_model: [compatibility(200, corolla, 2020, 2020)],
    },
    {
      id: 201,
      name: "Tapon Universal",
      comments: null,
      stock_count: null,
      dpi: null,
      product_type_id: 2,
      product_type: productTypes[1],
      product_category_id: 50,
      product_category: category,
      active: true,
      created_at: "2026-01-06T00:00:00.000Z",
      product_car_model: [],
    },
    {
      id: 202,
      name: "Clip Universal",
      comments: null,
      stock_count: null,
      dpi: null,
      product_type_id: 2,
      product_type: productTypes[1],
      product_category_id: 50,
      product_category: category,
      active: true,
      created_at: "2026-01-07T00:00:00.000Z",
      product_car_model: [compatibility(202, corolla, null, null)],
    },
    {
      id: 300,
      name: "Tapa Corolla",
      comments: null,
      stock_count: 6,
      dpi: null,
      product_type_id: 3,
      product_type: productTypes[2],
      product_category_id: null,
      product_category: null,
      active: true,
      created_at: "2026-01-08T00:00:00.000Z",
      product_car_model: [],
    },
  ];

  const db: FixtureDb = {
    brand: [toyota, nissan],
    car_model: [corolla, sentra],
    product: products,
    product_car_model: products.flatMap((product) => product.product_car_model),
    product_component: [
      {
        product_id: 100,
        component_product_id: 300,
        active: true,
      },
    ],
    product_type: productTypes,
  };

  return {
    from(table: TableName): FakeQuery {
      return new FakeQuery(table, db);
    },
    rpc(functionName: string, args: ProductSearchIdRpcArgs) {
      if (functionName !== "search_product_ids_v1") {
        return Promise.resolve({
          data: null,
          error: { message: `RPC no soportado: ${functionName}` },
        });
      }

      return Promise.resolve(executeProductSearchIdsRpc(db, args));
    },
  };
}
