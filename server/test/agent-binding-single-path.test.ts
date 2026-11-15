/**
 * Phase 6.6 — the tripwire that keeps the binding check on ONE path.
 *
 * WHY A TEXTUAL TEST, WHICH IS NORMALLY A BAD IDEA
 * -----------------------------------------------
 * The behavioural tests in `agent-binding-adversarial.test.ts` prove the six
 * entry points that exist today refuse a foreign agent. They cannot prove
 * anything about the SEVENTH entry point somebody adds next quarter.
 *
 * That is the actual failure mode for a control like this. Nobody removes an
 * authorization check on purpose; they add a route, copy the shape of a
 * neighbouring one, forget the line, and ship it green because no test knew the
 * route existed. A per-route behavioural test cannot catch an omission on a
 * route it was never told about.
 *
 * So this file asserts a structural property instead: every place that decides
 * which agent a request acts as goes through `server/identity/agent-binding.ts`,
 * and nothing reads the caller-supplied agent id directly. It is deliberately
 * coupled to the source text, and that coupling is the feature — when it breaks,
 * the right response is to read the diff, not to update the expectation.
 *
 * WHAT IT CANNOT DO
 * ----------------
 * It is a grep with an opinion. A route that reads `req.body.agentId` through a
 * variable this file does not anticipate would slip past it, and a route that
 * never touches an agent id at all is invisible to it and should be. It narrows
 * the omission window; it does not close it. Nothing here should be read as
 * proof that the chokepoint cannot be bypassed.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER = join(import.meta.dirname, "..");

function source(relative: string): string {
  return readFileSync(join(SERVER, relative), "utf8");
}

/**
 * Strips comments so a phrase quoted in a docblock cannot satisfy — or trip — a
 * check about executable code. This file talks about `req.body.agentId` at
 * length in its own header; without this, it would fail itself.
 *
 * Handles line comments, block comments and both quote styles plus template
 * literals, which is enough for this codebase's style. It is not a parser and
 * does not claim to be: a `//` inside a regex literal would confuse it.
 */
export function withoutComments(code: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "'" | '"' | "`" = "code";

  while (i < code.length) {
    const two = code.slice(i, i + 2);
    const ch = code[i]!;

    if (mode === "code") {
      if (two === "//") {
        mode = "line";
        i += 2;
        continue;
      }
      if (two === "/*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") mode = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      }
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (two === "*/") {
        mode = "code";
        i += 2;
        continue;
      }
      // Newlines are kept so reported line numbers stay usable.
      if (ch === "\n") out += ch;
      i += 1;
      continue;
    }

    // Inside a string literal: copy verbatim, honour backslash escapes.
    out += ch;
    if (ch === "\\") {
      out += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === mode) mode = "code";
    i += 1;
  }

  return out;
}

describe("the agent-binding check has exactly one path through it", () => {
  const routes = withoutComments(source("routes.ts"));
  const mcpRouter = withoutComments(source("mcp/router.ts"));
  const chokepoint = withoutComments(source("identity/agent-binding.ts"));

  it("the comment stripper does not mangle code, and does remove comments", () => {
    // The stripper is load-bearing for every assertion below, so it is tested
    // before it is trusted.
    expect(withoutComments('const a = 1; // note\nconst b = 2;')).toBe(
      "const a = 1; \nconst b = 2;",
    );
    expect(withoutComments("/* block */const a = 1;")).toBe("const a = 1;");
    expect(withoutComments('const s = "http://not-a-comment";')).toBe(
      'const s = "http://not-a-comment";',
    );
    expect(withoutComments('const s = "a /* not a block */ b";')).toBe(
      'const s = "a /* not a block */ b";',
    );
    expect(withoutComments("const t = `a // b`;")).toBe("const t = `a // b`;");
    expect(withoutComments('const e = "she said \\"hi\\" // no";')).toBe(
      'const e = "she said \\"hi\\" // no";',
    );
    // Line count is preserved, which is what makes a failure locatable.
    expect(withoutComments("a\n/* x\ny\nz */\nb").split("\n")).toHaveLength(5);
  });

  it("every HTTP route that chooses an agent calls the helper", () => {
    /*
     * Eight entry points, counted rather than merely present: six `actingAgent`
     * calls (`/api/decision`, `/api/execute`, `/api/evaluate`,
     * `POST /api/executions`, and the guided scenario's `/api/scenario/run` and
     * `/api/scenario/notify`, which dispatch through the gateway on behalf of the
     * chosen agent), one `mayActOnExecution` (the retry endpoint), and
     * `resolveActingAgent` in the MCP router.
     *
     * The count is asserted so that deleting one call site fails here even
     * though five others remain — a "contains at least one" assertion would pass
     * with five of six routes unprotected.
     */
    const actingAgentCalls = routes.match(/\bactingAgent\(req, res,/g) ?? [];
    expect(actingAgentCalls).toHaveLength(6);

    const mayAct = routes.match(/\bmayActOnExecution\(/g) ?? [];
    expect(mayAct).toHaveLength(1);

    expect(mcpRouter).toContain("resolveActingAgent(ctx.identity, ctx.declaredAgentId)");
  });

  it("routes.ts resolves the agent only through the chokepoint, never inline", () => {
    /*
     * `resolveActingAgent` is imported once and called once, inside
     * `actingAgent`. Any second call in routes.ts would be a route that
     * re-implemented the decision locally — which is how two callers end up
     * disagreeing about what a bound credential may do.
     */
    const direct = routes.match(/\bresolveActingAgent\(/g) ?? [];
    expect(direct).toHaveLength(1);
  });

  it("no route uses a caller-supplied agent id as the acting agent", () => {
    /*
     * The specific regression this guards: `parsed.data.agentId` reaching a
     * decision or a persisted row without passing through `actingAgent`. Every
     * occurrence must be an ARGUMENT to the helper.
     *
     * Reads as "every mention is inside an actingAgent(...) call" rather than
     * "the string never appears", because the helper legitimately needs it.
     */
    const mentions = routes.match(/parsed\.data\.agentId/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);

    const guarded = routes.match(/actingAgent\(req, res, parsed\.data\.agentId \?\? null\)/g) ?? [];
    expect(
      guarded.length,
      "a route reads the caller-supplied agentId outside actingAgent()",
    ).toBe(mentions.length);
  });

  it("the MCP router never reads its agent header directly for the decision", () => {
    /*
     * `X-Oathrion-Agent-Id` is parsed once at the transport edge into
     * `declaredAgentId`, and from there only the chokepoint may interpret it.
     * A second read inside the router would be a second interpretation of the
     * same header, and the two could drift.
     *
     * Asserted on the READ, not on the header name. The first version forbade
     * the name outright and failed, because the router names the header in the
     * error message it returns when no agent is declared — which is exactly
     * where a caller needs to see it. A test that forbids naming a header in
     * prose pushes the code toward worse error messages, so it is the wrong
     * assertion even when it is easy to satisfy.
     */
    expect(mcpRouter).not.toMatch(/req\.get\(\s*["'`][xX]-[aA][rR][iI][aA]-[aA]gent/);
    expect(mcpRouter).not.toMatch(/headers\[\s*["'`]x-oathrion-agent/i);
  });

  it("the chokepoint is the only place that compares a requested id to a bound one", () => {
    // The comparison itself. If this moves out of `agent-binding.ts`, the
    // structural claim this file makes is void.
    expect(chokepoint).toMatch(/identity\.agentId/);
    expect(routes).not.toMatch(/identity\.agentId\s*!==/);
    expect(mcpRouter).not.toMatch(/identity\.agentId\s*!==/);
  });

  it("the env switch is read in exactly one place", () => {
    /*
     * `OATHRION_REQUIRE_AGENT_BINDING` is read by `requiresAgentBinding()` and
     * nowhere else. A second reader is how a control ends up enabled for one
     * code path and not another — the worst outcome for a security switch,
     * because it looks on.
     */
    for (const [name, text] of [
      ["routes.ts", routes],
      ["mcp/router.ts", mcpRouter],
    ] as const) {
      expect(text, `${name} reads the switch directly`).not.toContain(
        "process.env.OATHRION_REQUIRE_AGENT_BINDING",
      );
    }
    /*
     * Counted as an `process.env` access rather than as a mention of the name.
     * The chokepoint names the variable in the 403 message it returns, so the
     * operator reading the refusal learns which switch caused it — that mention
     * must not count as a second reader.
     */
    const reads = chokepoint.match(/process\.env\.OATHRION_REQUIRE_AGENT_BINDING/g) ?? [];
    expect(reads).toHaveLength(1);
  });

  it("the switch is compared against the exact string, not coerced", () => {
    /*
     * Pinned because the tempting "improvement" — accepting `1`, `yes`, `on` —
     * makes a half-typed value silently enable a security control, or worse,
     * silently fail to. The behavioural half of this is asserted in
     * `agent-binding-adversarial.test.ts`; this half stops the code from being
     * rewritten into something that needs a different test.
     */
    expect(chokepoint).toMatch(/===\s*"true"/);
    expect(chokepoint).not.toMatch(/Boolean\(process\.env\.OATHRION_REQUIRE_AGENT_BINDING/);
  });
});
