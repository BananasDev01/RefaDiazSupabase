import type { AppAuthorization } from "../_shared/auth.ts";
import {
  isUuid,
  jsonResponse,
  nonNegativeInteger,
  positiveInteger,
  readJsonObject,
  rpcErrorResponse,
} from "../_shared/api.ts";
import { convertToCamelCase, convertToSnakeCase } from "../_shared/utils.ts";
import {
  validateServicePayload,
  validateTransitionPayload,
} from "./validation.ts";

function routeSegments(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("services");
  return functionIndex >= 0 ? parts.slice(functionIndex + 1) : [];
}

function validationResponse(
  errors: Array<{ field: string; message: string }>,
): Response {
  return jsonResponse(
    { code: "VALIDATION_ERROR", error: "Datos inválidos", details: errors },
    400,
  );
}

function validIsoDate(value: string | null): boolean {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function stripInternalNotes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalNotes);
  if (!value || typeof value !== "object") return value;

  const publicValue: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "internalNotes" || key === "internal_notes") continue;
    publicValue[key] = stripInternalNotes(child);
  }
  return publicValue;
}

function publicServiceResponse(data: unknown): unknown {
  return stripInternalNotes(convertToCamelCase(data));
}

async function handleServiceList(url: URL, supabase: any): Promise<Response> {
  const limit = positiveInteger(url.searchParams.get("limit"), 50);
  const offset = nonNegativeInteger(url.searchParams.get("offset"), 0);
  const clientId = positiveInteger(url.searchParams.get("clientId"));
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const status = url.searchParams.get("status")?.toUpperCase() ?? null;
  const category = url.searchParams.get("category")?.toUpperCase() ?? null;

  if (limit === null || offset === null) {
    return jsonResponse({
      code: "PAGINATION_INVALID",
      error: "La paginación no es válida",
    }, 400);
  }
  if (url.searchParams.has("clientId") && clientId === null) {
    return jsonResponse({
      code: "CLIENT_ID_INVALID",
      error: "clientId no es válido",
    }, 400);
  }
  if (!validIsoDate(dateFrom) || !validIsoDate(dateTo)) {
    return jsonResponse({
      code: "DATE_FILTER_INVALID",
      error: "Las fechas deben usar YYYY-MM-DD",
    }, 400);
  }
  if (
    status !== null &&
    !["IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(status)
  ) {
    return jsonResponse({
      code: "STATUS_INVALID",
      error: "El estado no es válido",
    }, 400);
  }
  if (category !== null && !["VEHICLE", "PART"].includes(category)) {
    return jsonResponse({
      code: "CATEGORY_INVALID",
      error: "La categoría no es válida",
    }, 400);
  }

  const { data, error } = await supabase.rpc("search_services_v1", {
    p_folio: url.searchParams.get("folio"),
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_phone: url.searchParams.get("phone"),
    p_plate: url.searchParams.get("plate"),
    p_query: url.searchParams.get("q"),
    p_category: category,
    p_status: status,
    p_client_id: clientId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) return rpcErrorResponse(error);
  return jsonResponse(publicServiceResponse(data));
}

async function handleServiceDetail(
  identifier: string,
  supabase: any,
): Promise<Response> {
  const serviceId = positiveInteger(identifier);
  const externalId = isUuid(identifier) ? identifier : null;
  if (serviceId === null && externalId === null) {
    return jsonResponse({
      code: "SERVICE_ID_INVALID",
      error: "El identificador no es válido",
    }, 400);
  }

  const { data, error } = await supabase.rpc("get_service_v1", {
    p_service_id: serviceId,
    p_external_id: externalId,
  });
  if (error) return rpcErrorResponse(error);
  return jsonResponse(publicServiceResponse(data));
}

async function handleFailureCatalog(supabase: any): Promise<Response> {
  const { data, error } = await supabase
    .from("reported_failure_type")
    .select("id, code, label, display_order, allows_free_text, active")
    .eq("active", true)
    .order("display_order", { ascending: true });
  if (error) return rpcErrorResponse(error);
  return jsonResponse(convertToCamelCase(data));
}

export async function handleServicesRequest(
  req: Request,
  supabase: any,
  authorization: AppAuthorization,
): Promise<Response> {
  const url = new URL(req.url);
  const segments = routeSegments(url);

  if (req.method === "GET") {
    if (segments.length === 1 && segments[0] === "failure-types") {
      return await handleFailureCatalog(supabase);
    }
    if (segments.length === 1) {
      return await handleServiceDetail(segments[0], supabase);
    }
    if (segments.length > 1) {
      return jsonResponse({
        code: "ROUTE_NOT_FOUND",
        error: "Ruta no encontrada",
      }, 404);
    }

    const identifier = url.searchParams.get("externalId") ??
      url.searchParams.get("id");
    if (identifier) return await handleServiceDetail(identifier, supabase);
    return await handleServiceList(url, supabase);
  }

  if (req.method === "POST" && segments.length === 0) {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const validation = validateServicePayload(body, "create");
    if (!validation.ok) return validationResponse(validation.errors);

    const { data, error } = await supabase.rpc("create_service_v1", {
      p_payload: convertToSnakeCase(body),
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    const response = publicServiceResponse(data) as Record<string, unknown>;
    return jsonResponse(
      response,
      response.idempotentReplay === true ? 200 : 201,
    );
  }

  if (req.method === "PUT" && segments.length === 1) {
    if (!isUuid(segments[0])) {
      return jsonResponse({
        code: "SERVICE_ID_INVALID",
        error: "El externalId no es válido",
      }, 400);
    }
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    body.externalId = segments[0];
    const validation = validateServicePayload(body, "update");
    if (!validation.ok) return validationResponse(validation.errors);

    const { data, error } = await supabase.rpc("update_service_v1", {
      p_payload: convertToSnakeCase(body),
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    return jsonResponse(publicServiceResponse(data));
  }

  if (
    req.method === "POST" && segments.length === 2 &&
    ["start", "complete", "cancel"].includes(segments[1])
  ) {
    if (!isUuid(segments[0])) {
      return jsonResponse({
        code: "SERVICE_ID_INVALID",
        error: "El externalId no es válido",
      }, 400);
    }
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const action = segments[1] as "start" | "complete" | "cancel";
    const validation = validateTransitionPayload(body, action);
    if (!validation.ok) return validationResponse(validation.errors);

    const { data, error } = await supabase.rpc("transition_service_v1", {
      p_external_id: segments[0],
      p_expected_version: body.expectedVersion,
      p_action: segments[1] === "start"
        ? "START"
        : segments[1] === "complete"
        ? "COMPLETE"
        : "CANCEL",
      p_actor_user_id: authorization.userId,
      p_reason: action === "cancel" ? (body.reason as string).trim() : null,
    });
    if (error) return rpcErrorResponse(error);
    return jsonResponse(publicServiceResponse(data));
  }

  if (["GET", "POST", "PUT"].includes(req.method)) {
    return jsonResponse({
      code: "ROUTE_NOT_FOUND",
      error: "Ruta no encontrada",
    }, 404);
  }
  return jsonResponse({
    code: "METHOD_NOT_ALLOWED",
    error: "Método no permitido",
  }, 405);
}
