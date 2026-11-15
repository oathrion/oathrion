/**
 * Measures the cost of the Phase 6 credential -> agent verification.
 *
 * WHAT IS BEING MEASURED, AND WHY THAT IS THE HONEST THING TO MEASURE
 * ------------------------------------------------------------------
 * The verification is `resolveActingAgent()` / `mayActOnExecution()`: two pure
 * comparisons over data the request already holds. The credential's `agent_id`
 * arrives with the `Identity` that `authenticate()` had already loaded before
 * Phase 6 existed, on the same row, in the same query. So the check adds no
 * database round trip on the five request-body entry points, and this benchmark
 * measures the functions directly.
 *
 * That is a narrow claim and it is the only one this script supports. It is NOT
 * an end-to-end latency figure for Oathrion, and it is not a p99 for the API. A
 * function-level p99 on a shared CI box is dominated by GC and scheduler noise,
 * not by the two string comparisons, which is stated in the output rather than
 * left for a reader to assume the number means more than it does.
 *
 * THE ONE PLACE PHASE 6 DOES ADD I/O
 * ---------------------------------
 * `POST /api/executions/:id/retry` pre-reads the execution row so
 * `mayActOnExecution` has an agent id to compare against — the row is then read
 * again inside `gateway.retry()`. That is one extra indexed primary-key lookup
 * on a route that afterwards performs a network call to a downstream tool. This
 * script does NOT measure it: doing so credibly needs a warm database and a
 * controlled downstream, and an uncontrolled number here would be worse than no
 * number. It is reported as "not measured" in the phase report.
 *
 * Usage: npx tsx script/bench-agent-binding.ts
 */

import { mayActOnExecution, resolveActingAgent } from "../server/identity/agent-binding";
import type { Identity } from "../server/auth";

const ITERATIONS = 200_000;
const WARMUP = 20_000;

function identity(agentId: string | null): Identity {
  return {
    kind: "service",
    id: "key_bench",
    name: "Bench Service",
    role: "operator",
    organizationId: "org_default",
    agentId,
  } as Identity;
}

const BOUND = identity("agt_billing");
const UNBOUND = identity(null);

interface Stats {
  ops: number;
  totalMs: number;
  meanNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
}

/**
 * Times `fn` per call. Each sample is one invocation, which is what makes a
 * percentile meaningful here; timing a batch and dividing would report a mean
 * dressed up as a distribution.
 */
function measure(fn: () => void): Stats {
  for (let i = 0; i < WARMUP; i += 1) fn();

  const samples = new Float64Array(ITERATIONS);
  const started = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    samples[i] = Number(process.hrtime.bigint() - t0);
  }
  const totalNs = Number(process.hrtime.bigint() - started);

  const sorted = Array.from(samples).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

  return {
    ops: ITERATIONS,
    totalMs: totalNs / 1e6,
    meanNs: totalNs / ITERATIONS,
    p50Ns: at(0.5),
    p95Ns: at(0.95),
    p99Ns: at(0.99),
  };
}

function row(label: string, s: Stats): string {
  const f = (ns: number) => `${ns.toFixed(0)} ns`;
  return [
    label.padEnd(46),
    String(s.ops).padStart(8),
    f(s.meanNs).padStart(10),
    f(s.p50Ns).padStart(10),
    f(s.p95Ns).padStart(10),
    f(s.p99Ns).padStart(10),
  ].join(" ");
}

const cases: Array<[string, () => void]> = [
  ["bound credential, names its own agent", () => void resolveActingAgent(BOUND, "agt_billing")],
  ["bound credential, names nothing", () => void resolveActingAgent(BOUND, null)],
  ["bound credential, names another agent (refused)", () => void resolveActingAgent(BOUND, "agt_sales")],
  ["unbound credential, names an agent", () => void resolveActingAgent(UNBOUND, "agt_sales")],
  ["execution ownership, own execution", () => void mayActOnExecution(BOUND, "agt_billing")],
  ["execution ownership, foreign (refused)", () => void mayActOnExecution(BOUND, "agt_sales")],
];

console.log("");
console.log("Phase 6 credential -> agent verification cost");
console.log("=".repeat(100));
console.log(
  [
    "case".padEnd(46),
    "ops".padStart(8),
    "mean".padStart(10),
    "p50".padStart(10),
    "p95".padStart(10),
    "p99".padStart(10),
  ].join(" "),
);
console.log("-".repeat(100));

const results: Array<[string, Stats]> = [];
for (const [label, fn] of cases) {
  const stats = measure(fn);
  results.push([label, stats]);
  console.log(row(label, stats));
}

console.log("-".repeat(100));
console.log("");
console.log("Node:", process.version, "| platform:", process.platform, process.arch);
console.log("");
console.log("SCOPE OF THESE NUMBERS - read before quoting them:");
console.log("  * They measure two in-memory comparisons, nothing else. No database, no");
console.log("    network, no HTTP. The credential's agent_id was already loaded by the");
console.log("    pre-existing authenticate() query, so the check adds no round trip to");
console.log("    the five request-body entry points.");
console.log("  * They are NOT an end-to-end API latency and must not be presented as one.");
console.log("  * The p99 on a shared machine reflects GC and scheduler noise far more than");
console.log("    it reflects this code. Treat it as an upper bound on noise, not a cost.");
console.log("  * NOT MEASURED: the one extra indexed primary-key read that");
console.log("    POST /api/executions/:id/retry performs so the ownership check has an");
console.log("    agent id to compare. Measuring it credibly needs a warm database and a");
console.log("    controlled downstream; no number is given rather than a bad one.");
console.log("");

const worst = results.reduce((a, b) => (b[1].p99Ns > a[1].p99Ns ? b : a));
console.log(`Worst p99 across all cases: ${worst[1].p99Ns.toFixed(0)} ns (${worst[0]}).`);
console.log("");
