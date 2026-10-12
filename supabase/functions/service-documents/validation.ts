export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export function tokenIsValid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function detectDocumentMime(bytes: Uint8Array): string | null {
  if (bytes.length < 8 || bytes.length > MAX_FILE_BYTES) return null;
  if ([137,80,78,71,13,10,26,10].every((n,i) => bytes[i]===n)) return 'image/png';
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.slice(0,5)) === '%PDF-') return 'application/pdf';
  return null;
}
export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2,'0')).join('');
}
export async function limitedBody(req: Request, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length')) > limit) throw new Error('FILE_TOO_LARGE');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('EMPTY_BODY');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('FILE_TOO_LARGE'); }
    chunks.push(value);
  }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk,offset); offset += chunk.byteLength; }
  return output;
}
