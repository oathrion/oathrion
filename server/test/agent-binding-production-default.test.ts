/**
 * PRODUCTION MUST FAIL CLOSED — the agent-binding default (Phase 9).
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * Through Phase 8, `OATHRION_REQUIRE_AGENT_BINDING` was off by default everywhere.
 * The consequence, stated plainly in `docs/limitations.md` and in
 * PHASE-6-REPORT.md section 18: an unbound *service* credential could name any
 * agent in its own organisation and act as it. A key issued for a reporting
 * integration could execute as the agent that moves money, because the agent id
 * was accepted from the request body.
 *
 * The Phase 8 rationale for the default was real: flipping it on for everyone
 * stops every existing key from executing anything, delivered by a version bump
 * with no migration path. But it produced the wrong outcome anyway, because it
 * made the residual gap the SHIPPED PRODUCTION POSTURE. An operator who deployed
 * Oathrion and never read the limitations page ran with agent identity taken from
 * the request.
 *
 * WHAT CHANGED
 * ------------
 * The default is now a function of `NODE_ENV`:
 *
 *   NODE_ENV=production  + variable unset  →  REQUIRED   (fail closed)
 *   anything else        + variable unset  →  not required (unchanged)
 *
 * and the explicit escape hatch is preserved in one direction:
 *
 *   OATHRION_REQUIRE_AGENT_BINDING="false"     →  not required, even in production
 *   OATHRION_REQUIRE_AGENT_BINDING="true"      →  required, even in development
 *
 * That satisfies both halves of the brief: production fails closed, and the
 * development compatibility that could be kept cleanly was kept, by name, rather
 * than deleted.
 *
 * WHY A TYPO'D OPT-OUT STAYS CLOSED
 * ---------------------------------
 * Only the literal `"false"` disables it. `"False"`, `"0"`, `"no"`, `" false"`
 * are unrecognised and fall through to the environment default — so in
 * production they leave the requirement ON. The failure direction of a mistyped
 * opt-out is "stayed safe". This is the mirror image of the pre-existing rule
 * that only the literal `"true"` enables it, and both are pinned below, because
 * the tempting "just accept any boolean" refactor breaks a security control in
 * a way that looks like a cleanup.
 *
 * These are unit tests against the chokepoint itself rather than HTTP tests.
 * That is deliberate and it is not a weakening: `agent-binding-single-path.test.ts`
 * already proves structurally that every entry point routes through
 * `resolveActingAgent` and that this file is the only reader of the switch, and
 * `agent-binding-adversarial.test.ts` already proves the behaviour over HTTP.
 * What was missing was coverage of which way the DEFAULT falls, and that is a
 * property of this function.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { requiresAgentBinding, resolveActingAgent } from "../identity/agent-binding";
import { securityPostureNotices } from "../config-check";
import type { Identity } from "../auth";

/** Restored after every case so no test leaks a global into the next one. */
const SAVED_BINDING = process.env.OATHRION_REQUIRE_AGENT_BINDING;
const SAVED_NODE_ENV = process.env.NODE_ENV;

function setEnv(binding: string | undefined, nodeEnv: string | undefined): void {
  if (binding === undefined) delete process.env.OATHRION_REQUIRE_AGENT_BINDING;
  else process.env.OATHRION_REQUIRE_AGENT_BINDING = binding;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
}

afterEach(() => {
  setEnv(SAVED_BINDING, SAVED_NODE_ENV);
});

/** An unbound machine credential — the shape the gap depended on. */
const UNBOUND_SERVICE: Identity = {
  id: "svc:reporting",
  name: "Reporting integration",
  kind: "service",
  organizationId: DEFAULT_ORGANIZATION_ID,
  role: "admin",
  agentId: null,
};

/** A machine credential pinned to one agent — never affected by the switch. */
const BOUND_SERVICE: Identity = {
  ...UNBOUND_SERVICE,
  id: "svc:billing",
  name: "Billing agent key",
  agentId: "agt_billing",
};

/** A human session. The switch governs machine credentials only. */
const HUMAN: Identity = {
  id: "user:jane",
  name: "Jane (console)",
  kind: "user",
  organizationId: DEFAULT_ORGANIZATION_ID,
  role: "admin",
  agentId: null,
};

describe("requiresAgentBinding(): which way silence falls", () => {
  it("is REQUIRED in production when nothing is configured", () => {
    /*
     * The heart of the change. An operator who sets no Oathrion-specific variable
     * at all, and whose platform sets NODE_ENV=production as every Node
     * platform does, gets the closed posture.
     */
    setEnv(undefined, "production");
    expect(requiresAgentBinding()).toBe(true);
  });

  it("is NOT required outside production when nothing is configured", () => {
    // Development compatibility, kept deliberately and kept cleanly.
    for (const env of ["development", "test", undefined]) {
      setEnv(undefined, env);
      expect(requiresAgentBinding(), `NODE_ENV=${String(env)}`).toBe(false);
    }
  });

  it("is required in production even when the variable is empty", () => {
    /*
     * `OATHRION_REQUIRE_AGENT_BINDING=` in an env file is not a decision. It is a
     * leftover. It must not read as "off".
     */
    for (const raw of ["", "   "]) {
      setEnv(raw, "production");
      expect(requiresAgentBinding(), JSON.stringify(raw)).toBe(true);
    }
  });

  it("can still be turned OFF in production, but only by name", () => {
    /*
     * The migration path the Phase 8 rationale was protecting. It survives — an
     * operator with pre-binding keys can ship one more deploy — but it now
     * takes a typed word that appears in a diff, rather than being what happens
     * when nobody thinks about it.
     */
    setEnv("false", "production");
    expect(requiresAgentBinding()).toBe(false);
  });

  it("can still be turned ON outside production", () => {
    setEnv("true", "development");
    expect(requiresAgentBinding()).toBe(true);
  });

  it("does not accept a mistyped opt-out in production", () => {
    /*
     * The important asymmetry. A half-typed "off" must not half-disable a
     * security control. Each of these falls through to the production default,
     * which is closed.
     */
    for (const raw of ["False", "FALSE", "0", "no", "off", " false", "false ", "faluse"]) {
      setEnv(raw, "production");
      expect(requiresAgentBinding(), `${JSON.stringify(raw)} disabled the requirement`).toBe(true);
    }
  });

  it("does not accept a mistyped opt-in outside production", () => {
    // The pre-existing rule, still true, now re-pinned alongside its mirror.
    for (const raw of ["1", "yes", "TRUE", "True", " true", "on"]) {
      setEnv(raw, "development");
      expect(requiresAgentBinding(), `${JSON.stringify(raw)} enabled the requirement`).toBe(false);
    }
  });

  it("treats only the exact production string as production", () => {
    /*
     * Not a heuristic. `NODE_ENV=prod` or `Production` is a misconfiguration,
     * and this function does not guess. It is worth being explicit that the
     * guess is not made, because guessing here would mean a deployment believing
     * it is closed when it is open — the failure mode that is invisible.
     *
     * Whitespace IS tolerated, because a trailing space in a container env file
     * is a transcription artefact rather than an intent.
     */
    setEnv(undefined, " production ");
    expect(requiresAgentBinding()).toBe(true);

    for (const env of ["prod", "Production", "PRODUCTION", "staging", "production-eu"]) {
      setEnv(undefined, env);
      expect(requiresAgentBinding(), `NODE_ENV=${env}`).toBe(false);
    }
  });
});

describe("the production default at the chokepoint", () => {
  it("refuses an unbound service credential in production", () => {
    setEnv(undefined, "production");
    const outcome = resolveActingAgent(UNBOUND_SERVICE, "agt_treasury");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return; // narrowing; unreachable
    expect(outcome.refusal).toBe("agent_binding_required");

    /*
     * The refusal has to be actionable. An operator hitting this on their first
     * production deploy must learn from the message what to do, otherwise the
     * fail-closed default just reads as a broken product.
     */
    expect(outcome.reason).toMatch(/bound/i);
    expect(outcome.reason).toContain("OATHRION_REQUIRE_AGENT_BINDING=false");
  });

  it("the same credential and request is allowed in development", () => {
    // Proof that the change is scoped to production and nothing else moved.
    setEnv(undefined, "development");
    const outcome = resolveActingAgent(UNBOUND_SERVICE, "agt_treasury");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.agentId).toBe("agt_treasury");
    expect(outcome.bound).toBe(false);
  });

  it("a bound credential is unaffected in production", () => {
    /*
     * The correct production shape keeps working with no configuration. If this
     * failed, the new default would be a breaking change for deployments that
     * had already done the right thing.
     */
    setEnv(undefined, "production");

    const implicit = resolveActingAgent(BOUND_SERVICE, null);
    expect(implicit.ok).toBe(true);
    if (implicit.ok) expect(implicit.agentId).toBe("agt_billing");

    const explicit = resolveActingAgent(BOUND_SERVICE, "agt_billing");
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.agentId).toBe("agt_billing");
  });

  it("a bound credential still cannot borrow another agent in production", () => {
    // Unchanged, and re-pinned here: the new default must not have made the
    // stronger existing check unreachable.
    setEnv(undefined, "production");
    const outcome = resolveActingAgent(BOUND_SERVICE, "agt_treasury");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe("agent_binding_violation");
  });

  it("does not lock out human sessions in production", () => {
    /*
     * The switch is about MACHINE credentials. A console operator naming an
     * agent is a person who has authenticated and whose role is checked
     * elsewhere; requiring them to hold a per-agent credential would break the
     * console for no security gain. Pinned because widening the check to all
     * identities is the obvious over-correction.
     */
    setEnv(undefined, "production");
    const outcome = resolveActingAgent(HUMAN, "agt_treasury");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.agentId).toBe("agt_treasury");
  });

  it("still refuses a request that names no agent at all", () => {
    /*
     * Oathrion authorises per agent, so there is no default agent in any
     * environment. Distinct refusal code from the binding one, so an operator
     * can tell "you must bind this key" apart from "you forgot to say who".
     */
    for (const env of ["production", "development"]) {
      setEnv("false", env); // binding requirement off, to isolate this path
      const outcome = resolveActingAgent(UNBOUND_SERVICE, null);
      expect(outcome.ok, `NODE_ENV=${env}`).toBe(false);
      if (!outcome.ok) expect(outcome.refusal).toBe("agent_not_declared");
    }
  });
});

describe("structural pins on the new default", () => {
  const source = readFileSync(new URL("../identity/agent-binding.ts", import.meta.url), "utf8");

  it("keeps exactly one reader of the switch", () => {
    /*
     * `agent-binding-single-path.test.ts` asserts this too. Repeated here
     * because the Phase 9 edit is precisely the kind of change that would have
     * been tempting to implement by reading the variable in `config-check.ts`
     * as well, and a security switch with two readers is a switch that is on
     * for one code path and off for another.
     */
    const reads = source.match(/process\.env\.OATHRION_REQUIRE_AGENT_BINDING/g) ?? [];
    expect(reads).toHaveLength(1);
  });

  it("compares both strings exactly, without coercion", () => {
    expect(source).toMatch(/raw === "true"/);
    expect(source).toMatch(/raw === "false"/);
    expect(source).not.toMatch(/Boolean\(\s*(raw|process\.env\.OATHRION_REQUIRE_AGENT_BINDING)/);
    expect(source).not.toMatch(/raw\?\.toLowerCase\(\)/);
  });

  it("derives the default from NODE_ENV and nothing else", () => {
    /*
     * Not from the presence of DATABASE_URL, not from a port, not from a
     * hostname. Inferring "this looks like production" is how a control ends up
     * enabled on one deployment and not on its identical twin.
     */
    expect(source).toMatch(/process\.env\.NODE_ENV\?\.trim\(\) === "production"/);
  });
});

describe("the boot log tells the operator which posture is active", () => {
  /*
   * The refusal an unbound credential receives says the relaxation "is recorded
   * in the boot log". That sentence is a claim about the product, so it has to
   * be true. `server/index.ts` prints `securityPostureNotices()` immediately
   * after the runtime-config gate; these tests pin what it prints.
   *
   * Nothing here can stop a boot. Every configuration below is legal - the
   * point is that none of them is silent.
   */

  /*
   * The posture is injected, not re-derived from `env`.
   *
   * `securityPostureNotices` now ASKS `agentBindingPosture()` instead of deciding for
   * itself, because the two disagreed in the shipped bundle: `script/build.ts` replaces
   * the enforcer's `process.env.NODE_ENV` with the literal `"production"`, so the
   * requirement is permanently on in `dist/index.cjs` while the banner, reading a real
   * environment object, said "not required". A banner that mirrors a security control
   * can drift from it; one that asks it cannot.
   *
   * These cases describe HYPOTHETICAL deployments, so they supply the posture that
   * deployment would have — the same answer `agentBindingPosture()` returns when the
   * process really is configured that way. Asserting the wiring itself is the job of
   * "the banner reports what the enforcer will actually do" below.
   */
  function noticeFor(binding: string | undefined, nodeEnv: string | undefined): string {
    const env: NodeJS.ProcessEnv = {};
    if (binding !== undefined) env.OATHRION_REQUIRE_AGENT_BINDING = binding;
    if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
    const hypothetical = () => {
      if (binding === "true") return { required: true, reason: "OATHRION_REQUIRE_AGENT_BINDING=true" };
      if (binding === "false") return { required: false, reason: "OATHRION_REQUIRE_AGENT_BINDING=false" };
      return nodeEnv === "production"
        ? { required: true, reason: "production default" }
        : { required: false, reason: `NODE_ENV=${nodeEnv ?? "unset"}, not production` };
    };
    const lines = securityPostureNotices(env, hypothetical).filter((l) =>
      l.startsWith("agent binding:"),
    );
    expect(lines, "exactly one agent-binding notice is expected").toHaveLength(1);
    return lines[0];
  }

  /*
   * The regression test for the drift itself. Whatever the enforcer answers, the banner
   * must say the same thing — including when the environment handed to the banner
   * disagrees with the process, which is precisely the bundle's situation.
   */
  it("the banner reports what the enforcer will actually do, not what the env suggests", () => {
    const saved = process.env.OATHRION_REQUIRE_AGENT_BINDING;
    try {
      for (const [value, expected] of [
        ["true", true],
        ["false", false],
      ] as const) {
        process.env.OATHRION_REQUIRE_AGENT_BINDING = value;
        // A deliberately contradictory env: the banner must follow the enforcer, not this.
        const misleading: NodeJS.ProcessEnv = {
          NODE_ENV: expected ? "development" : "production",
        };
        const line = securityPostureNotices(misleading).find((l) =>
          l.startsWith("agent binding:"),
        );
        expect(line, "an agent-binding notice is always printed").toBeDefined();
        expect(requiresAgentBinding()).toBe(expected);
        expect(line).toContain(expected ? "REQUIRED" : "NOT REQUIRED");
      }
    } finally {
      if (saved === undefined) delete process.env.OATHRION_REQUIRE_AGENT_BINDING;
      else process.env.OATHRION_REQUIRE_AGENT_BINDING = saved;
    }
  });

  it("always says something about agent binding, in every environment", () => {
    /*
     * Unconditional on purpose. A notice printed only when the posture is
     * unusual teaches an operator to read its absence as "fine", and absence is
     * also what a broken notice looks like.
     */
    for (const nodeEnv of ["production", "development", "test", undefined]) {
      for (const binding of ["true", "false", undefined, ""]) {
        expect(noticeFor(binding, nodeEnv).length).toBeGreaterThan(20);
      }
    }
  });

  it("reports the production default as REQUIRED", () => {
    const notice = noticeFor(undefined, "production");
    expect(notice).toContain("REQUIRED");
    expect(notice).toContain("production default");
    // and it tells the operator how to get out of it, so a first deploy that
    // hits the refusal is self-service.
    expect(notice).toContain("OATHRION_REQUIRE_AGENT_BINDING=false");
  });

  it("makes an explicit production relaxation conspicuous", () => {
    /*
     * This is the line an auditor should be able to grep for. It must name the
     * consequence - not just the variable - because "OATHRION_REQUIRE_AGENT_BINDING
     * is false" means nothing to someone reading a log six months later.
     */
    const notice = noticeFor("false", "production");
    expect(notice).toContain("NOT REQUIRED");
    expect(notice).toMatch(/explicitly relaxed|relaxed/i);
    expect(notice).toMatch(/can name any agent/i);
    expect(notice).toMatch(/migration/i);
  });

  it("says plainly that development is open", () => {
    const notice = noticeFor(undefined, "development");
    expect(notice).toMatch(/not required/i);
    expect(notice).toMatch(/can name any agent/i);
    // and that this is not what production does
    expect(notice).toMatch(/in production this is required by default/i);
  });

  it("never contradicts the function that actually enforces the posture", () => {
    /*
     * The one test that matters most in this block. `securityPostureNotices()`
     * re-derives the default rather than importing `requiresAgentBinding()` -
     * see the comment there for why - and a description that drifts from the
     * enforcement is worse than no description, because it is a confident wrong
     * answer. So: every combination, both functions, must agree.
     */
    for (const nodeEnv of ["production", "development", "test", "staging", undefined]) {
      for (const binding of ["true", "false", "TRUE", "1", "no", "", " ", undefined]) {
        setEnv(binding, nodeEnv);
        const enforced = requiresAgentBinding();
        const described = noticeFor(binding, nodeEnv);
        const saysRequired = described.includes("REQUIRED") && !described.includes("NOT REQUIRED");
        const saysNotRequired = /not required/i.test(described);

        expect(
          saysRequired || saysNotRequired,
          `notice is ambiguous for binding=${String(binding)} NODE_ENV=${String(nodeEnv)}`,
        ).toBe(true);
        expect(
          saysRequired,
          `boot log and enforcement disagree for binding=${String(binding)} ` +
            `NODE_ENV=${String(nodeEnv)}: enforced=${enforced}, notice="${described}"`,
        ).toBe(enforced);
      }
    }
  });

  it("stays quiet about the other two settings when they are at their safe default", () => {
    /*
     * Signal discipline. If every setting printed a line, the one that matters
     * would be lost in it. These two are reported only when they are moved off
     * the safe value.
     */
    const quiet = securityPostureNotices({ NODE_ENV: "production" });
    expect(quiet.filter((l) => l.startsWith("undeclared actions:"))).toHaveLength(0);
    expect(quiet.filter((l) => l.startsWith("rate limiting:"))).toHaveLength(0);
  });

  it("reports the two other settings when they are moved off the safe value", () => {
    const loud = securityPostureNotices({
      NODE_ENV: "production",
      OATHRION_UNDECLARED_ACTION: "allow",
      RATE_LIMIT_FAIL_MODE: "open",
    });

    const undeclared = loud.find((l) => l.startsWith("undeclared actions:"));
    expect(undeclared).toBeDefined();
    expect(undeclared).toContain("ALLOW");
    expect(undeclared).toMatch(/default is block/i);

    const limiter = loud.find((l) => l.startsWith("rate limiting:"));
    expect(limiter).toBeDefined();
    expect(limiter).toContain("FAIL OPEN");
    // the consequence that actually matters, named
    expect(limiter).toMatch(/sign-in/i);
  });

  it("never prints a secret", () => {
    /*
     * These lines go to stdout at boot, which is the most widely shipped log in
     * any deployment. Cheap pin: the notices are built only from the names and
     * values of the three switches above, none of which is a credential, and
     * this asserts nothing else leaks in.
     */
    const notices = securityPostureNotices({
      NODE_ENV: "production",
      OATHRION_API_KEYS: "Acme/CI:admin:super-secret-key-value",
      OATHRION_SESSION_SECRET: "another-secret-value",
      DATABASE_URL: "postgres://user:hunter2@db/placet",
      OATHRION_UNDECLARED_ACTION: "allow",
      RATE_LIMIT_FAIL_MODE: "open",
    }).join("\n");

    for (const secret of ["super-secret-key-value", "another-secret-value", "hunter2"]) {
      expect(notices, `boot notice leaked ${secret}`).not.toContain(secret);
    }
  });
});
