import { handleQuotationsRequest } from "./handler.ts";
import { validateQuotationPayload } from "./validation.ts";

const authorization = {
  userId: "91111111-1111-4111-8111-111111111111",
  role: "EMPLEADO" as const,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function fakeSupabase(
  resolver: (
    name: string,
    args: Record<string, unknown>,
  ) => { data?: unknown; error?: { code?: string; message?: string } | null },
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const result = resolver(name, args);
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
}

function quotationPayload() {
  return {
    externalId: "90000000-0000-4000-8000-000000000101",
    provisionalReference: "PEND-COT-TEST",
    quotationDate: "2026-08-20",
    validUntil: "2026-09-20",
    clientVehicleId: 12,
    options: [{
      externalId: "90000000-0000-4000-8000-000000000111",
      name: "Radiador nuevo",
      taxAmount: 400,
      warrantyMonths: 6,
      items: [{
        externalId: "90000000-0000-4000-8000-000000000121",
        description: "Radiador",
        quantity: 2,
        unitPrice: 1000,
      }],
    }],
  };
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

Deno.test("quotation validation requires manual IVA per option", () => {
  const payload = quotationPayload();
  delete (payload.options[0] as any).taxAmount;
  const validation = validateQuotationPayload(payload, "create");
  assert(!validation.ok, "Expected missing IVA validation error");
  assert(
    validation.errors.some((error) => error.field === "options[0].taxAmount"),
    "Expected taxAmount error",
  );
});

Deno.test("quotation validation rejects negative prices", () => {
  const payload = quotationPayload();
  payload.options[0].items[0].unitPrice = -1;
  const validation = validateQuotationPayload(payload, "create");
  assert(!validation.ok, "Expected invalid price");
});

Deno.test("POST /quotations creates camelCase aggregate", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      external_id: (args.p_payload as any).external_id,
      idempotent_replay: false,
      options: [{ subtotal: 2000, tax_amount: 400, total: 2400 }],
    },
  }));
  const response = await handleQuotationsRequest(
    new Request("http://localhost/quotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quotationPayload()),
    }),
    supabase,
    authorization,
  );
  const responseBody = await json(response);
  assertEquals(response.status, 201);
  assertEquals(supabase.calls[0].name, "create_quotation_v1");
  assertEquals(
    (supabase.calls[0].args.p_payload as any).options[0].tax_amount,
    400,
  );
  assertEquals(responseBody.options[0].taxAmount, 400);
});

Deno.test("quotation create replay returns 200", async () => {
  const supabase = fakeSupabase(() => ({
    data: { id: 1, idempotent_replay: true },
  }));
  const response = await handleQuotationsRequest(
    new Request("http://localhost/quotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quotationPayload()),
    }),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
});

Deno.test("GET /quotations forwards operational filters", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: { data: [], pagination: { total: 0, limit: args.p_limit } },
  }));
  const response = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations?clientId=7&folio=COT-5000&status=expired&phone=8112345678&dateFrom=2026-08-01&dateTo=2026-08-31",
    ),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "search_quotations_v1");
  assertEquals(supabase.calls[0].args.p_status, "EXPIRED");
  assertEquals(supabase.calls[0].args.p_client_id, 7);
});

Deno.test("PUT /quotations uses optimistic version", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: { version: (args.p_payload as any).expected_version + 1 },
  }));
  const response = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations/90000000-0000-4000-8000-000000000101",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...quotationPayload(), expectedVersion: 3 }),
      },
    ),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "update_quotation_v1");
  assertEquals((supabase.calls[0].args.p_payload as any).expected_version, 3);
});

Deno.test("quotation transition maps send and reactivation", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: { status: args.p_action, valid_until: args.p_valid_until },
  }));
  const sent = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations/90000000-0000-4000-8000-000000000101/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
    ),
    supabase,
    authorization,
  );
  assertEquals(sent.status, 200);
  assertEquals(supabase.calls[0].args.p_action, "SEND");

  const reactivated = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations/90000000-0000-4000-8000-000000000101/reactivate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2, validUntil: "2026-10-01" }),
      },
    ),
    supabase,
    authorization,
  );
  assertEquals(reactivated.status, 200);
  assertEquals(supabase.calls[1].args.p_valid_until, "2026-10-01");
});

Deno.test("POST duplicate creates a new idempotent aggregate", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      external_id: args.p_new_external_id,
      idempotent_replay: false,
    },
  }));
  const response = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations/90000000-0000-4000-8000-000000000101/duplicate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalId: "90000000-0000-4000-8000-000000000201",
          validUntil: "2026-10-01",
        }),
      },
    ),
    supabase,
    authorization,
  );
  assertEquals(response.status, 201);
  assertEquals(supabase.calls[0].name, "duplicate_quotation_v1");
});

Deno.test("POST convert forwards selected option and service identity", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      quotation: { status: "ACCEPTED" },
      service: { external_id: args.p_service_external_id },
      idempotent_replay: false,
    },
  }));
  const response = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations/90000000-0000-4000-8000-000000000101/convert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionExternalId: "90000000-0000-4000-8000-000000000111",
          serviceExternalId: "90000000-0000-4000-8000-000000000301",
          expectedVersion: 2,
        }),
      },
    ),
    supabase,
    authorization,
  );
  const responseBody = await json(response);
  assertEquals(response.status, 201);
  assertEquals(supabase.calls[0].name, "convert_quotation_to_service_v1");
  assertEquals(
    supabase.calls[0].args.p_option_external_id,
    "90000000-0000-4000-8000-000000000111",
  );
  assertEquals(
    responseBody.service.externalId,
    "90000000-0000-4000-8000-000000000301",
  );
});

Deno.test("quotation conflicts are exposed as HTTP 409", async () => {
  const supabase = fakeSupabase(() => ({
    error: {
      code: "P0001",
      message: "QUOTATION_VERSION_CONFLICT current=2 expected=1",
    },
  }));
  const response = await handleQuotationsRequest(
    new Request(
      "http://localhost/quotations/90000000-0000-4000-8000-000000000101",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...quotationPayload(), expectedVersion: 1 }),
      },
    ),
    supabase,
    authorization,
  );
  assertEquals(response.status, 409);
  assertEquals((await json(response)).code, "QUOTATION_VERSION_CONFLICT");
});
