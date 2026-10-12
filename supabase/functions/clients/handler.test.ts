import { handleClientsRequest } from "./handler.ts";
import { validateClientPayload } from "./validation.ts";

const authorization = {
  userId: "81111111-1111-4111-8111-111111111111",
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
  resolver: (name: string, args: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: resolver(name, args), error: null };
    },
  };
}

async function body(response: Response): Promise<any> {
  return await response.json();
}

Deno.test("client validation accepts several vehicles", () => {
  const result = validateClientPayload({
    externalId: "80000000-0000-4000-8000-000000000001",
    clientName: "Cliente",
    phoneNumber: "8112345678",
    vehicles: [
      {
        externalId: "80000000-0000-4000-8000-000000000002",
        carModelId: 10,
        modelYear: 2019,
      },
      {
        externalId: "80000000-0000-4000-8000-000000000003",
        carModelId: 11,
        modelYear: 2020,
      },
    ],
  });
  assert(result.ok, "Expected a valid aggregate");
});

Deno.test("secondary phone is optional but rejects invalid types and short numbers", () => {
  for (const secondaryPhoneNumber of [null, "", "81 1234 5678"]) {
    assert(validateClientPayload({ clientId: 1, secondaryPhoneNumber }).ok, "Valid second phone");
  }
  for (const secondaryPhoneNumber of [123, "123", [], {}]) {
    assert(!validateClientPayload({ clientId: 1, secondaryPhoneNumber }).ok, "Reject invalid second phone");
  }
});

Deno.test("PATCH changes only the second phone and forwards actor", async () => {
  const supabase = fakeSupabase(() => ({ id: 10, secondary_phone_number: "8112345678" }));
  const response = await handleClientsRequest(new Request("http://localhost/clients/10", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secondaryPhoneNumber: "8112345678" }),
  }), supabase, authorization);
  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].args, { p_payload: { secondary_phone_number: "8112345678", client_id: 10 }, p_actor_user_id: authorization.userId });
  assertEquals((await response.json()).secondaryPhoneNumber, "8112345678");
});

Deno.test("PATCH rejects changing primary phone and can clear secondary phone", async () => {
  const supabase = fakeSupabase(() => ({ id: 10, secondary_phone_number: null }));
  const request = (payload: object) => new Request("http://localhost/clients/10", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  assertEquals((await handleClientsRequest(request({ phoneNumber: "8112345678" }), supabase, authorization)).status, 400);
  assertEquals(supabase.calls.length, 0);
  assertEquals((await handleClientsRequest(request({ secondaryPhoneNumber: null }), supabase, authorization)).status, 200);
});

Deno.test("client validation requires stable offline identity", () => {
  const result = validateClientPayload({
    clientName: "Cliente",
    phoneNumber: "8112345678",
  });
  assert(!result.ok, "Expected validation to fail");
  assert(
    result.errors.some((error) => error.field === "externalId"),
    "Expected externalId error",
  );
});

Deno.test("POST /clients sends snake_case aggregate and actor to RPC", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    id: 10,
    external_id: (args.p_payload as any).external_id,
    reconciled_by_phone: false,
    vehicles: [],
  }));
  const response = await handleClientsRequest(
    new Request("http://localhost/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalId: "80000000-0000-4000-8000-000000000001",
        clientName: "Cliente",
        phoneNumber: "8112345678",
        vehicles: [],
      }),
    }),
    supabase,
    authorization,
  );

  assertEquals(response.status, 201);
  assertEquals(supabase.calls[0].name, "save_client_with_vehicles_v1");
  assertEquals(supabase.calls[0].args.p_actor_user_id, authorization.userId);
  assertEquals(
    (supabase.calls[0].args.p_payload as any).client_name,
    "Cliente",
  );
  assertEquals((await body(response)).reconciledByPhone, false);
});

Deno.test("POST existing client vehicle route appends a vehicle", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    id: (args.p_payload as any).client_id,
    reconciled_by_phone: false,
    vehicles: [],
  }));
  const response = await handleClientsRequest(
    new Request("http://localhost/clients/22/vehicles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicle: {
          externalId: "80000000-0000-4000-8000-000000000004",
          modelYear: 2018,
        },
      }),
    }),
    supabase,
    authorization,
  );

  assertEquals(response.status, 200);
  assertEquals((supabase.calls[0].args.p_payload as any).client_id, 22);
  assertEquals((supabase.calls[0].args.p_payload as any).vehicles.length, 1);
});

Deno.test("GET /clients forwards model and year search filters", async () => {
  const supabase = fakeSupabase((_name, args) => ({
    data: [],
    pagination: { total: 0, limit: args.p_limit, offset: args.p_offset },
  }));
  const response = await handleClientsRequest(
    new Request(
      "http://localhost/clients?q=Versa%202019&carModelId=8&modelYear=2019&limit=20",
    ),
    supabase,
    authorization,
  );

  assertEquals(response.status, 200);
  assertEquals(supabase.calls[0].name, "search_clients_v1");
  assertEquals(supabase.calls[0].args.p_query, "Versa 2019");
  assertEquals(supabase.calls[0].args.p_car_model_id, 8);
  assertEquals(supabase.calls[0].args.p_model_year, 2019);
});

Deno.test("phone reconciliation returns 200 instead of creating a duplicate", async () => {
  const supabase = fakeSupabase(() => ({
    id: 10,
    reconciled_by_phone: true,
    vehicles: [],
  }));
  const response = await handleClientsRequest(
    new Request("http://localhost/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalId: "80000000-0000-4000-8000-000000000009",
        clientName: "Nombre offline",
        phoneNumber: "8112345678",
      }),
    }),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
});

Deno.test("same client externalId replay returns 200", async () => {
  const supabase = fakeSupabase(() => ({
    id: 10,
    reconciled_by_phone: false,
    idempotent_replay: true,
    vehicles: [],
  }));
  const response = await handleClientsRequest(
    new Request("http://localhost/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalId: "80000000-0000-4000-8000-000000000001",
        clientName: "Cliente",
        phoneNumber: "8112345678",
      }),
    }),
    supabase,
    authorization,
  );
  assertEquals(response.status, 200);
  assertEquals((await body(response)).idempotentReplay, true);
});
