/**
 * The tenant's currency reaches the engine, and no code path reintroduces a global one.
 *
 * ## Why this is a source-scanning test
 *
 * `EvaluateActionInput.orgCurrency` is optional, defaulting to `DEFAULT_CURRENCY`, because
 * the engine is a pure function with dozens of test call sites. That default is safe — it
 * cannot turn a refusal into an allowance, which `currency.test.ts` asserts behaviourally —
 * but it is silent. A server path that forgot to pass the field would evaluate a franc CFA
 * tenant's policies as euros and refuse every action it sends, and no behavioural test
 * would notice, because every test that supplies its own currency would still pass.
 *
 * So the wiring itself is asserted, the same way `agent-binding-single-path.test.ts`
 * asserts that the agent-binding switch is read in exactly one place. This is a weaker
 * kind of test than a behavioural one and it is used for the same reason: the property is
 * about which code exists, not about what one call returns.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Strips comments so prose about a symbol is not mistaken for a use of it. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the tenant's currency is threaded, not assumed", () => {
  it("the decision service passes orgCurrency to the engine", () => {
    const code = withoutComments(source("server/services/decision-service.ts"));
    expect(code).toContain("evaluateAction({");
    /*
     * The field, and the fact that it comes from the instance rather than from a literal.
     * `orgCurrency: "EUR"` would satisfy a looser assertion while reinstating exactly the
     * deployment-wide constant Phase 12.3 removed.
     */
    expect(code).toMatch(/orgCurrency:\s*this\.currency/);
  });

  it("the tenant scope resolves the currency from the organization record", () => {
    const code = withoutComments(source("server/routes.ts"));
    // Read from the registry, not from the environment and not from a constant.
    expect(code).toMatch(/organizationStore\.find\(organization\)\?\.currency/);
    /*
     * And handed to both consumers, so a connector and a ceiling cannot disagree.
     *
     * `\bcurrency\b` ANYWHERE in the argument list, not as the last argument. The
     * earlier form required it to be last, so adding `organizationId` after it to
     * `AgentGateway` failed this guard without touching the property it protects —
     * which is that the resolved currency reaches both constructors, never where it
     * sits among their arguments. `\b` on both sides so a different identifier ending
     * in `currency` cannot satisfy it.
     */
    expect(code).toMatch(/new DecisionService\([^)]*\bcurrency\b[^)]*\)/s);
    expect(code).toMatch(/new AgentGateway\([^)]*\bcurrency\b[^)]*\)/s);
  });

  it("the gateway gives every tool the tenant's currency", () => {
    const code = withoutComments(source("server/gateway/agent-gateway.ts"));
    expect(code).toMatch(/currency:\s*this\.currency/);
  });

  it("no connector sends a hard-coded currency downstream", () => {
    /*
     * `simulated-tools.ts` sent `currency: "EUR"` as a literal to the downstream MCP
     * tool, so a refund authorised in francs CFA would have been requested from the
     * provider in euros. The amount approved and the amount asked for would have
     * differed by a factor of 655 with nothing in the audit trail showing it.
     */
    for (const file of [
      "server/gateway/tools/simulated-tools.ts",
      "server/gateway/tools/mcp-client.ts",
      "server/gateway/tools/mcp-destination.ts",
    ]) {
      const code = withoutComments(source(file));
      expect(code, `${file} hard-codes a currency`).not.toMatch(
        /currency:\s*["'](?:EUR|USD|XOF|XAF)["']/,
      );
    }
  });

  it("the deployment-wide ORG_CURRENCY constant is gone and stays gone", () => {
    /*
     * Pinned because reintroducing it is the tempting shortcut whenever a new call site
     * needs a currency and the tenant's is not conveniently in scope. The whole point of
     * migration 15 is that there is no such thing as "the deployment's currency".
     */
    for (const file of [
      "shared/policy/matchers.ts",
      "shared/policy/rules.ts",
      "shared/policy/mandate.ts",
      "shared/policy/engine.ts",
      "server/services/decision-service.ts",
    ]) {
      const code = withoutComments(source(file));
      expect(code, `${file} declares or reads ORG_CURRENCY`).not.toMatch(/\bORG_CURRENCY\b/);
    }
  });

  it("formatAmount has no default currency, so no caller can render the wrong unit", () => {
    const code = withoutComments(source("shared/policy/matchers.ts"));
    // `currency: CurrencyCode = …` would be a default; the parameter must be required.
    expect(code).toMatch(/export function formatAmount\(\s*value: number,\s*currency: CurrencyCode\s*\)/);
    expect(code).not.toMatch(/formatAmount\([^)]*currency: CurrencyCode\s*=/);
  });
});
