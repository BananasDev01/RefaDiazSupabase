import { isUuid } from "../_shared/api.ts";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: Array<{ field: string; message: string }> };

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validateClientPayload(
  payload: Record<string, unknown>,
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  const existingClient = payload.clientId !== undefined;

  if (payload.secondaryPhoneNumber !== undefined && payload.secondaryPhoneNumber !== null) {
    const phone = payload.secondaryPhoneNumber;
    if (typeof phone !== "string" || (phone.trim() && !/^\d{10,15}$/.test(phone.replace(/\D/g, "")))) {
      errors.push({ field: "secondaryPhoneNumber", message: "Captura un teléfono de 10 a 15 dígitos" });
    }
  }

  if (existingClient && payload.clientName !== undefined && (typeof payload.clientName !== "string" || !payload.clientName.trim() || payload.clientName.trim().length > 300)) {
    errors.push({ field: "clientName", message: "Es obligatorio y no puede exceder 300 caracteres" });
  }

  if (payload.comments !== undefined && payload.comments !== null && (typeof payload.comments !== "string" || payload.comments.trim().length > 500)) {
    errors.push({ field: "comments", message: "No puede exceder 500 caracteres" });
  }

  if (existingClient && !isPositiveInteger(payload.clientId)) {
    errors.push({ field: "clientId", message: "Debe ser un entero positivo" });
  }

  if (!existingClient) {
    if (!isUuid(payload.externalId)) {
      errors.push({ field: "externalId", message: "Debe ser un UUID válido" });
    }
    if (typeof payload.clientName !== "string" || !payload.clientName.trim()) {
      errors.push({ field: "clientName", message: "Es obligatorio" });
    }
    if (
      typeof payload.phoneNumber !== "string" || !payload.phoneNumber.trim()
    ) {
      errors.push({ field: "phoneNumber", message: "Es obligatorio" });
    }
  }

  if (payload.vehicles !== undefined && !Array.isArray(payload.vehicles)) {
    errors.push({ field: "vehicles", message: "Debe ser un arreglo" });
  }

  if (Array.isArray(payload.vehicles)) {
    payload.vehicles.forEach((candidate, index) => {
      const field = `vehicles[${index}]`;
      if (
        !candidate || typeof candidate !== "object" || Array.isArray(candidate)
      ) {
        errors.push({ field, message: "Debe ser un objeto" });
        return;
      }

      const vehicle = candidate as Record<string, unknown>;
      if (!isUuid(vehicle.externalId)) {
        errors.push({
          field: `${field}.externalId`,
          message: "Debe ser un UUID válido",
        });
      }
      if (
        vehicle.carModelId !== undefined && vehicle.carModelId !== null &&
        !isPositiveInteger(vehicle.carModelId)
      ) {
        errors.push({
          field: `${field}.carModelId`,
          message: "Debe ser un entero positivo",
        });
      }
      if (
        vehicle.modelYear !== undefined && vehicle.modelYear !== null &&
        (!isPositiveInteger(vehicle.modelYear) ||
          (vehicle.modelYear as number) < 1886 ||
          (vehicle.modelYear as number) > 2100)
      ) {
        errors.push({
          field: `${field}.modelYear`,
          message: "Debe estar entre 1886 y 2100",
        });
      }
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
