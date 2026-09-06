// "node:crypto" for the few pure server modules the game screens import
// that roll dice server-side (src/lib/dice.ts). The browser never rolls
// anything that counts, but the module must load.
export function randomInt(min: number, max?: number): number {
  const low = max === undefined ? 0 : min;
  const high = max === undefined ? min : max;
  const span = high - low;
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return low + ((buffer[0] ?? 0) % span);
}

export function randomBytes(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  crypto.getRandomValues(buffer);
  return buffer;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}
