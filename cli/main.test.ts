/**
 * CLI tests.
 *
 * Nearly every assertion here is about an EXIT CODE, because that is the
 * security contract of a command-line authorization tool. People will write:
 *
 *     oathrion evaluate --action stripe.refund --target cus_1 --amount 75 && ./refund.sh
 *
 * and the shell runs the right-hand side if and only if the left exits 0. So
 * the question these tests keep asking is the only one that matters: is there
 * ANY path — a hold, a bad key, a malformed flag, a timeout, a 500, an
 * unparseable body, an unexpected throw — that exits 0 without an ALLOW?
 *
 * Message text is asserted only where the message is itself the safety feature
 * (telling an operator that nothing decided anything, rather than that the
 * action was refused).
 */

import { describe, expect, it } from "vitest";
import { run, type Io } from "./main";
import { EXIT, exitCodeForDecision } from "./exit-codes";
import { OathrionClient } from "../sdk/typescript/src/client";

const BASE = { OATHRION_URL: "https://placet.test", OATHRION_API_KEY: "cli-test-key-123456" };

interface Capture {
  io: Io;
  out: string[];
  err: string[];
}

/**
 * Builds an `Io` whose SDK client is driven by a stub `fetch`, so a whole
 * command runs end to end through the real SDK — its parsing, its error typing,
 * its refusal to synthesise decisions — without a network.
 */
function harness(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = { ...BASE, OATHRION_AGENT_ID: "agt_billing" },
): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env,
      makeClient: (config) => new OathrionClient({ ...config, fetch: fetchImpl }),
    },
  };
}

function jsonResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function rawResponse(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function throwing(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

const ALLOW_BODY = {
  decision: "ALLOW",
  reason: "within the limit",
  policyId: "pol_refund",
  requestId: "req_1",
};

const EVALUATE = [
  "evaluate",
  "--action",
  "stripe.refund",
  "--target",
  "customer_123",
  "--amount",
  "75",
  "--currency",
  "EUR",
];

describe("Oathrion CLI", () => {
  describe("ALLOW is the only zero", () => {
    it("exits 0 on ALLOW", async () => {
      const h = harness(jsonResponse(ALLOW_BODY));
      expect(await run(EVALUATE, h.io)).toBe(EXIT.ALLOW);
      expect(h.out.join("\n")).toContain("ALLOW");
    });

    it("exits non-zero on BLOCK", async () => {
      const h = harness(jsonResponse({ ...ALLOW_BODY, decision: "BLOCK", reason: "forbidden" }));
      expect(await run(EVALUATE, h.io)).toBe(EXIT.BLOCK);
      expect(EXIT.BLOCK).not.toBe(0);
    });

    it("exits non-zero on APPROVAL_REQUIRED", async () => {
      // The most tempting one to get wrong: a held action looks like progress.
      // Exiting 0 here would make every approval gate in every shell script
      // decorative, because `oathrion evaluate && ./do-it.sh` would just do it.
      const h = harness(
        jsonResponse({ ...ALLOW_BODY, decision: "APPROVAL_REQUIRED", approvalId: "apr_1" }),
      );
      expect(await run(EVALUATE, h.io)).toBe(EXIT.APPROVAL_REQUIRED);
      expect(EXIT.APPROVAL_REQUIRED).not.toBe(0);
    });

    it("gives every decision and failure a distinct non-zero code, ALLOW aside", () => {
      const codes = Object.entries(EXIT);
      const zeros = codes.filter(([, value]) => value === 0).map(([name]) => name);
      expect(zeros).toEqual(["ALLOW"]);
      // Distinct, so an operator can tell "policy refused" from "I could not ask".
      const values = codes.map(([, value]) => value);
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe("an unknown action is refused by the server, and the CLI reports it", () => {
    it("exits BLOCK when Oathrion blocks an undeclared verb", async () => {
      // The CLI does not know which verbs exist and must not: filtering here
      // would be a second policy engine, drifting from the real catalogue.
      const h = harness(
        jsonResponse({
          decision: "BLOCK",
          reason: '"custom.company.operation" is not a declared action and no policy names it',
          policyId: "sys_undeclared_action",
          requestId: "req_u",
        }),
      );
      const code = await run(
        ["evaluate", "--action", "custom.company.operation", "--target", "customer_123"],
        h.io,
      );
      expect(code).toBe(EXIT.BLOCK);
      expect(h.out.join("\n")).toContain("sys_undeclared_action");
    });

    it("sends the verb verbatim rather than validating it locally", async () => {
      const seen: string[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(String(init.body)).action);
        return new Response(JSON.stringify({ decision: "BLOCK", reason: "no" }), { status: 200 });
      }) as unknown as typeof fetch;

      await run(["evaluate", "--action", "weird.verb.nobody.declared", "--target", "t"], harness(fetchImpl).io);
      expect(seen).toEqual(["weird.verb.nobody.declared"]);
    });
  });

  describe("a failure never exits 0", () => {
    it("exits UNREACHABLE when the server cannot be reached", async () => {
      const h = harness(throwing(new TypeError("fetch failed")));
      const code = await run(EVALUATE, h.io);
      expect(code).toBe(EXIT.UNREACHABLE);
      // The wording matters as much as the code: an operator must not read this
      // as "policy refused the action".
      expect(h.err.join("\n")).toMatch(/No decision was received/i);
      expect(h.err.join("\n")).toMatch(/NOT authorised/i);
    });

    it("exits UNREACHABLE on a timeout, and says nothing decided anything", async () => {
      const h = harness(
        throwing(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
      const code = await run([...EVALUATE, "--timeout", "50"], h.io);
      expect(code).toBe(EXIT.UNREACHABLE);
      expect(h.err.join("\n")).toMatch(/NOT authorised/i);
    });

    it("exits HTTP on an invalid credential", async () => {
      const h = harness(
        jsonResponse({ message: "credential not recognised", code: "unauthorized" }, 401),
      );
      const code = await run(EVALUATE, h.io);
      expect(code).toBe(EXIT.HTTP);
      expect(h.err.join("\n")).toMatch(/refused the credential/i);
    });

    it("exits HTTP on a forbidden credential", async () => {
      const h = harness(jsonResponse({ message: "not permitted" }, 403));
      expect(await run(EVALUATE, h.io)).toBe(EXIT.HTTP);
    });

    it("exits HTTP when Oathrion rejects the payload", async () => {
      const h = harness(
        jsonResponse({ message: "id may only contain letters, digits, dot…" }, 400),
      );
      const code = await run([...EVALUATE, "--agent", "!!bad!!"], h.io);
      expect(code).toBe(EXIT.HTTP);
      expect(h.err.join("\n")).toMatch(/rejected the request/i);
    });

    it("exits HTTP on a 500", async () => {
      const h = harness(jsonResponse({ message: "boom" }, 500));
      expect(await run(EVALUATE, h.io)).toBe(EXIT.HTTP);
    });

    it("exits PROTOCOL on a 200 that is not a decision", async () => {
      for (const body of [{ reason: "ok" }, { decision: "PROBABLY_FINE" }, { decision: null }]) {
        const h = harness(jsonResponse(body));
        expect(await run(EVALUATE, h.io)).toBe(EXIT.PROTOCOL);
      }
    });

    it("exits PROTOCOL when a proxy returns HTML with a 200", async () => {
      const h = harness(rawResponse("<html>hello</html>"));
      expect(await run(EVALUATE, h.io)).toBe(EXIT.PROTOCOL);
    });

    it("exits HTTP when a proxy returns an HTML error page", async () => {
      const h = harness(rawResponse("<html>502</html>", 502));
      expect(await run(EVALUATE, h.io)).toBe(EXIT.HTTP);
    });
  });

  describe("usage errors are refused before anything is asked", () => {
    it("exits USAGE and makes no request when --action is missing", async () => {
      let called = 0;
      const fetchImpl = (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const h = harness(fetchImpl);

      expect(await run(["evaluate", "--target", "t"], h.io)).toBe(EXIT.USAGE);
      expect(called).toBe(0);
    });

    it("exits USAGE when --target is missing", async () => {
      const h = harness(jsonResponse(ALLOW_BODY));
      const code = await run(["evaluate", "--action", "stripe.refund"], h.io);
      expect(code).toBe(EXIT.USAGE);
      expect(h.err.join("\n")).toMatch(/target/i);
    });

    it("refuses an unknown flag rather than ignoring it", async () => {
      // A silently-dropped `--ammount` would evaluate a money movement with no
      // amount, against rules written to bound the amount.
      const h = harness(jsonResponse(ALLOW_BODY));
      const code = await run(["evaluate", "--action", "a", "--target", "t", "--ammount", "75"], h.io);
      expect(code).toBe(EXIT.USAGE);
      expect(h.err.join("\n")).toContain("--ammount");
    });

    it("refuses a malformed --input rather than sending an empty one", async () => {
      const h = harness(jsonResponse(ALLOW_BODY));
      const code = await run(["evaluate", "--action", "a", "--target", "t", "--input", "{oops"], h.io);
      expect(code).toBe(EXIT.USAGE);
    });

    it("refuses a non-numeric --amount", async () => {
      const h = harness(jsonResponse(ALLOW_BODY));
      expect(
        await run(["evaluate", "--action", "a", "--target", "t", "--amount", "lots"], h.io),
      ).toBe(EXIT.USAGE);
    });

    it("exits USAGE with no configuration, without reaching the network", async () => {
      const h = harness(jsonResponse(ALLOW_BODY), {});
      const code = await run(EVALUATE, h.io);
      expect(code).toBe(EXIT.USAGE);
      expect(h.err.join("\n")).toMatch(/OATHRION_URL/);
    });

    it("exits USAGE when a credential is missing, and recommends the env var", async () => {
      const h = harness(jsonResponse(ALLOW_BODY), { OATHRION_URL: "https://placet.test" });
      const code = await run(EVALUATE, h.io);
      expect(code).toBe(EXIT.USAGE);
      // A key on the command line lands in shell history and the process list.
      expect(h.err.join("\n")).toMatch(/OATHRION_API_KEY/);
      expect(h.err.join("\n")).toMatch(/history/i);
    });

    it("exits USAGE for an unknown command", async () => {
      const h = harness(jsonResponse(ALLOW_BODY));
      expect(await run(["protect"], h.io)).toBe(EXIT.USAGE);
    });

    it("exits USAGE when invoked with no command at all", async () => {
      // `oathrion` alone printing help and exiting 0 would look like an ALLOW to
      // any script that tested its status.
      const h = harness(jsonResponse(ALLOW_BODY));
      expect(await run([], h.io)).toBe(EXIT.USAGE);
    });

    it("exits 0 for an explicit --help", async () => {
      const h = harness(jsonResponse(ALLOW_BODY));
      expect(await run(["--help"], h.io)).toBe(EXIT.ALLOW);
      expect(h.out.join("\n")).toContain("EXIT CODES");
    });
  });

  describe("health", () => {
    it("exits 0 when the server is ok", async () => {
      const h = harness(jsonResponse({ status: "ok" }));
      expect(await run(["health"], h.io)).toBe(EXIT.ALLOW);
    });

    it("exits non-zero when the server reports itself unhealthy", async () => {
      const h = harness(jsonResponse({ status: "degraded" }));
      expect(await run(["health"], h.io)).toBe(EXIT.HTTP);
    });

    it("exits UNREACHABLE when the server is down", async () => {
      const h = harness(throwing(new TypeError("fetch failed")));
      expect(await run(["health"], h.io)).toBe(EXIT.UNREACHABLE);
    });
  });

  describe("config", () => {
    it("masks the credential", async () => {
      const h = harness(jsonResponse({}), { ...BASE, OATHRION_AGENT_ID: "agt_billing" });
      expect(await run(["config"], h.io)).toBe(EXIT.ALLOW);
      const printed = h.out.join("\n");
      expect(printed).toContain("https://placet.test");
      expect(printed).toContain("agt_billing");
      // The whole point: the key must not be recoverable from the output.
      expect(printed).not.toContain(BASE.OATHRION_API_KEY);
      expect(printed).toMatch(/\*{4,}/);
    });
  });

  describe("the CLI holds no opinion of its own", () => {
    it("asks the server again on every invocation", async () => {
      const answers = ["ALLOW", "BLOCK"];
      let i = 0;
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ decision: answers[i++], reason: "r" }), {
          status: 200,
        })) as unknown as typeof fetch;

      const h = harness(fetchImpl);
      expect(await run(EVALUATE, h.io)).toBe(EXIT.ALLOW);
      expect(await run(EVALUATE, h.io)).toBe(EXIT.BLOCK);
      expect(i).toBe(2);
    });

    it("reports a dry-run hold as unfiled rather than pretending it is queued", async () => {
      const h = harness(
        jsonResponse({
          decision: "APPROVAL_REQUIRED",
          reason: "over the limit",
          approvalId: null,
          persisted: false,
        }),
      );
      expect(await run(EVALUATE, h.io)).toBe(EXIT.APPROVAL_REQUIRED);
      // Without this line an operator waits for an approval nobody can see.
      expect(h.out.join("\n")).toMatch(/dry run/i);
      expect(h.out.join("\n")).toMatch(/--persist/);
    });

    it("passes --persist through to the server", async () => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(ALLOW_BODY), { status: 200 });
      }) as unknown as typeof fetch;

      await run([...EVALUATE, "--persist"], harness(fetchImpl).io);
      expect(bodies[0].persist).toBe(true);

      await run(EVALUATE, harness(fetchImpl).io);
      expect(bodies[1].persist).toBeUndefined();
    });

    it("emits machine-readable JSON on --json without changing the exit code", async () => {
      const h = harness(jsonResponse({ ...ALLOW_BODY, decision: "BLOCK" }));
      expect(await run([...EVALUATE, "--json"], h.io)).toBe(EXIT.BLOCK);
      expect(JSON.parse(h.out[0]).decision).toBe("BLOCK");
    });
  });
  /*
   * The decision -> exit code map, asserted directly.
   *
   * These exist because a mutation caught their absence. Removing the
   * `default: return EXIT.PROTOCOL` branch and returning EXIT.ALLOW instead
   * left the entire CLI suite green: every other test drives the mapping
   * through the SDK, which rejects an unrecognised `decision` before the
   * mapping is ever reached, so the branch was real code that no test touched.
   *
   * That branch is defence in depth, and defence in depth that nothing
   * exercises is indistinguishable from defence in depth that does not work.
   * The SDK guard could be relaxed, or a future caller could reach this
   * function by another path, and the failure mode of the untested branch is
   * "unrecognised answer becomes exit 0" — the worst one available.
   */
  describe("decision to exit code", () => {
    it("maps the three known decisions", () => {
      expect(exitCodeForDecision("ALLOW")).toBe(EXIT.ALLOW);
      expect(exitCodeForDecision("BLOCK")).toBe(EXIT.BLOCK);
      expect(exitCodeForDecision("APPROVAL_REQUIRED")).toBe(EXIT.APPROVAL_REQUIRED);
    });

    it("never returns 0 for a decision string it does not recognise", () => {
      // Including the ones a permissive implementation would be tempted by:
      // a lowercase ALLOW, a synonym, and a value that is not a decision.
      for (const unknown of ["PERMIT", "allow", "Allow", "ALLOWED", "OK", "", "undefined", "null"]) {
        expect(exitCodeForDecision(unknown)).toBe(EXIT.PROTOCOL);
        expect(exitCodeForDecision(unknown)).not.toBe(EXIT.ALLOW);
      }
    });

    it("treats a near-miss of ALLOW as a protocol failure, not a match", () => {
      // Whitespace and case are exactly how a drifting protocol arrives.
      expect(exitCodeForDecision(" ALLOW")).toBe(EXIT.PROTOCOL);
      expect(exitCodeForDecision("ALLOW ")).toBe(EXIT.PROTOCOL);
    });
  });
});

/*
 * Le renommage (octobre 2026) : la commande s'appelle `oathrion`, et les anciennes variables
 * `PLACET_*` restent honorées — par le processus réel (`bin.ts`), avec un avertissement sur
 * la sortie d'erreur et rien sur la sortie standard en dehors du résultat.
 */
describe("le renommage Placet → Oathrion, vu du processus", () => {
  it("PLACET_URL et PLACET_API_KEY sont honorés, avec un avertissement sur stderr", async () => {
    const { spawnSync } = await import("node:child_process");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const run = spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "cli", "bin.ts"), "config"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", PLACET_URL: "https://ancien-nom.test", PLACET_API_KEY: "cli-test-key-ancien-123456" },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("https://ancien-nom.test");
    expect(run.stdout).not.toContain("cli-test-key-ancien-123456");
    expect(run.stderr).toMatch(/PLACET_URL → rename to OATHRION_URL/);
  });
});
