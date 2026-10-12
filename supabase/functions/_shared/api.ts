export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function positiveInteger(
  value: string | null,
  fallback?: number,
): number | null {
  if (value === null || value.trim() === "") return fallback ?? null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function nonNegativeInteger(
  value: string | null,
  fallback?: number,
): number | null {
  if (value === null || value.trim() === "") return fallback ?? null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return jsonResponse(
      {
        code: "CONTENT_TYPE_REQUIRED",
        error: "El Content-Type debe ser application/json",
      },
      400,
    );
  }

  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse(
        { code: "PAYLOAD_INVALID", error: "El cuerpo debe ser un objeto JSON" },
        400,
      );
    }
    return body as Record<string, unknown>;
  } catch (_error) {
    return jsonResponse(
      { code: "PAYLOAD_INVALID", error: "El cuerpo JSON no es válido" },
      400,
    );
  }
}

function businessErrorCode(message: string): string | null {
  const match = message.match(
    /(APP_ACTOR_FORBIDDEN|CLIENT_[A-Z0-9_]+|VEHICLE_[A-Z0-9_]+|SERVICE_[A-Z0-9_]+|QUOTATION_[A-Z0-9_]+)/,
  );
  return match?.[1] ?? null;
}

export function rpcErrorResponse(error: {
  code?: string;
  message?: string;
}): Response {
  const message = error.message || "Error al procesar la solicitud";
  const code = businessErrorCode(message) || error.code || "DATABASE_ERROR";

  if (code === "APP_ACTOR_FORBIDDEN" || error.code === "42501") {
    return jsonResponse({
      code,
      error: "El usuario no puede realizar esta operación",
    }, 403);
  }

  if (code.endsWith("_NOT_FOUND") || error.code === "P0002") {
    return jsonResponse(
      { code, error: "El recurso solicitado no existe" },
      404,
    );
  }

  if (
    code.includes("CONFLICT") || error.code === "23505" ||
    error.code === "40001"
  ) {
    return jsonResponse({ code, error: message }, 409);
  }

  if (
    code.includes("INVALID_STATE") || error.code === "55000" ||
    error.code === "23503"
  ) {
    return jsonResponse({ code, error: message }, 422);
  }

  if (
    error.code === "22023" || error.code === "22007" ||
    error.code === "22003" || error.code === "22P02" ||
    error.code === "23502" ||
    error.code === "23514" || code.endsWith("_INVALID") ||
    code.endsWith("_REQUIRED") || code.endsWith("_MUST_BE_ARRAY")
  ) {
    return jsonResponse({ code, error: message }, 400);
  }

  return jsonResponse(
    { code: "DATABASE_ERROR", error: "Error al procesar la solicitud" },
    500,
  );
}
