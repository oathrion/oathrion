/**
 * How long Oathrion waits for a downstream tool before giving up. (Phase 9)
 *
 * Previously this call used bare `fetch` with no deadline at all, so a
 * downstream that accepted the connection and never answered held the request,
 * the caller and a database row open indefinitely. That is not a hypothetical
 * failure mode; it is what a hung dependency does.
 *
 * A timeout is an EXECUTION failure, never an authorization one. The decision
 * was already made and recorded before this call; a timeout changes what
 * happened downstream, not what Oathrion decided. The gateway records the run as
 * failed, and the audit trail keeps the two apart.
 *
 * 30s is deliberately generous - a payment API can be slow - but finite, which
 * is the only property that matters.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The configured downstream timeout, in milliseconds.
 *
 * Refuses a value it cannot read rather than falling back, because a fallback
 * here means an operator who wrote `OATHRION_MCP_TIMEOUT_MS=6O000` (letter O) gets
 * 30s and is never told.
 */
export function downstreamTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OATHRION_MCP_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `OATHRION_MCP_TIMEOUT_MS is "${raw}", which is not a whole number of milliseconds.`,
    );
  }
  const value = Number(raw);
  if (value <= 0) {
    throw new Error(
      "OATHRION_MCP_TIMEOUT_MS must be greater than zero. A timeout of 0 would mean no deadline, " +
        "which is the failure this setting exists to prevent.",
    );
  }
  return value;
}
