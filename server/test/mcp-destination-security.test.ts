/**
 * Adversarial tests for the MCP downstream destination. (Phase 9)
 *
 * WHAT IS BEING DEFENDED
 * ----------------------
 * `resolveDownstreamDestination()` is the only place in Oathrion where an
 * operator-supplied hostname becomes an outbound socket carrying an *authorised
 * action*. That makes it the highest-value SSRF sink in the system: an attacker
 * who steers it does not merely read an internal endpoint, they get Oathrion's
 * control plane to issue the request on their behalf, from inside the trust
 * boundary, with the decision already recorded as ALLOW.
 *
 * So the tests below are written as attacks, not as coverage. Each one is a
 * shape that has defeated a real SSRF filter somewhere.
 *
 * WHAT THESE TESTS DO NOT PROVE
 * -----------------------------
 * Stated plainly, because the gap matters and pretending otherwise would be the
 * exact dishonesty this phase exists to remove: everything here inspects a
 * STRING. None of it stops DNS rebinding. A hostname that is public when it is
 * validated can resolve to 127.0.0.1 when the socket opens.
 *
 * That defence is a different one, and it lives in
 * `server/notifications/webhook-transport.ts`: a custom `lookup` that refuses
 * every blocked address at connect time, applied to the address the socket is
 * about to use, which is the only check that cannot be raced. The last block in
 * this file asserts structurally that the MCP client actually routes through
 * that transport rather than through `fetch`, because that wiring is the thing
 * that makes the string checks below meaningful rather than decorative.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  McpDestinationError,
  parseAllowedDestinations,
  resolveDownstreamDestination,
} from "../gateway/tools/mcp-destination";
import { downstreamTimeoutMs } from "../gateway/tools/mcp-client";

/** A destination configuration, expressed as the environment an operator sets. */
function remote(url: string, allowlist?: string): NodeJS.ProcessEnv {
  return {
    OATHRION_MCP_DOWNSTREAM_URL: url,
    OATHRION_MCP_ALLOWED_DESTINATIONS: allowlist ?? url,
  };
}

/** Asserts the configuration is refused, and that the refusal explains itself. */
function expectRefused(env: NodeJS.ProcessEnv, matcher: RegExp): void {
  let thrown: unknown;
  try {
    resolveDownstreamDestination(env);
  } catch (error) {
    thrown = error;
  }

  expect(thrown, `configuration was accepted: ${JSON.stringify(env)}`).toBeInstanceOf(
    McpDestinationError,
  );
  expect((thrown as Error).message).toMatch(matcher);
}

describe("no destination configured", () => {
  it("returns null rather than inventing one", () => {
    /*
     * The simulator path. It must be `null` and not a throw: an unconfigured
     * relay is the normal state of a deployment that has not wired one up, and
     * turning that into a boot failure would be false urgency.
     */
    expect(resolveDownstreamDestination({})).toBeNull();
    expect(resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: "  " })).toBeNull();
  });

  it("refuses to guess when both variables are set", () => {
    /*
     * Ranked precedence would be the friendly choice and the wrong one: half the
     * operators who set both get the other, and nothing tells them. The actions
     * still go somewhere - just not where the person thinks - which is the
     * failure mode with no symptom.
     */
    expectRefused(
      {
        OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9999",
        OATHRION_MCP_DOWNSTREAM_URL: "https://mcp.example.com",
        OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.example.com",
      },
      /will not.*guess|Set exactly one/i,
    );
  });
});

describe("the local fixture path stays exactly as it was", () => {
  it("accepts loopback in every spelling", () => {
    for (const raw of [
      "http://127.0.0.1:9310",
      "http://localhost:9310",
      "http://[::1]:9310",
      "http://127.0.0.53:9310", // still 127.0.0.0/8
    ]) {
      const resolved = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: raw });
      expect(resolved, raw).not.toBeNull();
      expect(resolved?.kind).toBe("LOCAL_FIXTURE");
    }
  });

  it("returns an origin, never the raw string", () => {
    /*
     * The gateway builds its own request against this value. Returning the raw
     * string would let a trailing path or query survive into a place that
     * ignores it - a setting silently discarded is a setting an operator
     * believes is in effect.
     */
    const resolved = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9310" });
    expect(resolved?.origin).toBe("http://127.0.0.1:9310");
  });

  it("still refuses a non-loopback host in the LOCAL variable", () => {
    /*
     * The Phase 4 rule, preserved. This variable names a developer's fixture; a
     * public host in it is a misread environment, and the safe reading of a
     * misread environment is not "send the refund there".
     */
    expectRefused(
      { OATHRION_LOCAL_MCP_URL: "https://mcp.example.com" },
      /must point at loopback/i,
    );
  });
});

describe("SSRF: addresses that must never be dispatched to", () => {
  it("refuses cloud instance metadata, by address and by name", () => {
    /*
     * The single most valuable SSRF target in any cloud deployment: an
     * unauthenticated HTTP endpoint that hands out the instance's credentials.
     */
    for (const url of [
      "http://169.254.169.254",
      "http://169.254.170.2", // ECS task metadata
      "http://metadata.google.internal",
      "http://metadata",
      "http://instance-data.ec2.internal",
      "http://[fd00:ec2::254]", // IMDS over IPv6
    ]) {
      expectRefused(remote(url), /metadata|link-local|unique local|internal suffix/i);
    }
  });

  it("refuses every private and reserved IPv4 range", () => {
    for (const url of [
      "http://10.0.0.5",
      "http://172.16.0.1",
      "http://172.31.255.254",
      "http://192.168.1.1",
      "http://127.0.0.1",
      "http://0.0.0.0",
      "http://100.64.0.1", // carrier-grade NAT
      "http://198.18.0.1", // benchmarking
      "http://224.0.0.1", // multicast
      "http://255.255.255.255",
    ]) {
      expectRefused(remote(url), /refused|loopback|private|routable|multicast|reserved|NAT/i);
    }
  });

  it("refuses private and reserved IPv6", () => {
    for (const url of [
      "http://[::1]",
      "http://[::]",
      "http://[fc00::1]", // unique local
      "http://[fd12:3456::1]",
      "http://[fe80::1]", // link-local
      "http://[ff02::1]", // multicast
    ]) {
      expectRefused(remote(url), /refused|loopback|local|multicast|unspecified|routable/i);
    }
  });

  it("refuses IPv4-mapped IPv6, which is the classic filter bypass", () => {
    /*
     * `::ffff:127.0.0.1` is the IPv4 loopback wearing an IPv6 hat. WHATWG URL
     * parsing compresses it to `::ffff:7f00:1`, which no IPv4 rule matches
     * textually - so a filter that checks for "127." lets it straight through
     * and the socket connects to localhost anyway.
     *
     * Both the dotted and the compressed hex forms are covered, because the
     * parser will hand over whichever it feels like.
     */
    for (const url of [
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:7f00:1]",
      "http://[::ffff:169.254.169.254]",
      "http://[::ffff:a9fe:a9fe]",
      "http://[::ffff:10.0.0.1]",
    ]) {
      expectRefused(remote(url), /refused|loopback|link-local|metadata|private/i);
    }
  });

  it("refuses reserved internal DNS suffixes", () => {
    for (const url of [
      "http://vault.internal",
      "http://printer.local",
      "http://api.home.arpa",
      "http://db.localdomain",
      "http://foo.localhost",
    ]) {
      expectRefused(remote(url), /internal suffix|localhost/i);
    }
  });

  it("refuses localhost by name in the remote variable", () => {
    // The remote variable is for routable destinations. Loopback there is
    // either a mistake or an attempt to launder the fixture exemption.
    expectRefused(remote("http://localhost:9310"), /localhost|routable/i);
  });
});

describe("SSRF: schemes, credentials and shapes", () => {
  it("refuses every non-HTTP scheme", () => {
    /*
     * `gopher:` is the reason this check exists in every mature SSRF filter: it
     * lets an attacker write arbitrary bytes to an arbitrary TCP port, which
     * turns an HTTP client into a Redis client. `file:` would turn a dispatch
     * into a local file read.
     */
    for (const url of [
      "gopher://example.com/_test",
      "file:///etc/passwd",
      "ftp://example.com",
      "ws://example.com",
      "redis://example.com",
      "data:text/plain,hello",
    ]) {
      expectRefused(remote(url), /scheme|not a valid absolute URL|no host/i);
    }
  });

  it("refuses credentials embedded in the URL", () => {
    /*
     * Refused rather than stripped. Stripping would send an unauthenticated
     * request that the operator believes is authenticated - and the credential
     * would still have passed through the log on its way to being stripped.
     */
    expectRefused(
      remote("https://user:hunter2@mcp.example.com", "https://mcp.example.com"),
      /must not embed credentials/i,
    );
  });

  it("does not leak the embedded password in the refusal", () => {
    /*
     * The refusal text reaches the application log. A guard that refuses a
     * credential and then prints it has moved the problem, not solved it.
     */
    let message = "";
    try {
      resolveDownstreamDestination(
        remote("https://user:hunter2@mcp.example.com", "https://mcp.example.com"),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2");
  });

  it("refuses dangerous ports even on an allowlisted public host", () => {
    /*
     * A port blocklist is usually theatre. Not here: this sink speaks HTTP, and
     * Redis reads the lines of an HTTP request as inline commands. An MCP server
     * listens on none of these, so refusing them costs nothing real and removes
     * the whole protocol-confusion class.
     *
     * Note the host IS allowlisted in each case - the point is that being on the
     * allowlist does not buy an exemption.
     */
    for (const [url, service] of [
      ["http://mcp.example.com:6379", "Redis"],
      ["http://mcp.example.com:11211", "memcached"],
      ["http://mcp.example.com:5432", "PostgreSQL"],
      ["http://mcp.example.com:22", "SSH"],
      ["http://mcp.example.com:25", "SMTP"],
      ["http://mcp.example.com:3306", "MySQL"],
      ["http://mcp.example.com:27017", "MongoDB"],
    ] as const) {
      expectRefused(remote(url), new RegExp(service, "i"));
    }
  });

  it("refuses a destination carrying a path, query or fragment", () => {
    for (const url of [
      "https://mcp.example.com/tools/call",
      "https://mcp.example.com/?token=abc",
      "https://mcp.example.com/#frag",
    ]) {
      expectRefused(
        { ...remote(url), OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.example.com" },
        /origin.*no path|query string or fragment/i,
      );
    }
  });

  it("refuses text that is not a URL at all", () => {
    for (const url of ["not a url", "://missing-scheme", "http://", "  "]) {
      const env = remote(url);
      if (url.trim() === "") {
        // Empty is "not configured", not "misconfigured".
        expect(resolveDownstreamDestination(env)).toBeNull();
        continue;
      }
      expectRefused(env, /not a valid URL|no host|scheme/i);
    }
  });
});

describe("the allowlist is the second, independent gate", () => {
  it("permits nothing when it is unset", () => {
    /*
     * The failure direction of forgetting to configure the allowlist is
     * "dispatches nowhere", not "dispatches anywhere". This is the single most
     * important assertion in the file.
     */
    expectRefused(
      { OATHRION_MCP_DOWNSTREAM_URL: "https://mcp.example.com" },
      /OATHRION_MCP_ALLOWED_DESTINATIONS is empty|permits nothing/i,
    );
  });

  it("permits nothing when it is empty or only separators", () => {
    for (const allowlist of ["", "   ", ",", ",,, ,"]) {
      expectRefused(
        {
          OATHRION_MCP_DOWNSTREAM_URL: "https://mcp.example.com",
          OATHRION_MCP_ALLOWED_DESTINATIONS: allowlist,
        },
        /empty|permits nothing/i,
      );
    }
  });

  it("refuses the wildcard explicitly", () => {
    /*
     * `*` is what somebody types when the list is inconvenient, and it would
     * turn this entire module off. Refusing it by name - with an error that says
     * why - is better than letting it fail as "not a valid URL", because the
     * person needs to understand that the inconvenience is the feature.
     */
    expect(() => parseAllowedDestinations("*")).toThrow(/does not accept/i);
    expect(() => parseAllowedDestinations("https://a.example.com,*")).toThrow(/does not accept/i);
  });

  it("refuses a destination that is not on the list", () => {
    expectRefused(
      {
        OATHRION_MCP_DOWNSTREAM_URL: "https://evil.example.com",
        OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.example.com",
      },
      /not in OATHRION_MCP_ALLOWED_DESTINATIONS/i,
    );
  });

  it("matches on origin, so a lookalike host does not slip through", () => {
    /*
     * Substring or prefix matching is how allowlists fail. Each of these
     * contains the allowlisted origin as a substring, or nearly does.
     */
    for (const attacker of [
      "https://mcp.example.com.evil.net",
      "https://evil.net/?x=https://mcp.example.com",
      "https://mcp-example.com",
      "https://mcp.example.com:8443", // different port is a different origin
      "http://mcp.example.com", // different scheme is a different origin
    ]) {
      expectRefused(
        {
          OATHRION_MCP_DOWNSTREAM_URL: attacker,
          OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.example.com",
        },
        /not in OATHRION_MCP_ALLOWED_DESTINATIONS|origin.*no path|query string/i,
      );
    }
  });

  it("refuses an allowlist entry that is itself unsafe", () => {
    /*
     * Being on the allowlist does not exempt an entry from the address rules.
     * The plausible way `http://169.254.169.254` ends up in an allowlist is a
     * copied config or a tampered environment - precisely the situation where
     * the address rules are the check that still works.
     */
    for (const entry of [
      "http://169.254.169.254",
      "http://127.0.0.1:9310",
      "http://10.0.0.1",
      "gopher://example.com",
      "https://vault.internal",
    ]) {
      expect(() => parseAllowedDestinations(entry), entry).toThrow(McpDestinationError);
    }
  });

  it("accepts a well-formed allowlist and normalises it to origins", () => {
    const allowed = parseAllowedDestinations(
      " https://mcp.example.com , https://tools.example.org:8443 ",
    );
    expect([...allowed].sort()).toEqual([
      "https://mcp.example.com",
      "https://tools.example.org:8443",
    ]);
  });
});

describe("the happy path actually works", () => {
  it("accepts an allowlisted public destination", () => {
    /*
     * The reason this whole module exists. Phase 8 could not do this at all -
     * the relay was loopback-only, which made the gateway a demo. If this test
     * ever fails, Oathrion is safe and useless, which is not the goal.
     */
    const resolved = resolveDownstreamDestination(
      remote("https://mcp.example.com", "https://mcp.example.com,https://other.example.org"),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.origin).toBe("https://mcp.example.com");
    expect(resolved?.kind).toBe("ALLOWLISTED_REMOTE");
  });

  it("accepts a non-default port that is not a dangerous one", () => {
    const resolved = resolveDownstreamDestination(
      remote("https://mcp.example.com:8443", "https://mcp.example.com:8443"),
    );
    expect(resolved?.origin).toBe("https://mcp.example.com:8443");
  });

  it("distinguishes a fixture from a real destination in its answer", () => {
    /*
     * `kind` is not cosmetic: the audit entry records whether an action was
     * simulated or dispatched, and a system whose whole claim is honest
     * authorization must not be vague about which of the two happened.
     */
    expect(resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:1" })?.kind).toBe(
      "LOCAL_FIXTURE",
    );
    expect(resolveDownstreamDestination(remote("https://mcp.example.com"))?.kind).toBe(
      "ALLOWLISTED_REMOTE",
    );
  });
});

describe("the downstream call is bounded in time", () => {
  it("has a finite default", () => {
    /*
     * Before Phase 9 this call used bare `fetch` with no deadline, so a
     * downstream that accepted the connection and never answered held the
     * request, the caller and a database row open indefinitely.
     */
    const value = downstreamTimeoutMs({});
    expect(value).toBeGreaterThan(0);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeLessThanOrEqual(60_000);
  });

  it("is configurable", () => {
    expect(downstreamTimeoutMs({ OATHRION_MCP_TIMEOUT_MS: "5000" })).toBe(5_000);
  });

  it("refuses a value it cannot read rather than falling back", () => {
    /*
     * A fallback means the operator who wrote `6O000` with a letter O gets the
     * default and is never told. Refusing is the only answer that cannot
     * silently do something other than what was written.
     */
    for (const raw of ["6O000", "5s", "-1", "0", "1e4", "30_000"]) {
      expect(() => downstreamTimeoutMs({ OATHRION_MCP_TIMEOUT_MS: raw }), raw).toThrow();
    }
  });
});

describe("structural: the string checks are actually backed by a socket check", () => {
  const client = readFileSync(
    new URL("../gateway/tools/mcp-client.ts", import.meta.url),
    "utf8",
  );

  it("dispatches through the guarded transport, not through fetch", () => {
    /*
     * THE assertion of this file.
     *
     * Every check above inspects a string, and a string check cannot stop DNS
     * rebinding: the socket performs its own, later lookup. `sendGuarded`
     * installs a custom `lookup` that refuses blocked addresses at connect time,
     * declines to follow redirects, and bounds the response body. `fetch`
     * exposes no `lookup` hook and follows redirects by default, so a single
     * "simplification" back to `fetch` would silently remove the only
     * unraceable defence while leaving all the tests above green.
     */
    expect(client).toContain("sendGuarded");

    const codeOnly = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly, "mcp-client must not call fetch directly").not.toMatch(/\bawait fetch\(/);
    expect(codeOnly).not.toMatch(/=\s*fetch\(/);
  });

  it("passes a timeout to every downstream call", () => {
    const codeOnly = client.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).toMatch(/timeoutMs:\s*downstreamTimeoutMs\(\)/);
  });

  it("only exempts the loopback fixture from the address check", () => {
    /*
     * `allowPrivate` turns the connect-time guard off. It must be tied to the
     * fixture and to nothing else - not to an env var read here, not to a
     * boolean parameter a caller could set.
     */
    expect(client).toMatch(/allowPrivate:\s*destination\.kind === "LOCAL_FIXTURE"/);
  });

  it("resolves the destination through the guarded module", () => {
    expect(client).toContain("resolveDownstreamDestination");
    // and does not re-implement the check locally
    expect(client).not.toMatch(/OATHRION_MCP_ALLOWED_DESTINATIONS/);
  });

  it("refuses a downstream body that is not JSON instead of assuming success", () => {
    /*
     * A malformed reply is an EXECUTION failure. Reporting it as success would
     * put "the refund went through" in an audit trail on the strength of a page
     * of HTML from a proxy.
     */
    expect(client).toMatch(/not JSON/i);
    // and the attacker-influenced body is not echoed into the log
    const codeOnly = client.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/\$\{response\.body\}/);
  });
});

describe("each gate is proven on its own, not through the other", () => {
  /*
   * WHY THIS BLOCK EXISTS - a real gap, found by mutating the code.
   *
   * The helper `remote(url)` above puts the destination into the allowlist too,
   * because that is the realistic operator configuration. But it means an unsafe
   * destination is caught TWICE: once by the address rules applied to
   * OATHRION_MCP_DOWNSTREAM_URL, and once by the same rules applied to the identical
   * allowlist entry.
   *
   * That made most of the SSRF tests above pass for the wrong reason. Measured,
   * not assumed: mutating `assertGenerallySafe(url, "OATHRION_MCP_DOWNSTREAM_URL",
   * false)` to `true` - which disables the address rules on the destination
   * entirely - left all 35 tests green. A surviving mutant is a hole in the
   * tests, and a hole here means the primary gate could be removed without
   * anything noticing.
   *
   * These tests isolate the gates. Each one configures an allowlist that is
   * itself valid, so the only thing that can refuse the destination is the check
   * being tested.
   */

  /** A syntactically valid, safe allowlist that does NOT contain the target. */
  const SAFE_LIST = "https://mcp.example.com,https://tools.example.org";

  it("the destination's own address check refuses loopback, on its own", () => {
    /*
     * The mutant that survived. With a clean allowlist there is no second gate
     * to fall back on, so if the address rules stop applying to
     * OATHRION_MCP_DOWNSTREAM_URL this test fails - which is the point.
     */
    for (const url of [
      "http://127.0.0.1:9310",
      "http://localhost:9310",
      "http://[::1]:9310",
      "http://[::ffff:127.0.0.1]",
    ]) {
      expectRefused(
        { OATHRION_MCP_DOWNSTREAM_URL: url, OATHRION_MCP_ALLOWED_DESTINATIONS: SAFE_LIST },
        /loopback|localhost|routable/i,
      );
    }
  });

  it("the destination's own address check refuses metadata and private ranges, on its own", () => {
    for (const url of [
      "http://169.254.169.254",
      "http://metadata.google.internal",
      "http://10.0.0.5",
      "http://192.168.1.1",
      "http://172.20.0.1",
      "http://[fd00::1]",
      "http://[::ffff:169.254.169.254]",
      "https://vault.internal",
    ]) {
      expectRefused(
        { OATHRION_MCP_DOWNSTREAM_URL: url, OATHRION_MCP_ALLOWED_DESTINATIONS: SAFE_LIST },
        /refused|metadata|private|link-local|local|internal suffix/i,
      );
    }
  });

  it("refuses an unsafe address BEFORE reporting it as not allowlisted", () => {
    /*
     * Ordering, and it is not cosmetic. If the allowlist gate answered first,
     * every SSRF attempt would be reported as "not in the allowlist" - and the
     * obvious operator response to that message is to add it to the allowlist.
     * The error has to name the real reason.
     */
    let message = "";
    try {
      resolveDownstreamDestination({
        OATHRION_MCP_DOWNSTREAM_URL: "http://169.254.169.254",
        OATHRION_MCP_ALLOWED_DESTINATIONS: SAFE_LIST,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/metadata|link-local/i);
    expect(message).not.toMatch(/not in OATHRION_MCP_ALLOWED_DESTINATIONS/);
  });

  it("the allowlist gate refuses a perfectly safe public host that was not named", () => {
    /*
     * The mirror image, isolating the other gate: nothing about
     * `https://totally-fine.example.net` trips any address rule. The only thing
     * that can refuse it is the allowlist.
     */
    expectRefused(
      {
        OATHRION_MCP_DOWNSTREAM_URL: "https://totally-fine.example.net",
        OATHRION_MCP_ALLOWED_DESTINATIONS: SAFE_LIST,
      },
      /not in OATHRION_MCP_ALLOWED_DESTINATIONS/,
    );
  });

  it("an allowlisted loopback entry does not unlock a loopback destination", () => {
    /*
     * The laundering attempt: put the loopback origin in the allowlist so the
     * allowlist gate passes, and hope the address gate was only ever the
     * allowlist gate in disguise.
     *
     * It is refused twice over - the allowlist parser rejects the entry, and the
     * address rules reject the destination - and this test asserts the outcome
     * rather than which of the two spoke first, because either is correct and
     * pinning the order here would make the test brittle for no gain.
     */
    expectRefused(
      {
        OATHRION_MCP_DOWNSTREAM_URL: "http://127.0.0.1:9310",
        OATHRION_MCP_ALLOWED_DESTINATIONS: "http://127.0.0.1:9310,https://mcp.example.com",
      },
      /loopback|refused/i,
    );
  });

  it("the dangerous-port check applies to the destination itself", () => {
    // Same isolation: the allowlist is clean, so only the port rule can refuse.
    expectRefused(
      {
        OATHRION_MCP_DOWNSTREAM_URL: "https://mcp.example.com:6379",
        OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.example.com:6379,https://mcp.example.com",
      },
      /Redis/i,
    );
  });
});
