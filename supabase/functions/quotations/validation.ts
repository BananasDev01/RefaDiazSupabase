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

function validQuantity(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0 &&
    value <= 999_999_999.999 &&
    Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6;
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function optionalWarranty(value: unknown): boolean {
  return value === undefined || value === null || [0, 3, 6, 12].includes(
    value as number,
  );
}

export function validateQuotationPayload(
  payload: Record<string, unknown>,
  mode: "create" | "update",
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!isUuid(payload.externalId)) {
    errors.push({ field: "externalId", message: "Debe ser un UUID válido" });
  }
  if (!positiveInteger(payload.clientVehicleId)) {
    errors.push({
      field: "clientVehicleId",
      message: "Debe ser un entero positivo",
    });
  }
  if (mode === "update" && !positiveInteger(payload.expectedVersion)) {
    errors.push({
      field: "expectedVersion",
      message: "Debe ser un entero positivo",
    });
  }
  for (const field of ["quotationDate", "validUntil"] as const) {
    if (
      payload[field] !== undefined && payload[field] !== null &&
      !validDate(payload[field])
    ) {
      errors.push({ field, message: "Debe usar el formato YYYY-MM-DD" });
    }
  }
  if (
    validDate(payload.quotationDate) && validDate(payload.validUntil) &&
    (payload.validUntil as string) < (payload.quotationDate as string)
  ) {
    errors.push({
      field: "validUntil",
      message: "No puede ser anterior a quotationDate",
    });
  }
  if (!Array.isArray(payload.options) || payload.options.length === 0) {
    errors.push({
      field: "options",
      message: "Debe incluir al menos una opción",
    });
  } else {
    payload.options.forEach((candidate, optionIndex) => {
      const field = `options[${optionIndex}]`;
      if (
        !candidate || typeof candidate !== "object" || Array.isArray(candidate)
      ) {
        errors.push({ field, message: "Debe ser un objeto" });
        return;
      }
      const option = candidate as Record<string, unknown>;
      if (!isUuid(option.externalId)) {
        errors.push({
          field: `${field}.externalId`,
          message: "Debe ser un UUID válido",
        });
      }
      if (typeof option.name !== "string" || !option.name.trim()) {
        errors.push({ field: `${field}.name`, message: "Es obligatorio" });
      }
      if (!validMoney(option.taxAmount)) {
        errors.push({
          field: `${field}.taxAmount`,
          message: "El IVA manual es obligatorio y debe ser un importe válido",
        });
      }
      if (!optionalWarranty(option.warrantyMonths)) {
        errors.push({
          field: `${field}.warrantyMonths`,
          message: "Debe ser 0, 3, 6 o 12",
        });
      }
      if (!Array.isArray(option.items) || option.items.length === 0) {
        errors.push({
          field: `${field}.items`,
          message: "Debe incluir al menos un concepto",
        });
        return;
      }
      option.items.forEach((itemCandidate, itemIndex) => {
        const itemField = `${field}.items[${itemIndex}]`;
        if (
          !itemCandidate || typeof itemCandidate !== "object" ||
          Array.isArray(itemCandidate)
        ) {
          errors.push({ field: itemField, message: "Debe ser un objeto" });
          return;
        }
        const item = itemCandidate as Record<string, unknown>;
        if (!isUuid(item.externalId)) {
          errors.push({
            field: `${itemField}.externalId`,
            message: "Debe ser un UUID válido",
          });
        }
        if (
          item.productId !== undefined && item.productId !== null &&
          !positiveInteger(item.productId)
        ) {
          errors.push({
            field: `${itemField}.productId`,
            message: "Debe ser un entero positivo",
          });
        }
        if (
          (typeof item.description !== "string" || !item.description.trim()) &&
          !positiveInteger(item.productId)
        ) {
          errors.push({
            field: `${itemField}.description`,
            message: "Es obligatoria sin producto",
          });
        }
        if (!validQuantity(item.quantity)) {
          errors.push({
            field: `${itemField}.quantity`,
            message: "Debe ser positiva y tener máximo tres decimales",
          });
        }
        if (!validMoney(item.unitPrice)) {
          errors.push({
            field: `${itemField}.unitPrice`,
            message: "Debe ser un importe no negativo",
          });
        }
        if (!optionalWarranty(item.warrantyMonths)) {
          errors.push({
            field: `${itemField}.warrantyMonths`,
            message: "Debe ser 0, 3, 6 o 12",
          });
        }
      });
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateVersionPayload(
  payload: Record<string, unknown>,
): ValidationResult {
  return positiveInteger(payload.expectedVersion) ? { ok: true } : {
    ok: false,
    errors: [{
      field: "expectedVersion",
      message: "Debe ser un entero positivo",
    }],
  };
}

export function validateDuplicatePayload(
  payload: Record<string, unknown>,
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!isUuid(payload.externalId)) {
    errors.push({ field: "externalId", message: "Debe ser un UUID válido" });
  }
  for (const field of ["quotationDate", "validUntil"] as const) {
    if (
      payload[field] !== undefined && payload[field] !== null &&
      !validDate(payload[field])
    ) {
      errors.push({ field, message: "Debe usar el formato YYYY-MM-DD" });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateConversionPayload(
  payload: Record<string, unknown>,
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!isUuid(payload.optionExternalId)) {
    errors.push({
      field: "optionExternalId",
      message: "Debe ser un UUID válido",
    });
  }
  if (!isUuid(payload.serviceExternalId)) {
    errors.push({
      field: "serviceExternalId",
      message: "Debe ser un UUID válido",
    });
  }
  if (!positiveInteger(payload.expectedVersion)) {
    errors.push({
      field: "expectedVersion",
      message: "Debe ser un entero positivo",
    });
  }
  if (
    payload.serviceDate !== undefined && payload.serviceDate !== null &&
    !validDate(payload.serviceDate)
  ) {
    errors.push({
      field: "serviceDate",
      message: "Debe usar el formato YYYY-MM-DD",
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validIsoDate(value: string | null): boolean {
  return value === null || validDate(value);
}
