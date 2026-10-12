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
  validateConversionPayload,
  validateDuplicatePayload,
  validateQuotationPayload,
  validateVersionPayload,
  validIsoDate,
} from "./validation.ts";

function routeSegments(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf("quotations");
  return index >= 0 ? parts.slice(index + 1) : [];
}

function validationResponse(errors: Array<{ field: string; message: string }>) {
  return jsonResponse({
    code: "VALIDATION_ERROR",
    error: "Datos inválidos",
    details: errors,
  }, 400);
}

async function quotationDetail(
  identifier: string,
  supabase: any,
): Promise<Response> {
  const quotationId = positiveInteger(identifier);
  const externalId = isUuid(identifier) ? identifier : null;
  if (quotationId === null && externalId === null) {
    return jsonResponse({
      code: "QUOTATION_ID_INVALID",
      error: "El identificador no es válido",
    }, 400);
  }
  const { data, error } = await supabase.rpc("get_quotation_v1", {
    p_quotation_id: quotationId,
    p_external_id: externalId,
  });
  if (error) return rpcErrorResponse(error);
  return jsonResponse(convertToCamelCase(data));
}

async function quotationList(url: URL, supabase: any): Promise<Response> {
  const limit = positiveInteger(url.searchParams.get("limit"), 50);
  const offset = nonNegativeInteger(url.searchParams.get("offset"), 0);
  const clientId = positiveInteger(url.searchParams.get("clientId"));
  const status = url.searchParams.get("status")?.toUpperCase() ?? null;
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  if (
    limit === null || offset === null ||
    (url.searchParams.has("clientId") && clientId === null)
  ) {
    return jsonResponse({
      code: "PAGINATION_INVALID",
      error: "Los filtros numéricos no son válidos",
    }, 400);
  }
  if (!validIsoDate(dateFrom) || !validIsoDate(dateTo)) {
    return jsonResponse({
      code: "DATE_FILTER_INVALID",
      error: "Las fechas deben usar YYYY-MM-DD",
    }, 400);
  }
  if (
    status &&
    !["DRAFT", "SENT", "ACCEPTED", "EXPIRED", "CANCELLED"].includes(status)
  ) {
    return jsonResponse({
      code: "STATUS_INVALID",
      error: "El estado no es válido",
    }, 400);
  }
  const { data, error } = await supabase.rpc("search_quotations_v1", {
    p_folio: url.searchParams.get("folio"),
    p_client_id: clientId,
    p_status: status,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_phone: url.searchParams.get("phone"),
    p_limit: limit,
    p_offset: offset,
  });
  if (error) return rpcErrorResponse(error);
  return jsonResponse(convertToCamelCase(data));
}

export async function handleQuotationsRequest(
  req: Request,
  supabase: any,
  authorization: AppAuthorization,
): Promise<Response> {
  const url = new URL(req.url);
  const segments = routeSegments(url);

  if (req.method === "GET") {
    if (segments.length === 1) {
      return await quotationDetail(segments[0], supabase);
    }
    if (segments.length > 1) {
      return jsonResponse({
        code: "ROUTE_NOT_FOUND",
        error: "Ruta no encontrada",
      }, 404);
    }
    return await quotationList(url, supabase);
  }

  if (req.method === "POST" && segments.length === 0) {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const validation = validateQuotationPayload(body, "create");
    if (!validation.ok) return validationResponse(validation.errors);
    const { data, error } = await supabase.rpc("create_quotation_v1", {
      p_payload: convertToSnakeCase(body),
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    const response = convertToCamelCase(data) as Record<string, unknown>;
    return jsonResponse(
      response,
      response.idempotentReplay === true ? 200 : 201,
    );
  }

  if (req.method === "PUT" && segments.length === 1) {
    if (!isUuid(segments[0])) {
      return jsonResponse({
        code: "QUOTATION_ID_INVALID",
        error: "El externalId no es válido",
      }, 400);
    }
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    body.externalId = segments[0];
    const validation = validateQuotationPayload(body, "update");
    if (!validation.ok) return validationResponse(validation.errors);
    const { data, error } = await supabase.rpc("update_quotation_v1", {
      p_payload: convertToSnakeCase(body),
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    return jsonResponse(convertToCamelCase(data));
  }

  if (
    req.method === "POST" && segments.length === 2 &&
    ["send", "cancel", "reactivate"].includes(segments[1])
  ) {
    if (!isUuid(segments[0])) {
      return jsonResponse({
        code: "QUOTATION_ID_INVALID",
        error: "El externalId no es válido",
      }, 400);
    }
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const validation = validateVersionPayload(body);
    if (!validation.ok) return validationResponse(validation.errors);
    if (
      segments[1] === "reactivate" &&
      (typeof body.validUntil !== "string" ||
        !validIsoDate(body.validUntil))
    ) {
      return validationResponse([{
        field: "validUntil",
        message: "Debe usar el formato YYYY-MM-DD",
      }]);
    }
    const { data, error } = await supabase.rpc("transition_quotation_v1", {
      p_external_id: segments[0],
      p_expected_version: body.expectedVersion,
      p_action: segments[1].toUpperCase(),
      p_valid_until: body.validUntil ?? null,
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    return jsonResponse(convertToCamelCase(data));
  }

  if (
    req.method === "POST" && segments.length === 2 &&
    segments[1] === "duplicate"
  ) {
    if (!isUuid(segments[0])) {
      return jsonResponse({
        code: "QUOTATION_ID_INVALID",
        error: "El externalId no es válido",
      }, 400);
    }
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const validation = validateDuplicatePayload(body);
    if (!validation.ok) return validationResponse(validation.errors);
    const { data, error } = await supabase.rpc("duplicate_quotation_v1", {
      p_source_external_id: segments[0],
      p_new_external_id: body.externalId,
      p_provisional_reference: body.provisionalReference ?? null,
      p_quotation_date: body.quotationDate ?? null,
      p_valid_until: body.validUntil ?? null,
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    const response = convertToCamelCase(data) as Record<string, unknown>;
    return jsonResponse(
      response,
      response.idempotentReplay === true ? 200 : 201,
    );
  }

  if (
    req.method === "POST" && segments.length === 2 && segments[1] === "convert"
  ) {
    if (!isUuid(segments[0])) {
      return jsonResponse({
        code: "QUOTATION_ID_INVALID",
        error: "El externalId no es válido",
      }, 400);
    }
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const validation = validateConversionPayload(body);
    if (!validation.ok) return validationResponse(validation.errors);
    const { data, error } = await supabase.rpc(
      "convert_quotation_to_service_v1",
      {
        p_quotation_external_id: segments[0],
        p_option_external_id: body.optionExternalId,
        p_expected_version: body.expectedVersion,
        p_service_external_id: body.serviceExternalId,
        p_service_provisional_reference: body.serviceProvisionalReference ??
          null,
        p_service_date: body.serviceDate ?? null,
        p_actor_user_id: authorization.userId,
      },
    );
    if (error) return rpcErrorResponse(error);
    const response = convertToCamelCase(data) as Record<string, unknown>;
    return jsonResponse(
      response,
      response.idempotentReplay === true ? 200 : 201,
    );
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
