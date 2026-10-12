const apiUrl = Deno.env.get("API_URL");
const anonKey = Deno.env.get("ANON_KEY");
const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");

if (!apiUrl || !anonKey || !serviceRoleKey) {
  throw new Error("API_URL, ANON_KEY y SERVICE_ROLE_KEY son obligatorios");
}

type HttpResult = { status: number; body: any };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<HttpResult> {
  const method = init.method || "GET";
  console.log(`E2E ${method} ${new URL(url).pathname}`);
  const headers = new Headers(init.headers);
  headers.set("Connection", "close");
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = text;
  }

  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${url} returned ${response.status}; expected ${expectedStatus}: ${text}`,
    );
  }
  return { status: response.status, body };
}

async function adminRequest(
  path: string,
  method: string,
  body?: unknown,
): Promise<HttpResult> {
  return await requestJson(`${apiUrl}${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, method === "POST" ? 201 : 200);
}

async function restInsert(table: string, body: unknown): Promise<any> {
  const result = await adminRequest(`/rest/v1/${table}`, "POST", body);
  assert(
    Array.isArray(result.body) && result.body.length === 1,
    `Expected inserted ${table}`,
  );
  return result.body[0];
}

async function restGet(path: string): Promise<any[]> {
  const result = await adminRequest(`/rest/v1/${path}`, "GET");
  assert(Array.isArray(result.body), `Expected REST array for ${path}`);
  return result.body;
}

async function edgeRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown,
  expectedStatus = 200,
): Promise<HttpResult> {
  return await requestJson(`${apiUrl}/functions/v1${path}`, {
    method,
    headers: {
      apikey: anonKey!,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, expectedStatus);
}

const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const email = `e2e-${suffix}@example.test`;
const password = `E2e-${crypto.randomUUID()}!`;
const clientName = `Cliente HTTP E2E ${suffix}`;
const clientPhone = `81${String(Date.now()).slice(-8)}`;
const dateFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const today = dateFromToday(0);

const authUser = await requestJson(`${apiUrl}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email, password, email_confirm: true }),
}, 200);
assert(typeof authUser.body.id === "string", "Auth user was not created");

const role = await restInsert("role", { description: "EMPLEADO" });
const person = await restInsert("person", {
  name: "Empleado",
  last_name: "E2E",
  email,
});
await restInsert("user", {
  id: authUser.body.id,
  person_id: person.id,
  role_id: role.id,
});

const brandTypes = await restGet("brand_type?select=id&order=id.asc&limit=1");
assert(brandTypes.length === 1, "A brand type fixture is required");
const brand = await restInsert("brand", {
  name: `Nissan E2E ${suffix}`,
  brand_type_id: brandTypes[0].id,
});
const carModel = await restInsert("car_model", {
  name: "Versa E2E",
  brand_id: brand.id,
});

const token = await requestJson(`${apiUrl}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: {
    apikey: anonKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email, password }),
}, 200);
assert(
  typeof token.body.access_token === "string",
  "Password login did not return a token",
);
const accessToken = token.body.access_token;

await requestJson(`${apiUrl}/functions/v1/clients`, {
  method: "GET",
  headers: { apikey: anonKey },
}, 401);

const clientExternalId = crypto.randomUUID();
const firstVehicleExternalId = crypto.randomUUID();
const secondVehicleExternalId = crypto.randomUUID();
const clientPayload = {
  externalId: clientExternalId,
  clientName,
  phoneNumber: clientPhone,
  vehicles: [
    {
      externalId: firstVehicleExternalId,
      carModelId: carModel.id,
      modelYear: 2019,
      version: "Advance",
      color: "Gris",
      plate: "E2E-2019",
    },
    {
      externalId: secondVehicleExternalId,
      carModelId: carModel.id,
      modelYear: 2020,
      color: "Rojo",
      plate: "E2E-2020",
    },
  ],
};

const createdClient = await edgeRequest(
  accessToken,
  "/clients",
  "POST",
  clientPayload,
  201,
);
assertEquals(
  createdClient.body.clientName,
  clientName,
  "Client uses camelCase",
);
assertEquals(createdClient.body.vehicles.length, 2, "Client owns two vehicles");
assert(
  typeof createdClient.body.phoneNormalized === "string",
  "Normalized phone is returned",
);
const clientId = createdClient.body.id;
const firstClientVehicleId = createdClient.body.vehicles.find(
  (vehicle: any) => vehicle.externalId === firstVehicleExternalId,
)?.clientVehicleId;
assert(typeof firstClientVehicleId === "number", "clientVehicleId is returned");

const clientReplay = await edgeRequest(
  accessToken,
  "/clients",
  "POST",
  clientPayload,
  200,
);
assertEquals(
  clientReplay.body.idempotentReplay,
  true,
  "Client retry is idempotent",
);

const reconciledClient = await edgeRequest(
  accessToken,
  "/clients",
  "POST",
  {
    externalId: crypto.randomUUID(),
    clientName: "Nombre offline descartado",
    phoneNumber: clientPhone,
    vehicles: [{
      externalId: crypto.randomUUID(),
      carModelId: carModel.id,
      modelYear: 2021,
      plate: "E2E-2021",
    }],
  },
  200,
);
assertEquals(
  reconciledClient.body.reconciledByPhone,
  true,
  "Phone reconciliation is reported",
);
assertEquals(
  reconciledClient.body.clientName,
  clientName,
  "Stored client data wins reconciliation",
);
assertEquals(
  reconciledClient.body.vehicles.length,
  3,
  "Reconciliation attaches a vehicle",
);

const addedVehicle = await edgeRequest(
  accessToken,
  `/clients/${clientId}/vehicles`,
  "POST",
  {
    vehicle: {
      externalId: crypto.randomUUID(),
      carModelId: carModel.id,
      modelYear: 2022,
      plate: "E2E-2022",
    },
  },
  200,
);
assertEquals(
  addedVehicle.body.vehicles.length,
  4,
  "Existing client accepts another vehicle",
);

const modelSearch = await edgeRequest(
  accessToken,
  `/clients?q=${
    encodeURIComponent(`${brand.name} Versa E2E 2019`)
  }&modelYear=2019`,
);
assertEquals(
  modelSearch.body.pagination.total,
  1,
  "Model and year search finds the client",
);
assertEquals(
  modelSearch.body.data[0].id,
  clientId,
  "Search returns the expected client",
);

const nameSearch = await edgeRequest(
  accessToken,
  `/clients?q=${encodeURIComponent(clientName)}`,
);
assertEquals(
  nameSearch.body.pagination.total,
  1,
  "Name search finds the client",
);

const clientDetail = await edgeRequest(accessToken, `/clients/${clientId}`);
assertEquals(
  clientDetail.body.vehicles.length,
  4,
  "Client detail lists all vehicles",
);

const failureCatalog = await edgeRequest(
  accessToken,
  "/services/failure-types",
);
const radiatorFailureType = failureCatalog.body.find(
  (failure: any) => failure.code === "RADIATOR_SERVICE",
);
const otherFailureType = failureCatalog.body.find(
  (failure: any) => failure.code === "OTHER",
);
assert(radiatorFailureType && otherFailureType, "Failure catalog is exposed");

const serviceExternalId = crypto.randomUUID();
const privateNote = `PRIVATE-${crypto.randomUUID()}`;
const servicePayload = {
  externalId: serviceExternalId,
  provisionalReference: `PEND-SER-${suffix}`,
  clientVehicleId: firstClientVehicleId,
  serviceDate: "2026-08-20",
  reportedFailureSummary: "Se calienta",
  authorizedWorkDescription: "Servicio autorizado",
  vehicleOperationObservations: "Temperatura alta en tráfico",
  importantInformation: "Revisar en una semana",
  radiatorObstructionLevel: 8,
  subtotal: 1000,
  taxAmount: 160,
  warrantyMonths: 6,
  reportedFailures: [{
    externalId: crypto.randomUUID(),
    reportedFailureTypeId: radiatorFailureType.id,
  }],
  internalNotes: [{ externalId: crypto.randomUUID(), note: privateNote }],
};

const createdService = await edgeRequest(
  accessToken,
  "/services",
  "POST",
  servicePayload,
  201,
);
assertEquals(
  createdService.body.total,
  1160,
  "Service total includes captured IVA",
);
assertEquals(createdService.body.status, "DRAFT", "Service starts as draft");
assert(
  createdService.body.folioNumber >= 5000,
  "Service receives an official folio",
);
assert(
  !JSON.stringify(createdService.body).includes(privateNote),
  "Create response excludes private notes",
);

const serviceReplay = await edgeRequest(
  accessToken,
  "/services",
  "POST",
  servicePayload,
  200,
);
assertEquals(
  serviceReplay.body.idempotentReplay,
  true,
  "Service retry is idempotent",
);

const serviceHistory = await edgeRequest(
  accessToken,
  `/services?clientId=${clientId}&phone=${clientPhone}&plate=E2E2019&status=draft`,
);
assertEquals(
  serviceHistory.body.pagination.total,
  1,
  "Client service history supports filters",
);
assert(
  !JSON.stringify(serviceHistory.body).includes(privateNote),
  "List response excludes private notes",
);

const serviceDetail = await edgeRequest(
  accessToken,
  `/services/${serviceExternalId}`,
);
assertEquals(
  serviceDetail.body.externalId,
  serviceExternalId,
  "Service detail resolves externalId",
);
assert(
  !JSON.stringify(serviceDetail.body).includes(privateNote),
  "Detail response excludes private notes",
);

const updatedPrivateNote = `PRIVATE-${crypto.randomUUID()}`;
const updatePayload = {
  ...servicePayload,
  expectedVersion: 1,
  subtotal: 1200,
  taxAmount: 192,
  reportedFailureSummary: "Falla actualizada",
  reportedFailures: [{
    externalId: crypto.randomUUID(),
    reportedFailureTypeId: otherFailureType.id,
    otherText: "Ruido adicional",
  }],
  internalNotes: [{
    externalId: crypto.randomUUID(),
    note: updatedPrivateNote,
  }],
};
const updatedService = await edgeRequest(
  accessToken,
  `/services/${serviceExternalId}`,
  "PUT",
  updatePayload,
);
assertEquals(updatedService.body.total, 1392, "Update recalculates total");
assertEquals(
  updatedService.body.version,
  2,
  "Update increments optimistic version",
);
assertEquals(
  updatedService.body.reportedFailures.length,
  1,
  "Update replaces failures",
);
assert(
  !JSON.stringify(updatedService.body).includes(updatedPrivateNote),
  "Update excludes private notes",
);

const staleUpdate = await edgeRequest(
  accessToken,
  `/services/${serviceExternalId}`,
  "PUT",
  updatePayload,
  409,
);
assertEquals(
  staleUpdate.body.code,
  "SERVICE_VERSION_CONFLICT",
  "Stale update is a conflict",
);

const completedService = await edgeRequest(
  accessToken,
  `/services/${serviceExternalId}/complete`,
  "POST",
  { expectedVersion: 2 },
);
assertEquals(completedService.body.status, "COMPLETED", "Service completes");
assertEquals(completedService.body.version, 3, "Completion increments version");

const completedReplay = await edgeRequest(
  accessToken,
  `/services/${serviceExternalId}/complete`,
  "POST",
  { expectedVersion: 2 },
);
assertEquals(
  completedReplay.body.idempotentReplay,
  true,
  "Completion retry is idempotent",
);

await edgeRequest(
  accessToken,
  `/services/${serviceExternalId}`,
  "PUT",
  { ...updatePayload, expectedVersion: 3 },
  422,
);

const secondServiceExternalId = crypto.randomUUID();
const secondService = await edgeRequest(
  accessToken,
  "/services",
  "POST",
  {
    externalId: secondServiceExternalId,
    provisionalReference: `PEND-CANCEL-${suffix}`,
    clientVehicleId: firstClientVehicleId,
    taxAmount: 0,
  },
  201,
);
const cancelledService = await edgeRequest(
  accessToken,
  `/services/${secondServiceExternalId}/cancel`,
  "POST",
  { expectedVersion: secondService.body.version },
);
assertEquals(
  cancelledService.body.status,
  "CANCELLED",
  "Draft service cancels",
);

const completedList = await edgeRequest(
  accessToken,
  `/services?clientId=${clientId}&status=completed`,
);
assertEquals(completedList.body.pagination.total, 1, "Completed filter works");
const cancelledList = await edgeRequest(
  accessToken,
  `/services?clientId=${clientId}&status=cancelled`,
);
assertEquals(cancelledList.body.pagination.total, 1, "Cancelled filter works");

await requestJson(`${apiUrl}/functions/v1/quotations`, {
  method: "GET",
  headers: { apikey: anonKey },
}, 401);

const quotationExternalId = crypto.randomUUID();
const newOptionExternalId = crypto.randomUUID();
const rebuiltOptionExternalId = crypto.randomUUID();
const quotationPayload = {
  externalId: quotationExternalId,
  provisionalReference: `PEND-COT-${suffix}`,
  quotationDate: today,
  validUntil: dateFromToday(30),
  clientVehicleId: firstClientVehicleId,
  attendedByUserId: authUser.body.id,
  notes: "Alternativas para el cliente",
  options: [
    {
      externalId: newOptionExternalId,
      name: "Radiador nuevo",
      taxAmount: 400,
      warrantyMonths: 6,
      items: [
        {
          externalId: crypto.randomUUID(),
          description: "Radiador nuevo",
          quantity: 2,
          unitPrice: 1000,
          warrantyMonths: 6,
        },
        {
          externalId: crypto.randomUUID(),
          description: "Instalación",
          quantity: 1,
          unitPrice: 500,
        },
      ],
    },
    {
      externalId: rebuiltOptionExternalId,
      name: "Radiador reconstruido",
      taxAmount: 288,
      items: [{
        externalId: crypto.randomUUID(),
        description: "Radiador reconstruido",
        quantity: 1,
        unitPrice: 1800,
      }],
    },
  ],
};

const createdQuotation = await edgeRequest(
  accessToken,
  "/quotations",
  "POST",
  quotationPayload,
  201,
);
assertEquals(
  createdQuotation.body.status,
  "DRAFT",
  "Quotation starts as draft",
);
assertEquals(
  createdQuotation.body.options.length,
  2,
  "Quotation keeps two alternatives",
);
assertEquals(
  createdQuotation.body.options[0].subtotal,
  2500,
  "Backend sums line totals",
);
assertEquals(
  createdQuotation.body.options[0].taxAmount,
  400,
  "Manual IVA is preserved",
);
assertEquals(
  createdQuotation.body.options[0].total,
  2900,
  "Backend calculates option total",
);
assertEquals(
  createdQuotation.body.options[1].total,
  2088,
  "Alternatives are calculated independently",
);
assertEquals(
  createdQuotation.body.acceptedTotal,
  null,
  "Alternatives are not mixed into one total",
);

const quotationReplay = await edgeRequest(
  accessToken,
  "/quotations",
  "POST",
  quotationPayload,
  200,
);
assertEquals(
  quotationReplay.body.idempotentReplay,
  true,
  "Quotation retry is idempotent",
);

const quotationList = await edgeRequest(
  accessToken,
  `/quotations?clientId=${clientId}&phone=${clientPhone}&status=draft&folio=COT-`,
);
assertEquals(
  quotationList.body.pagination.total,
  1,
  "Quotation history supports filters",
);
const quotationDetail = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}`,
);
assertEquals(
  quotationDetail.body.externalId,
  quotationExternalId,
  "Quotation detail resolves externalId",
);

const updatedNewOptionExternalId = crypto.randomUUID();
const updatedRebuiltOptionExternalId = crypto.randomUUID();
const quotationUpdatePayload = {
  ...quotationPayload,
  expectedVersion: 1,
  options: [
    {
      ...quotationPayload.options[0],
      externalId: updatedNewOptionExternalId,
      taxAmount: 432,
      items: [
        {
          externalId: crypto.randomUUID(),
          description: "Radiador nuevo actualizado",
          quantity: 2,
          unitPrice: 1100,
          warrantyMonths: 6,
        },
        {
          externalId: crypto.randomUUID(),
          description: "Instalación",
          quantity: 1,
          unitPrice: 500,
        },
      ],
    },
    {
      ...quotationPayload.options[1],
      externalId: updatedRebuiltOptionExternalId,
      items: [{
        externalId: crypto.randomUUID(),
        description: "Radiador reconstruido",
        quantity: 1,
        unitPrice: 1800,
      }],
    },
  ],
};
const updatedQuotation = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}`,
  "PUT",
  quotationUpdatePayload,
);
assertEquals(
  updatedQuotation.body.version,
  2,
  "Quotation update increments version",
);
assertEquals(
  updatedQuotation.body.options[0].subtotal,
  2700,
  "Update recalculates subtotal",
);
assertEquals(
  updatedQuotation.body.options[0].total,
  3132,
  "Update recalculates total with manual IVA",
);

const staleQuotation = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}`,
  "PUT",
  quotationUpdatePayload,
  409,
);
assertEquals(
  staleQuotation.body.code,
  "QUOTATION_VERSION_CONFLICT",
  "Stale quotation update conflicts",
);

const sentQuotation = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/send`,
  "POST",
  { expectedVersion: 2 },
);
assertEquals(sentQuotation.body.status, "SENT", "Quotation can be sent");
assertEquals(sentQuotation.body.version, 3, "Sending increments version");
const sentReplay = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/send`,
  "POST",
  { expectedVersion: 2 },
);
assertEquals(
  sentReplay.body.idempotentReplay,
  true,
  "Send retry is idempotent",
);

const duplicateExternalId = crypto.randomUUID();
const duplicatedQuotation = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/duplicate`,
  "POST",
  {
    externalId: duplicateExternalId,
    provisionalReference: `PEND-COT-COPY-${suffix}`,
    quotationDate: today,
    validUntil: dateFromToday(45),
  },
  201,
);
assertEquals(
  duplicatedQuotation.body.status,
  "DRAFT",
  "Duplicate starts as draft",
);
assertEquals(
  duplicatedQuotation.body.options.length,
  2,
  "Duplicate keeps alternatives",
);
const duplicateReplay = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/duplicate`,
  "POST",
  {
    externalId: duplicateExternalId,
    provisionalReference: `PEND-COT-COPY-${suffix}`,
    quotationDate: today,
    validUntil: dateFromToday(45),
  },
  200,
);
assertEquals(
  duplicateReplay.body.idempotentReplay,
  true,
  "Duplicate retry is idempotent",
);

const convertedServiceExternalId = crypto.randomUUID();
const converted = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/convert`,
  "POST",
  {
    optionExternalId: updatedNewOptionExternalId,
    serviceExternalId: convertedServiceExternalId,
    serviceProvisionalReference: `PEND-SER-FROM-COT-${suffix}`,
    serviceDate: today,
    expectedVersion: 3,
  },
  201,
);
assertEquals(
  converted.body.quotation.status,
  "ACCEPTED",
  "Conversion accepts quotation",
);
assertEquals(
  converted.body.quotation.acceptedTotal,
  3132,
  "Only selected option becomes accepted total",
);
assertEquals(
  converted.body.service.total,
  3132,
  "Converted service preserves selected total",
);
assertEquals(
  converted.body.service.items.length,
  2,
  "Conversion copies selected concepts",
);
assert(
  !JSON.stringify(converted.body.service.items).includes("reconstruido"),
  "Converted service excludes the unselected alternative",
);

const conversionReplay = await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/convert`,
  "POST",
  {
    optionExternalId: updatedNewOptionExternalId,
    serviceExternalId: convertedServiceExternalId,
    expectedVersion: 3,
  },
  200,
);
assertEquals(
  conversionReplay.body.idempotentReplay,
  true,
  "Conversion retry is idempotent",
);
await edgeRequest(
  accessToken,
  `/quotations/${quotationExternalId}/convert`,
  "POST",
  {
    optionExternalId: updatedNewOptionExternalId,
    serviceExternalId: crypto.randomUUID(),
    expectedVersion: 4,
  },
  409,
);
const convertedServiceDetail = await edgeRequest(
  accessToken,
  `/services/${convertedServiceExternalId}`,
);
assertEquals(
  convertedServiceDetail.body.items.length,
  2,
  "Service exposes copied item snapshots",
);
assertEquals(
  convertedServiceDetail.body.sourceQuotationId,
  createdQuotation.body.id,
  "Service links its source quotation",
);

const expiredQuotationExternalId = crypto.randomUUID();
const expiredOptionExternalId = crypto.randomUUID();
const expiredQuotation = await edgeRequest(
  accessToken,
  "/quotations",
  "POST",
  {
    externalId: expiredQuotationExternalId,
    quotationDate: dateFromToday(-10),
    validUntil: dateFromToday(-1),
    clientVehicleId: firstClientVehicleId,
    options: [{
      externalId: expiredOptionExternalId,
      name: "Cotización vencida",
      taxAmount: 0,
      items: [{
        externalId: crypto.randomUUID(),
        description: "Servicio vencido",
        quantity: 1,
        unitPrice: 100,
      }],
    }],
  },
  201,
);
assertEquals(
  expiredQuotation.body.status,
  "EXPIRED",
  "Validity derives expired status",
);
const blockedConversion = await edgeRequest(
  accessToken,
  `/quotations/${expiredQuotationExternalId}/convert`,
  "POST",
  {
    optionExternalId: expiredOptionExternalId,
    serviceExternalId: crypto.randomUUID(),
    expectedVersion: 1,
  },
  422,
);
assertEquals(
  blockedConversion.body.code,
  "QUOTATION_EXPIRED",
  "Expired quotation blocks conversion",
);
const reactivatedQuotation = await edgeRequest(
  accessToken,
  `/quotations/${expiredQuotationExternalId}/reactivate`,
  "POST",
  { expectedVersion: 1, validUntil: dateFromToday(30) },
);
assertEquals(
  reactivatedQuotation.body.status,
  "DRAFT",
  "Explicit reactivation restores draft",
);

console.log(JSON.stringify({
  result: "PASS",
  authenticatedUserId: authUser.body.id,
  clientId,
  clientVehicleCount: clientDetail.body.vehicles.length,
  serviceFolio: `SER-${createdService.body.folioNumber}`,
  checks: {
    clientCreateSearchAndReconciliation: true,
    serviceCreateUpdateCompleteCancel: true,
    idempotencyAndOptimisticConflict: true,
    internalNotesExcluded: true,
    unauthenticatedRejected: true,
    quotationAlternativesAndManualTax: true,
    quotationDuplicationAndConversion: true,
    quotationExpirationAndReactivation: true,
  },
}));
