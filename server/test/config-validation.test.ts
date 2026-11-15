/**
 * Runtime configuration must be rejected loudly, not coerced quietly.
 *
 * The fault-injection bench (`script/chaos.ts`, category `config`) started Oathrion
 * with deliberately wrong environment variables and read what an operator would
 * actually see. Three outcomes were not good enough:
 *
 *  1. `PORT` went through `parseInt(value, 10)`, which stops at the first character
 *     it does not understand instead of rejecting the string. `PORT="80o0"` — a
 *     plausible typo for 8000 — silently became port **80**. The bench only scored
 *     that as "handled" because an unprivileged sandbox cannot bind 80; in a
 *     container running as root, and most do, Oathrion would have come up healthy on
 *     a port nobody asked for while every client saw connection refused on 8000.
 *     `PORT="5e3"` becomes port 5, and `PORT="0x1f44"` becomes port 0, which asks
 *     the kernel for a random port.
 *
 *  2. `OATHRION_DB` pointing somewhere unusable produced `SqliteError: unable to open
 *     database file` with no path and no mention of the variable, so the operator
 *     could not tell a permissions problem from a missing directory.
 *
 *  3. `OATHRION_TRUST_PROXY="yes-please"` reached Express untouched and surfaced as
 *     `TypeError: invalid IP address: yes-please` from proxy-addr, followed by lines
 *     of minified bundle. Nothing named the variable that was wrong.
 *
 * None of this changes behaviour for a valid configuration: these are boot-time
 * rejections in the same fail-closed style as `authConfigProblems()`.
 */

import { describe, expect, it } from "vitest";
import {
  describeDatabaseOpenFailure,
  resolvePort,
  resolveHost,
  isLoopbackHost,
  runtimeConfigProblems,
  trustProxyProblem,
} from "../config-check";

describe("PORT is validated rather than coerced", () => {
  it("accepts a plain integer and defaults when unset", () => {
    expect(resolvePort("5000")).toBe(5000);
    expect(resolvePort(undefined)).toBe(5000);
    expect(resolvePort("")).toBe(5000);
    expect(resolvePort("8080")).toBe(8080);
    // 0 is legitimate and useful: it asks the kernel for a free port.
    expect(resolvePort("0")).toBe(0);
  });

  it("refuses a string parseInt would silently truncate", () => {
    // Each of these used to yield a port, and never the one that was meant.
    for (const value of ["80o0", "5000abc", "5e3", "0x1f44", "8 000", "80.5"]) {
      expect(() => resolvePort(value), `PORT=${value}`).toThrow(/PORT/);
    }
  });

  it("refuses a port outside the legal range", () => {
    for (const value of ["-1", "99999", "65536"]) {
      expect(() => resolvePort(value), `PORT=${value}`).toThrow(/PORT/);
    }
  });

  it("names the variable and the offending value, without inventing a fallback", () => {
    // A permissive fallback here is exactly the failure being fixed: booting on the
    // wrong port is worse than not booting.
    expect(() => resolvePort("80o0")).toThrow(/80o0/);
  });
});

describe("OATHRION_HOST : l'adresse d'écoute est une décision, la boucle locale par défaut", () => {
  it("écoute sur 127.0.0.1 quand rien n'est déclaré", () => {
    expect(resolveHost(undefined)).toBe("127.0.0.1");
    expect(resolveHost("   ")).toBe("127.0.0.1");
  });

  it("accepte une adresse IP littérale ou localhost", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::", "10.0.0.7", "localhost"]) {
      expect(resolveHost(host)).toBe(host);
    }
  });

  it("refuse un nom d'hôte : il pourrait désigner une autre interface", () => {
    expect(() => resolveHost("intranet.exemple")).toThrow(/OATHRION_HOST.*intranet\.exemple/);
    expect(() => resolveHost("0.0.0.0:5000")).toThrow(/OATHRION_HOST/);
  });

  it("la vérification de démarrage le signale avec les autres problèmes", () => {
    expect(runtimeConfigProblems({ OATHRION_HOST: "intranet.exemple" }).join("\n")).toMatch(/OATHRION_HOST/);
    expect(runtimeConfigProblems({ OATHRION_HOST: "0.0.0.0" }).join("\n")).not.toMatch(/OATHRION_HOST/);
  });

  it("distingue la boucle locale de tout le reste", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.24"]) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("OATHRION_TRUST_PROXY is validated before Express sees it", () => {
  it("accepts the documented forms", () => {
    for (const value of [undefined, "", "false", "0", "1", "2", "10.0.0.0/8", "loopback"]) {
      expect(trustProxyProblem(value), `value=${String(value)}`).toBeNull();
    }
  });

  it("rejects a value that is neither a hop count, a boolean, nor an address", () => {
    const problem = trustProxyProblem("yes-please");
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/OATHRION_TRUST_PROXY/);
    expect(problem).toMatch(/yes-please/);
  });
});

describe("a database that cannot be opened says which path and which variable", () => {
  it("names OATHRION_DB, the resolved path and the underlying reason", () => {
    const message = describeDatabaseOpenFailure(
      "/nowhere/data.db",
      new Error("unable to open database file"),
    );
    expect(message).toMatch(/OATHRION_DB/);
    expect(message).toMatch(/\/nowhere\/data\.db/);
    expect(message).toMatch(/unable to open database file/);
  });

  it("does not pretend to know the cause when the error is unrecognised", () => {
    const message = describeDatabaseOpenFailure("/tmp/x.db", new Error("something else"));
    expect(message).toMatch(/something else/);
  });
});

describe("the boot check collects every problem at once", () => {
  it("reports nothing for a valid environment", () => {
    expect(runtimeConfigProblems({ PORT: "5000", OATHRION_TRUST_PROXY: "1" })).toEqual([]);
  });

  it("reports both problems together so one restart fixes both", () => {
    // An operator should not have to discover mistakes one boot at a time.
    const problems = runtimeConfigProblems({ PORT: "80o0", OATHRION_TRUST_PROXY: "yes-please" });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/PORT/);
    expect(problems.join("\n")).toMatch(/OATHRION_TRUST_PROXY/);
  });
});

describe("the boot check also validates the quota configuration (P3)", () => {
  it("accepts an environment that configures no quotas at all", () => {
    // The normal case: no OATHRION_QUOTAS means the shipped defaults, which is not a problem.
    expect(runtimeConfigProblems({ PORT: "5000" })).toEqual([]);
  });

  it("accepts a well-formed override and mode", () => {
    expect(
      runtimeConfigProblems({
        PORT: "5000",
        OATHRION_QUOTAS: "default:agents=100,org_acme:executions=5000",
        OATHRION_QUOTA_MODE: "observe",
      }),
    ).toEqual([]);
  });

  it("refuses a malformed quota entry at boot rather than at the first request", () => {
    /*
     * Without this, `parseQuotaOverrides` would throw lazily inside whichever customer
     * request first reached a quota check: that customer gets a 500, and the operator
     * learns about a typo from an incident instead of from a failed deploy.
     */
    const problems = runtimeConfigProblems({ PORT: "5000", OATHRION_QUOTAS: "default:agents=5O" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/5O|agents/);
  });

  it("refuses an unknown counter name", () => {
    // Naming a counter that does not exist is the mistake most likely to look correct:
    // the operator believes a ceiling is in place and there is none.
    const problems = runtimeConfigProblems({ PORT: "5000", OATHRION_QUOTAS: "default:audits=5" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/audits/);
  });

  it("refuses an unrecognised quota mode", () => {
    const problems = runtimeConfigProblems({ PORT: "5000", OATHRION_QUOTA_MODE: "observ" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/OATHRION_QUOTA_MODE/);
  });

  it("reports a quota problem alongside a port problem, in one boot", () => {
    // The existing contract: every problem at once, so one restart fixes all of them.
    const problems = runtimeConfigProblems({
      PORT: "80o0",
      OATHRION_QUOTAS: "default:agents=-1",
      OATHRION_QUOTA_MODE: "off",
    });
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/PORT/);
    expect(problems.join("\n")).toMatch(/OATHRION_QUOTA_MODE/);
  });
});

describe("RATE_LIMIT_FAIL_MODE is validated at boot, not on the first request", () => {
  it("reports a typo among the boot-time problems", () => {
    const problems = runtimeConfigProblems({ RATE_LIMIT_FAIL_MODE: "opn" } as NodeJS.ProcessEnv);
    expect(problems.join("\n")).toMatch(/RATE_LIMIT_FAIL_MODE is "opn"/);
  });
  it("accepts closed, open and unset", () => {
    for (const value of ["closed", "open", undefined]) {
      const problems = runtimeConfigProblems({ RATE_LIMIT_FAIL_MODE: value } as NodeJS.ProcessEnv);
      expect(problems.join("\n")).not.toMatch(/RATE_LIMIT_FAIL_MODE/);
    }
  });
});
