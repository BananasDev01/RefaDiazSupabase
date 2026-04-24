export function normalizeModelNameForDuplicateCheck(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isSameModelName(
  existingName: string,
  requestedName: string,
): boolean {
  return normalizeModelNameForDuplicateCheck(existingName) ===
    normalizeModelNameForDuplicateCheck(requestedName);
}
