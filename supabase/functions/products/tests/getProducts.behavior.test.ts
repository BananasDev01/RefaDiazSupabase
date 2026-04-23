import { setSupabaseClientForTests } from "../config.ts";
import { handleGetProducts } from "../getProducts.ts";
import { createProductsFakeSupabase } from "./fakeSupabase.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(
      message ||
        `Expected ${expectedJson}, received ${actualJson}`,
    );
  }
}

function request(query = ""): Request {
  return new Request(`http://localhost/products${query}`);
}

async function getJson(query = "") {
  setSupabaseClientForTests(createProductsFakeSupabase());
  const response = await handleGetProducts(request(query));
  return {
    status: response.status,
    body: await response.json(),
  };
}

function ids(products: Array<{ id: number }>): number[] {
  return products.map((product) => product.id);
}

function paginatedIds(body: { data: Array<{ id: number }> }): number[] {
  return body.data.map((product) => product.id);
}

Deno.test("GET /products requires productTypeId", async () => {
  const { status, body } = await getJson();

  assertEquals(status, 400);
  assertEquals(body, { error: "El parámetro 'productTypeId' es obligatorio." });
});

Deno.test("standard catalog filters radiators by model and range year", async () => {
  const { status, body } = await getJson(
    "?productTypeId=1&modelId=20&modelYear=2020",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [100]);
});

Deno.test("standard catalog excludes radiators outside range year", async () => {
  const { status, body } = await getJson(
    "?productTypeId=1&modelId=20&modelYear=2023",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), []);
});

Deno.test("standard catalog filters accessories by category and keeps created_at desc order", async () => {
  const { status, body } = await getJson(
    "?productTypeId=2&productCategoryId=50",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [202, 201, 200]);
});

Deno.test("paginated standard catalog returns envelope with total", async () => {
  const { status, body } = await getJson(
    "?productTypeId=2&productCategoryId=50&limit=2&offset=1",
  );

  assertEquals(status, 200);
  assertEquals(paginatedIds(body), [201, 200]);
  assertEquals(body.pagination, { limit: 2, offset: 1, total: 3 });
});

Deno.test("paginated standard catalog keeps total on empty pages", async () => {
  const { status, body } = await getJson(
    "?productTypeId=2&productCategoryId=50&limit=2&offset=10",
  );

  assertEquals(status, 200);
  assertEquals(paginatedIds(body), []);
  assertEquals(body.pagination, { limit: 2, offset: 10, total: 3 });
});

Deno.test("radiator smart search supports DPI and preserves current active filtering behavior", async () => {
  const { status, body } = await getJson("?productTypeId=1&q=DPI999");

  assertEquals(status, 200);
  assertEquals(ids(body), [101]);
  assert(
    body[0].active === false,
    "DPI search currently returns inactive products.",
  );
});

Deno.test("radiator smart search resolves brand model and year", async () => {
  const { status, body } = await getJson(
    "?productTypeId=1&q=Toyota%20Corolla%202020",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [100]);
});

Deno.test("paginated radiator smart search returns envelope with total", async () => {
  const { status, body } = await getJson(
    "?productTypeId=1&q=Toyota%20Corolla%202020&limit=1",
  );

  assertEquals(status, 200);
  assertEquals(paginatedIds(body), [100]);
  assertEquals(body.pagination, { limit: 1, offset: 0, total: 1 });
});

Deno.test("accessory smart search filters by name tokens", async () => {
  const { status, body } = await getJson("?productTypeId=2&q=Manguera");

  assertEquals(status, 200);
  assertEquals(ids(body), [200]);
});

Deno.test("paginated accessory smart search returns envelope with total", async () => {
  const { status, body } = await getJson(
    "?productTypeId=2&q=Universal&limit=1",
  );

  assertEquals(status, 200);
  assertEquals(paginatedIds(body), [202]);
  assertEquals(body.pagination, { limit: 1, offset: 0, total: 2 });
});

Deno.test("accessory smart search does not use DPI semantics", async () => {
  const { status, body } = await getJson("?productTypeId=2&q=DPI100");

  assertEquals(status, 200);
  assertEquals(ids(body), []);
});

Deno.test("accessory smart search matches explicit year and null-year compatibility", async () => {
  const { status, body } = await getJson(
    "?productTypeId=2&q=Toyota%20Corolla%202020",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [202, 200]);
});

Deno.test("accessory smart search keeps null-year compatibility for unmatched years", async () => {
  const { status, body } = await getJson(
    "?productTypeId=2&q=Toyota%20Corolla%202021",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [202]);
});

Deno.test("transitive catalog filters component products through parent compatibility", async () => {
  const { status, body } = await getJson(
    "?productTypeId=3&modelId=20&modelYear=2020",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [300]);
  assertEquals(body[0].transitiveProductCarModels[0].carModelId, 20);
});

Deno.test("transitive smart search filters component products through parent compatibility", async () => {
  const { status, body } = await getJson(
    "?productTypeId=3&q=Toyota%20Corolla%202020",
  );

  assertEquals(status, 200);
  assertEquals(ids(body), [300]);
});
