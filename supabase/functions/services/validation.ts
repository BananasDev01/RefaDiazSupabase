import { isUuid } from "../_shared/api.ts";
import type { ValidationResult } from "../clients/validation.ts";

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validMoney(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= 9_999_999_999.99 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function validateAggregateCollections(
  payload: Record<string, unknown>,
  errors: Array<{ field: string; message: string }>,
): void {
  if (
    payload.reportedFailures !== undefined &&
    !Array.isArray(payload.reportedFailures)
  ) {
    errors.push({ field: "reportedFailures", message: "Debe ser un arreglo" });
  }
  if (Array.isArray(payload.reportedFailures)) {
    payload.reportedFailures.forEach((candidate, index) => {
      const field = `reportedFailures[${index}]`;
      if (
        !candidate || typeof candidate !== "object" || Array.isArray(candidate)
      ) {
        errors.push({ field, message: "Debe ser un objeto" });
        return;
      }
      const failure = candidate as Record<string, unknown>;
      if (!isUuid(failure.externalId)) {
        errors.push({
          field: `${field}.externalId`,
          message: "Debe ser un UUID válido",
        });
      }
      if (!positiveInteger(failure.reportedFailureTypeId)) {
        errors.push({
          field: `${field}.reportedFailureTypeId`,
          message: "Debe ser un entero positivo",
        });
      }
      if (
        failure.otherText !== undefined && failure.otherText !== null &&
        (typeof failure.otherText !== "string" || !failure.otherText.trim())
      ) {
        errors.push({
          field: `${field}.otherText`,
          message: "No puede estar vacío",
        });
      }
      if (
        failure.amount !== undefined && failure.amount !== null &&
        !validMoney(failure.amount)
      ) {
        errors.push({
          field: `${field}.amount`,
          message: "Debe ser un importe no negativo con máximo dos decimales",
        });
      }
      if (
        failure.observation !== undefined && failure.observation !== null &&
        (typeof failure.observation !== "string" ||
          failure.observation.length > 4000)
      ) {
        errors.push({
          field: `${field}.observation`,
          message: "Debe ser texto de máximo 4000 caracteres",
        });
      }
      if (
        payload.lineTotalsMode == null &&
        ("amount" in failure || "observation" in failure)
      ) {
        errors.push({
          field: "lineTotalsMode",
          message: "Es obligatorio para guardar renglones estructurados",
        });
      }
      if (payload.lineTotalsMode === "LEGACY" && failure.amount != null) {
        errors.push({
          field: `${field}.amount`,
          message: "Usa LINES para calcular importes por renglón",
        });
      }
    });
  }

  if (
    payload.internalNotes !== undefined && !Array.isArray(payload.internalNotes)
  ) {
    errors.push({ field: "internalNotes", message: "Debe ser un arreglo" });
  }
  if (Array.isArray(payload.internalNotes)) {
    payload.internalNotes.forEach((candidate, index) => {
      const field = `internalNotes[${index}]`;
      if (
        !candidate || typeof candidate !== "object" || Array.isArray(candidate)
      ) {
        errors.push({ field, message: "Debe ser un objeto" });
        return;
      }
      const note = candidate as Record<string, unknown>;
      if (!isUuid(note.externalId)) {
        errors.push({
          field: `${field}.externalId`,
          message: "Debe ser un UUID válido",
        });
      }
      if (typeof note.note !== "string" || !note.note.trim()) {
        errors.push({ field: `${field}.note`, message: "Es obligatoria" });
      }
    });
  }
}

export function validateServicePayload(
  payload: Record<string, unknown>,
  mode: "create" | "update",
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  if (
    payload.lineTotalsMode != null &&
    !["LINES", "LEGACY"].includes(payload.lineTotalsMode as string)
  ) {
    errors.push({
      field: "lineTotalsMode",
      message: "Debe ser LINES o LEGACY",
    });
  }

  if (!isUuid(payload.externalId)) {
    errors.push({ field: "externalId", message: "Debe ser un UUID válido" });
  }
  const category = payload.category ?? "VEHICLE";
  if (!["VEHICLE", "PART"].includes(category as string)) {
    errors.push({ field: "category", message: "Debe ser VEHICLE o PART" });
  }
  if (category === "PART") {
    // A loose part belongs to the client; there is no vehicle to record.
    if (!positiveInteger(payload.clientId)) {
      errors.push({
        field: "clientId",
        message: "Debe ser un entero positivo",
      });
    }
    if (
      payload.partDescription !== undefined &&
      payload.partDescription !== null &&
      (typeof payload.partDescription !== "string" ||
        payload.partDescription.length > 500)
    ) {
      errors.push({
        field: "partDescription",
        message: "Debe ser texto de máximo 500 caracteres",
      });
    }
  } else if (!positiveInteger(payload.clientVehicleId)) {
    errors.push({
      field: "clientVehicleId",
      message: "Debe ser un entero positivo",
    });
  }
  if (!validMoney(payload.taxAmount)) {
    errors.push({
      field: "taxAmount",
      message:
        "Es obligatorio y debe ser un importe no negativo con máximo dos decimales",
    });
  }
  if (
    payload.subtotal !== undefined && payload.subtotal !== null &&
    !validMoney(payload.subtotal)
  ) {
    errors.push({ field: "subtotal", message: "Debe ser un importe válido" });
  }
  if (
    payload.warrantyMonths !== undefined && payload.warrantyMonths !== null &&
    ![0, 3, 6, 12].includes(payload.warrantyMonths as number)
  ) {
    errors.push({ field: "warrantyMonths", message: "Debe ser 0, 3, 6 o 12" });
  }
  if (
    payload.radiatorObstructionLevel !== undefined &&
    payload.radiatorObstructionLevel !== null &&
    (typeof payload.radiatorObstructionLevel !== "number" ||
      !Number.isInteger(payload.radiatorObstructionLevel) ||
      payload.radiatorObstructionLevel < 0 ||
      payload.radiatorObstructionLevel > 10)
  ) {
    errors.push({
      field: "radiatorObstructionLevel",
      message: "Debe estar entre 0 y 10",
    });
  }
  if (
    payload.legalTextSnapshot !== undefined &&
    (payload.legalTextSnapshot === null ||
      typeof payload.legalTextSnapshot !== "object" ||
      Array.isArray(payload.legalTextSnapshot))
  ) {
    errors.push({ field: "legalTextSnapshot", message: "Debe ser un objeto" });
  }
  if (mode === "update" && !positiveInteger(payload.expectedVersion)) {
    errors.push({
      field: "expectedVersion",
      message: "Debe ser un entero positivo",
    });
  }

  validateAggregateCollections(payload, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function validateTransitionPayload(
  payload: Record<string, unknown>,
  action: "start" | "complete" | "cancel",
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!positiveInteger(payload.expectedVersion)) {
    errors.push({
      field: "expectedVersion",
      message: "Debe ser un entero positivo",
    });
  }
  // Cancel deletes the order from the lists, so the reason is kept for the record.
  if (
    action === "cancel" &&
    (typeof payload.reason !== "string" || !payload.reason.trim() ||
      payload.reason.length > 500)
  ) {
    errors.push({
      field: "reason",
      message: "Es obligatorio y de máximo 500 caracteres",
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
