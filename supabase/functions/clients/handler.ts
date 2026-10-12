import type { AppAuthorization } from "../_shared/auth.ts";
import {
  jsonResponse,
  nonNegativeInteger,
  positiveInteger,
  readJsonObject,
  rpcErrorResponse,
} from "../_shared/api.ts";
import { convertToCamelCase, convertToSnakeCase } from "../_shared/utils.ts";
import { validateClientPayload } from "./validation.ts";

function routeSegments(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("clients");
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

export async function handleClientsRequest(
  req: Request,
  supabase: any,
  authorization: AppAuthorization,
): Promise<Response> {
  const url = new URL(req.url);
  const segments = routeSegments(url);

  if (req.method === "PATCH" && segments.length === 1) {
    const clientId = positiveInteger(segments[0]);
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (!clientId || !Object.hasOwn(body, "secondaryPhoneNumber") || Object.keys(body).some((key) => key !== "secondaryPhoneNumber")) {
      return validationResponse([{ field: "secondaryPhoneNumber", message: "Solo se permite actualizar el segundo teléfono" }]);
    }
    const validation = validateClientPayload({ ...body, clientId });
    if (!validation.ok) return validationResponse(validation.errors);
    const { data, error } = await supabase.rpc("save_client_with_vehicles_v1", {
      p_payload: convertToSnakeCase({ ...body, clientId }),
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);
    return jsonResponse(convertToCamelCase(data));
  }

  if (req.method === "GET") {
    const pathId = segments.length === 1 ? positiveInteger(segments[0]) : null;
    const queryId = positiveInteger(url.searchParams.get("id"));
    const clientId = pathId ?? queryId;

    if (segments.length > 0 && clientId === null) {
      return jsonResponse({
        code: "CLIENT_ID_INVALID",
        error: "El id del cliente no es válido",
      }, 400);
    }

    if (clientId !== null) {
      const { data, error } = await supabase.rpc("client_public_json_v1", {
        p_client_id: clientId,
      });
      if (error) return rpcErrorResponse(error);
      if (!data) {
        return jsonResponse({
          code: "CLIENT_NOT_FOUND",
          error: "El cliente no existe",
        }, 404);
      }
      return jsonResponse(convertToCamelCase(data));
    }

    const limit = positiveInteger(url.searchParams.get("limit"), 50);
    const offset = nonNegativeInteger(url.searchParams.get("offset"), 0);
    const carModelId = positiveInteger(url.searchParams.get("carModelId"));
    const modelYear = positiveInteger(url.searchParams.get("modelYear"));
    if (limit === null || offset === null) {
      return jsonResponse({
        code: "PAGINATION_INVALID",
        error: "La paginación no es válida",
      }, 400);
    }
    if (url.searchParams.has("carModelId") && carModelId === null) {
      return jsonResponse({
        code: "CAR_MODEL_ID_INVALID",
        error: "carModelId no es válido",
      }, 400);
    }
    if (url.searchParams.has("modelYear") && modelYear === null) {
      return jsonResponse({
        code: "MODEL_YEAR_INVALID",
        error: "modelYear no es válido",
      }, 400);
    }

    const { data, error } = await supabase.rpc("search_clients_v1", {
      p_query: url.searchParams.get("q"),
      p_phone: url.searchParams.get("phone"),
      p_car_model_id: carModelId,
      p_model_year: modelYear,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) return rpcErrorResponse(error);
    return jsonResponse(convertToCamelCase(data));
  }

  if (req.method === "POST") {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;

    if (segments.length === 2 && segments[1] === "vehicles") {
      const clientId = positiveInteger(segments[0]);
      if (clientId === null) {
        return jsonResponse({
          code: "CLIENT_ID_INVALID",
          error: "El id del cliente no es válido",
        }, 400);
      }
      body.clientId = clientId;
      if (body.vehicle !== undefined && body.vehicles === undefined) {
        body.vehicles = [body.vehicle];
        delete body.vehicle;
      }
    } else if (segments.length > 0) {
      return jsonResponse({
        code: "ROUTE_NOT_FOUND",
        error: "Ruta no encontrada",
      }, 404);
    }

    const validation = validateClientPayload(body);
    if (!validation.ok) return validationResponse(validation.errors);

    const { data, error } = await supabase.rpc("save_client_with_vehicles_v1", {
      p_payload: convertToSnakeCase(body),
      p_actor_user_id: authorization.userId,
    });
    if (error) return rpcErrorResponse(error);

    const response = convertToCamelCase<Record<string, unknown>>(data);
    const reconciled = response.reconciledByPhone === true ||
      response.idempotentReplay === true ||
      body.clientId !== undefined;
    return jsonResponse(response, reconciled ? 200 : 201);
  }

  return jsonResponse({
    code: "METHOD_NOT_ALLOWED",
    error: "Método no permitido",
  }, 405);
}
