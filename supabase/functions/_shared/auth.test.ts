import { requireAppRole } from "./auth.ts";

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

function fakeSupabase(options: {
  authUserId?: string;
  authError?: boolean;
  appUser?: any;
  appUserError?: boolean;
}) {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({
      data: options.appUser ?? null,
      error: options.appUserError ? { message: "query failed" } : null,
    }),
  };

  return {
    auth: {
      getUser: async () => ({
        data: {
          user: options.authUserId ? { id: options.authUserId } : null,
        },
        error: options.authError ? { message: "invalid" } : null,
      }),
    },
    from: () => query,
  };
}

async function responseBody(result: unknown): Promise<any> {
  assert(result instanceof Response, "Expected an HTTP error response");
  return await result.json();
}

Deno.test("requireAppRole rejects a missing bearer token", async () => {
  const result = await requireAppRole(
    new Request("http://localhost"),
    fakeSupabase({}),
    ["ADMINISTRADOR"],
  );

  assert(result instanceof Response, "Expected a response");
  assertEquals(result.status, 401);
  assertEquals(await responseBody(result), {
    error: "Falta un token Bearer válido",
  });
});

Deno.test("requireAppRole rejects a token without an active app user", async () => {
  const result = await requireAppRole(
    new Request("http://localhost", {
      headers: { Authorization: "Bearer valid-token" },
    }),
    fakeSupabase({ authUserId: "auth-user" }),
    ["ADMINISTRADOR", "EMPLEADO"],
  );

  assert(result instanceof Response, "Expected a response");
  assertEquals(result.status, 403);
});

Deno.test("requireAppRole rejects an employee from an admin operation", async () => {
  const result = await requireAppRole(
    new Request("http://localhost", {
      headers: { Authorization: "Bearer valid-token" },
    }),
    fakeSupabase({
      authUserId: "auth-user",
      appUser: {
        active: true,
        role: { description: "EMPLEADO", active: true },
      },
    }),
    ["ADMINISTRADOR"],
  );

  assert(result instanceof Response, "Expected a response");
  assertEquals(result.status, 403);
});

Deno.test("requireAppRole returns the validated user and role", async () => {
  const result = await requireAppRole(
    new Request("http://localhost", {
      headers: { Authorization: "Bearer valid-token" },
    }),
    fakeSupabase({
      authUserId: "auth-user",
      appUser: {
        active: true,
        role: { description: "ADMINISTRADOR", active: true },
      },
    }),
    ["ADMINISTRADOR"],
  );

  assert(!(result instanceof Response), "Expected authorization context");
  assertEquals(result, { userId: "auth-user", role: "ADMINISTRADOR" });
});
