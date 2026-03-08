export function parseNonNegativeInt(value: unknown, fallback: number): number {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const n = Number.parseInt(raw || String(fallback), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function parseNonNegativeIntEnv(key: string, fallback: number): number {
  return parseNonNegativeInt(process.env[key], fallback);
}
