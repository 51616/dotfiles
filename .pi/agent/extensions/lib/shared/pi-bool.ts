export function parseBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}
