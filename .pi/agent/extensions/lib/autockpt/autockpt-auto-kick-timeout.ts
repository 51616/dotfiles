export type AutoKickTimeoutInput = {
  nowMs: number;
  startedAtMs: number;
  lastActivityAtMs?: number;
  maxAgeMs: number;
  canTimeout: boolean;
};

/**
 * Auto-kick timeout predicate.
 *
 * Goal: avoid clearing auto-kick mid-turn while the assistant is actively working.
 *
 * - `canTimeout` should only be true when the agent is idle and the input queue is empty.
 * - timeout age is computed from the last observed activity timestamp when provided.
 */
export function shouldTimeoutAutoKick(input: AutoKickTimeoutInput): boolean {
  const { nowMs, startedAtMs, lastActivityAtMs, maxAgeMs, canTimeout } = input;

  if (!canTimeout) return false;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;

  const basis = lastActivityAtMs ?? startedAtMs;
  if (!Number.isFinite(basis) || basis <= 0) return false;

  return nowMs - basis > maxAgeMs;
}
