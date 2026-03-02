import { asString } from "./pi-string.ts";

export function parsePositiveInt(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(asString(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
