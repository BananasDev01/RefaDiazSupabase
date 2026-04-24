import {
  isSameModelName,
  normalizeModelNameForDuplicateCheck,
} from "../modelNameValidation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("model duplicate check normalizes case, accents, spaces, and punctuation", () => {
  assert(
    isSameModelName("GM-4", " g.m. 4 "),
    "Expected formatted names to match",
  );
  assert(
    isSameModelName("Línea 1", "linea-1"),
    "Expected accent variants to match",
  );
});

Deno.test("model duplicate check allows distinct short model names", () => {
  assert(!isSameModelName("GM2", "GM4"), "Expected GM2 and GM4 to be distinct");
  assert(
    !isSameModelName("GM4", "GM4X"),
    "Expected GM4 and GM4X to be distinct",
  );
  assert(
    !isSameModelName("Civic", "Civic LX"),
    "Expected trim variants to be distinct",
  );
});

Deno.test("model name duplicate normalization is deterministic", () => {
  const normalized = normalizeModelNameForDuplicateCheck("  Á.B C-123  ");
  assert(normalized === "abc123", `Expected abc123, received ${normalized}`);
});
