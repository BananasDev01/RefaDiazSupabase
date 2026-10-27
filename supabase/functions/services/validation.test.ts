import { validateServicePayload } from "./validation.ts";

const payload = {
  externalId: "90000000-0000-4000-8000-000000000001",
  clientVehicleId: 1,
  taxAmount: 0,
  lineTotalsMode: "LINES",
};
const row = {
  externalId: "90000000-0000-4000-8000-000000000002",
  reportedFailureTypeId: 1,
  amount: 3800,
  observation: "Servicio preventivo",
};
function check(value: Record<string, unknown>, expected: boolean) {
  const result = validateServicePayload(value, "create");
  if (result.ok !== expected) throw new Error(JSON.stringify(result));
}

Deno.test("part orders need the client instead of a vehicle", () => {
  const part = { ...payload, clientVehicleId: undefined, category: "PART" };
  check(
    { ...part, clientId: 7, partDescription: "Radiador de Tsuru 2004" },
    true,
  );
  check({ ...part, clientId: 7 }, true);
  check(part, false);
  check({ ...part, clientId: 7, partDescription: "a".repeat(501) }, false);
  check({ ...payload, category: "BOAT" }, false);
  check({ ...payload, clientVehicleId: undefined }, false);
});

Deno.test("native rows accept amounts, zero and null without otherText", () => {
  for (const amount of [3800, 0, null]) {
    check({ ...payload, reportedFailures: [{ ...row, amount }] }, true);
  }
});
Deno.test("native rows reject invalid amounts and observations", () => {
  for (const amount of [-1, 0.001, "1800", Infinity, 10000000000]) {
    check({ ...payload, reportedFailures: [{ ...row, amount }] }, false);
  }
  for (const observation of [12, {}, "a".repeat(4001)]) {
    check({ ...payload, reportedFailures: [{ ...row, observation }] }, false);
  }
});
Deno.test("native contract requires explicit totals mode and protects historical subtotal", () => {
  check(
    { ...payload, lineTotalsMode: undefined, reportedFailures: [row] },
    false,
  );
  check(
    { ...payload, lineTotalsMode: "invalid", reportedFailures: [row] },
    false,
  );
  check({
    ...payload,
    lineTotalsMode: "LEGACY",
    subtotal: 1000,
    reportedFailures: [row],
  }, false);
  check({
    ...payload,
    lineTotalsMode: "LEGACY",
    subtotal: 1000,
    reportedFailures: [{ ...row, amount: null }],
  }, true);
});
