import { handleServicesRequest } from "./handler.ts";
import { validateServicePayload } from "./validation.ts";

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

async function body(response: Response): Promise<any> {
  return await response.json();
}

function createPayload() {
  return {
    externalId: "90000000-0000-4000-8000-000000000001",
    provisionalReference: "PEND-SER-TEST",
    clientVehicleId: 12,
    subtotal: 1000,
    taxAmount: 160,
    reportedFailures: [{
      externalId: "90000000-0000-4000-8000-000000000002",
      reportedFailureTypeId: 1,
    }],
    internalNotes: [{
      externalId: "90000000-0000-4000-8000-000000000003",
      note: "No mostrar",
    }],
  };
}

Deno.test("service validation requires explicit IVA amount", () => {
  const payload = createPayload();
  delete (payload as any).taxAmount;
  const result = validateServicePayload(payload, "create");
  assert(!result.ok, "Expected validation failure");
  assert(
    result.errors.some((error) => error.field === "taxAmount"),
    "Expected taxAmount error",
  );
});

Deno.test("service validation accepts optional warranty and zero subtotal", () => {
  const result = validateServicePayload(
    { ...createPayload(), subtotal: 0, taxAmount: 0, warrantyMonths: 6 },
    "create",
  );
  assert(result.ok, "Expected a valid service payload");
});

Deno.test("POST /services creates aggregate and strips private notes", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      external_id: (args.p_payload as any).external_id,
      total: 1160,
      idempotent_replay: false,
      internal_notes: [{ note: "No mostrar" }],
    },
  }));
  const response = await handleServicesRequest(
    new Request("http://localhost/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload()),
    }),
    supabase,
    authorization,
  );
  const responseBody = await body(response);

  assertEquals(response.status, 201);
  assertEquals(supabase.calls[0].name, "create_service_v1");
  assertEquals((supabase.calls[0].args.p_payload as any).tax_amount, 160);
  assertEquals(supabase.calls[0].args.p_actor_user_id, authorization.userId);
  assert(!("internalNotes" in responseBody), "Private notes must be stripped");
});

Deno.test("idempotent service creation replay returns 200", async () => {
  const supabase = fakeSupabase(() => ({
    data: { id: 1, idempotent_replay: true },
  }));
  const response = await handleServicesRequest(
    new Request("http://localhost/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload()),
    }),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
});

Deno.test("GET /services forwards history and operational filters", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      data: [],
      pagination: { total: 0, limit: args.p_limit, offset: args.p_offset },
    },
  }));
  const response = await handleServicesRequest(
    new Request(
      "http://localhost/services?clientId=7&folio=SER-5000&phone=8112345678&plate=ABC123&status=completed&dateFrom=2026-08-01&dateTo=2026-08-31&q=nissan%20gris&category=part",
    ),
    supabase,
    authorization,
  );

  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "search_services_v1");
  assertEquals(supabase.calls[0].args.p_client_id, 7);
  assertEquals(supabase.calls[0].args.p_status, "COMPLETED");
  assertEquals(supabase.calls[0].args.p_folio, "SER-5000");
  assertEquals(supabase.calls[0].args.p_query, "nissan gris");
  assertEquals(supabase.calls[0].args.p_category, "PART");
});

Deno.test("GET service detail strips private notes defensively", async () => {
  const supabase = fakeSupabase(() => ({
    data: {
      external_id: "90000000-0000-4000-8000-000000000001",
      internal_notes: [{ note: "Privada" }],
      reported_failures: [],
    },
  }));
  const response = await handleServicesRequest(
    new Request(
      "http://localhost/services/90000000-0000-4000-8000-000000000001",
    ),
    supabase,
    authorization,
  );
  const responseBody = await body(response);
  assertEquals(response.status, 200);
  assert(!("internalNotes" in responseBody), "Private notes must be absent");
  assertEquals(responseBody.reportedFailures, []);
});

Deno.test("PUT /services uses optimistic version", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: { version: (args.p_payload as any).expected_version + 1 },
  }));
  const response = await handleServicesRequest(
    new Request(
      "http://localhost/services/90000000-0000-4000-8000-000000000001",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...createPayload(), expectedVersion: 3 }),
      },
    ),
    supabase,
    authorization,
  );

  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "update_service_v1");
  assertEquals((supabase.calls[0].args.p_payload as any).expected_version, 3);
});

Deno.test("POST complete maps to controlled transition", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      status: "COMPLETED",
      version: (args.p_expected_version as number) + 1,
    },
  }));
  const response = await handleServicesRequest(
    new Request(
      "http://localhost/services/90000000-0000-4000-8000-000000000001/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    ),
    supabase,
    authorization,
  );

  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "transition_service_v1");
  assertEquals(supabase.calls[0].args.p_action, "COMPLETE");
});

Deno.test("POST cancel requires a reason and forwards it", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      status: "CANCELLED",
      version: (args.p_expected_version as number) + 1,
    },
  }));
  const request = (payload: Record<string, unknown>) =>
    new Request(
      "http://localhost/services/90000000-0000-4000-8000-000000000001/cancel",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

  const missing = await handleServicesRequest(
    request({ expectedVersion: 2 }),
    supabase,
    authorization,
  );
  assertEquals(missing.status, 400);
  assertEquals(supabase.calls.length, 0);

  const response = await handleServicesRequest(
    request({ expectedVersion: 2, reason: "  Capturada por error " }),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].args.p_action, "CANCEL");
  assertEquals(supabase.calls[0].args.p_reason, "Capturada por error");
});

Deno.test("POST start promotes a draft to in progress", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: {
      status: "IN_PROGRESS",
      version: (args.p_expected_version as number) + 1,
    },
  }));
  const response = await handleServicesRequest(
    new Request(
      "http://localhost/services/90000000-0000-4000-8000-000000000001/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
    ),
    supabase,
    authorization,
  );

  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "transition_service_v1");
  assertEquals(supabase.calls[0].args.p_action, "START");
});

Deno.test("optimistic conflict is exposed as HTTP 409", async () => {
  const supabase = fakeSupabase(() => ({
    error: {
      code: "P0001",
      message: "SERVICE_VERSION_CONFLICT current=4 expected=3",
    },
  }));
  const response = await handleServicesRequest(
    new Request(
      "http://localhost/services/90000000-0000-4000-8000-000000000001",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...createPayload(), expectedVersion: 3 }),
      },
    ),
    supabase,
    authorization,
  );
  assertEquals(response.status, 409);
  assertEquals((await body(response)).code, "SERVICE_VERSION_CONFLICT");
});
