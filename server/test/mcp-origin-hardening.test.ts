/**
 * Phase 6.5 — Origin validation on the MCP endpoint, hardened.
 *
 * WHAT WAS ALREADY RIGHT, AND IS ASSERTED HERE SO IT STAYS RIGHT
 * -------------------------------------------------------------
 * `isLoopbackOrigin` already parsed with `URL` instead of substring-matching, so
 * `https://localhost.evil.com` was already refused. `Origin: null` was already
 * refused rather than treated as absent. Those are pinned below because they are
 * the two mistakes this check is usually written with.
 *
 * WHAT WAS ACTUALLY WEAK
 * ----------------------
 * 1. The allowlist was compared by exact string. An operator writing
 *    `https://Console.Example.com`, `https://console.example.com/` or
 *    `https://console.example.com:443` configured an entry that could never
 *    match the header a browser sends. Fail-closed — and for a reason with no
 *    relationship to what they meant. Both sides are now canonicalised through
 *    `URL.origin`.
 *
 * 2. An unparseable entry was silently inert. Inert is safe; silent is not. An
 *    operator who believes they permitted an origin they did not has a
 *    misconfiguration that only surfaces as a support ticket. Invalid entries
 *    are now reported on the server log, and the valid ones still enforced.
 *
 * 3. `*` looked like a wildcard and was not one. It happened to be safe,
 *    because an exact match against `*` never matched a real `Origin`. That is
 *    the dangerous kind of safe: a configuration that reads as "open this up",
 *    does nothing, and invites a later maintainer to make it work as written.
 *    It is now an invalid entry, named as such in the log.
 *
 * 4. A request with NO `Origin` was allowed unconditionally. It has to be —
 *    agent runtimes, CLIs and SDKs do not send one — but "no Origin" is also
 *    what some browser requests look like, and those are exactly what the MCP
 *    spec's DNS-rebinding requirement is about. `Sec-Fetch-Site` now covers
 *    that gap: it is a forbidden header name, so page script cannot write it,
 *    and when it says `cross-site` the request came from a browser on another
 *    site whatever the `Origin` says.
 *
 * HOW MUCH THIS BUYS, STATED HONESTLY
 * -----------------------------------
 * None of it stops a non-browser attacker, who omits both headers exactly as a
 * legitimate CLI does, and is then judged by authentication, capabilities and
 * policy. This is defence in depth on a path that Oathrion does not rely on: auth is
 * `Authorization: Bearer` with no cookies, so a browser cannot make an
 * authenticated cross-origin request on a user's behalf regardless. The value is
 * that it fails closed if cookie or session auth is ever introduced — the change
 * that would otherwise silently re-open the hole — and that a gateway claiming
 * MCP compliance should not skip a MUST.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  allowedOrigins,
  readAllowlist,
  resetOriginWarnings,
  validateOrigin,
} from "../mcp/http-validation";
import { OATHRION_RPC_ERRORS, RpcFault } from "../mcp/protocol";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { ROLE_KEYS, startTestServer, TEST_API_KEY, type TestClient } from "./harness";

/** Runs `body` with `OATHRION_MCP_ALLOWED_ORIGINS` set, and always restores it. */
function withAllowlist(value: string | undefined, body: () => void): void {
  const previous = process.env.OATHRION_MCP_ALLOWED_ORIGINS;
  if (value === undefined) delete process.env.OATHRION_MCP_ALLOWED_ORIGINS;
  else process.env.OATHRION_MCP_ALLOWED_ORIGINS = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.OATHRION_MCP_ALLOWED_ORIGINS;
    else process.env.OATHRION_MCP_ALLOWED_ORIGINS = previous;
  }
}

/** The refusal, or `null` if the origin was permitted. */
function refusalFor(origin: string | undefined, secFetchSite?: string): RpcFault | null {
  try {
    validateOrigin(origin, secFetchSite);
    return null;
  } catch (error) {
    if (error instanceof RpcFault) return error;
    throw error;
  }
}

describe("MCP Origin validation", () => {
  afterEach(() => {
    resetOriginWarnings();
    vi.restoreAllMocks();
  });

  describe("the default: loopback only", () => {
    it("permits loopback on any port, over http and https, including IPv6", () => {
      withAllowlist(undefined, () => {
        expect(allowedOrigins()).toBe("loopback");
        for (const origin of [
          "http://localhost:5173",
          "http://localhost",
          "http://127.0.0.1:3000",
          "https://localhost:8443",
          "http://[::1]:5173",
        ]) {
          expect(refusalFor(origin), origin).toBeNull();
        }
      });
    });

    it("refuses a hostname that merely CONTAINS a loopback name", () => {
      /*
       * The classic bug in this check, and the reason it is parsed rather than
       * matched. Every origin below is fully controlled by whoever owns the
       * domain, and a substring test accepts all of them.
       */
      withAllowlist(undefined, () => {
        for (const origin of [
          "https://localhost.evil.com",
          "https://evil.com/localhost",
          "https://127.0.0.1.evil.com",
          "https://notlocalhost",
          "https://localhost-evil.com",
        ]) {
          const refusal = refusalFor(origin);
          expect(refusal, `${origin} was permitted`).not.toBeNull();
          expect(refusal!.status).toBe(403);
          expect(refusal!.code).toBe(OATHRION_RPC_ERRORS.originRejected);
        }
      });
    });

    it("refuses a non-http scheme that resolves to a loopback host", () => {
      withAllowlist(undefined, () => {
        // `file://` and custom schemes are not origins this endpoint serves, and
        // `URL` will happily parse them.
        expect(refusalFor("file://localhost")).not.toBeNull();
        expect(refusalFor("ftp://127.0.0.1")).not.toBeNull();
      });
    });
  });

  describe("Origin: null", () => {
    it("is refused, and is NOT treated as an absent header", () => {
      /*
       * Browsers send `Origin: null` from a sandboxed iframe, a `file://`
       * document, and some redirect chains. That is a browser context that
       * cannot be attributed — the opposite of a CLI that sends no header at
       * all — so waving it through as "no origin" would accept precisely the
       * contexts an attacker can arrange.
       */
      withAllowlist(undefined, () => {
        const refusal = refusalFor("null");
        expect(refusal).not.toBeNull();
        expect(refusal!.status).toBe(403);
        expect(refusal!.message).toMatch(/opaque origin/i);
      });
    });

    it("is refused even when an allowlist is configured", () => {
      withAllowlist("https://console.example.com", () => {
        expect(refusalFor("null")).not.toBeNull();
      });
    });
  });

  describe("allowlist canonicalisation", () => {
    it("accepts the origin whatever case, trailing slash or default port the operator wrote", () => {
      /*
       * The hardening. All four spellings mean one origin; before Phase 6 only
       * the exact one a browser happens to send would have matched.
       */
      for (const configured of [
        "https://console.example.com",
        "https://Console.Example.COM",
        "https://console.example.com/",
        "https://console.example.com:443",
      ]) {
        withAllowlist(configured, () => {
          expect(refusalFor("https://console.example.com"), configured).toBeNull();
        });
      }
    });

    it("canonicalises the HEADER as well, so the comparison is origin to origin", () => {
      withAllowlist("https://console.example.com", () => {
        expect(refusalFor("https://CONSOLE.example.com")).toBeNull();
        expect(refusalFor("https://console.example.com:443")).toBeNull();
      });
    });

    it("does not let a path in the configured entry widen or narrow the match", () => {
      /*
       * An `Origin` header never carries a path, so `URL.origin` drops it. The
       * operator's entry is honoured as the origin they named — not silently
       * ignored, and not turned into a path prefix rule that this endpoint has
       * no way to enforce.
       */
      withAllowlist("https://console.example.com/mcp", () => {
        expect(refusalFor("https://console.example.com")).toBeNull();
      });
    });

    it("still refuses a DIFFERENT origin, including scheme, port and subdomain", () => {
      withAllowlist("https://console.example.com", () => {
        for (const origin of [
          "http://console.example.com", // scheme differs
          "https://console.example.com:8443", // non-default port differs
          "https://evil.console.example.com", // subdomain differs
          "https://console.example.com.evil.com", // suffix attack
          "https://example.com",
        ]) {
          expect(refusalFor(origin), `${origin} was permitted`).not.toBeNull();
        }
      });
    });

    it("enforces every entry of a multi-entry list, and tolerates whitespace", () => {
      withAllowlist(" https://a.example.com , https://b.example.com ", () => {
        expect(refusalFor("https://a.example.com")).toBeNull();
        expect(refusalFor("https://b.example.com")).toBeNull();
        expect(refusalFor("https://c.example.com")).not.toBeNull();
      });
    });
  });

  describe("`*` is not a wildcard", () => {
    it("does not permit an arbitrary origin", () => {
      withAllowlist("*", () => {
        const refusal = refusalFor("https://evil.com");
        expect(refusal, "`*` acted as a wildcard").not.toBeNull();
        expect(refusal!.status).toBe(403);
      });
    });

    it("does not even permit loopback — it replaces the default, it does not extend it", () => {
      /*
       * Worth pinning explicitly: setting the variable at all switches off the
       * loopback default. An operator who sets `*` expecting "everything" gets
       * "nothing", which is the safe direction and the surprising one.
       */
      withAllowlist("*", () => {
        expect(refusalFor("http://localhost:5173")).not.toBeNull();
      });
    });

    it("is reported as an invalid entry rather than silently ignored", () => {
      withAllowlist("*", () => {
        const allowlist = readAllowlist();
        expect(allowlist).not.toBe("loopback");
        expect((allowlist as { origins: string[]; invalid: string[] }).origins).toEqual([]);
        expect((allowlist as { origins: string[]; invalid: string[] }).invalid).toEqual(["*"]);
      });
    });
  });

  describe("malformed entries are reported, not swallowed", () => {
    it("warns once, names the entries, and keeps enforcing the valid ones", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      withAllowlist("not-a-url, *, https://good.example.com", () => {
        // The valid entry still works...
        expect(refusalFor("https://good.example.com")).toBeNull();
        // ...and the invalid ones grant nothing.
        expect(refusalFor("https://evil.example.com")).not.toBeNull();

        expect(warn).toHaveBeenCalled();
        const message = warn.mock.calls.map((call) => String(call[0])).join("\n");
        expect(message).toContain("OATHRION_MCP_ALLOWED_ORIGINS");
        expect(message).toContain("not-a-url");
        expect(message).toContain("*");
        // The operator is told there is no wildcard, since `*` is the entry most
        // likely to have been written on purpose.
        expect(message).toMatch(/not supported as a wildcard/i);
      });
    });

    it("does not repeat the warning on every request", () => {
      // A message printed once per call to a rate-limited endpoint is a message
      // nobody reads.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      withAllowlist("not-a-url", () => {
        refusalFor("https://a.example.com");
        refusalFor("https://b.example.com");
        refusalFor("https://c.example.com");
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });

    it("warns again for a DIFFERENT bad configuration", () => {
      // Once per distinct value, not once per process: an operator who fixes one
      // typo and introduces another must still hear about it.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      withAllowlist("bad-one", () => refusalFor("https://a.example.com"));
      withAllowlist("bad-two", () => refusalFor("https://a.example.com"));
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("treats an empty or whitespace-only value as unset, without warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const value of ["", "   ", " , , "]) {
        withAllowlist(value, () => {
          // Empty means "no override", so the loopback default applies. It must
          // NOT mean "an empty allowlist that refuses the bundled console".
          if (value.trim().length === 0) expect(allowedOrigins()).toBe("loopback");
          expect(refusalFor("http://localhost:5173"), JSON.stringify(value)).toBeNull();
        });
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("Sec-Fetch-Site closes the absent-Origin gap", () => {
    it("still allows a request with no Origin and no Sec-Fetch-Site", () => {
      /*
       * The load-bearing case: this is every agent runtime, CLI and SDK. If this
       * ever starts failing, the gateway has stopped serving its actual clients.
       */
      withAllowlist(undefined, () => {
        expect(refusalFor(undefined)).toBeNull();
      });
    });

    it("refuses a browser that attests it came cross-site with no Origin", () => {
      withAllowlist(undefined, () => {
        const refusal = refusalFor(undefined, "cross-site");
        expect(refusal).not.toBeNull();
        expect(refusal!.status).toBe(403);
        expect(refusal!.code).toBe(OATHRION_RPC_ERRORS.originRejected);
        expect(refusal!.message).toMatch(/Sec-Fetch-Site/);
        // The message says why the header is worth anything at all, because the
        // caller reading it may be the operator debugging their own console.
        expect(refusal!.message).toMatch(/cannot be forged by page script/i);
      });
    });

    it("refuses `same-site`, which is a sibling subdomain and still not this origin", () => {
      withAllowlist(undefined, () => {
        expect(refusalFor(undefined, "same-site")).not.toBeNull();
      });
    });

    it("allows `same-origin` and `none`", () => {
      withAllowlist(undefined, () => {
        // `none` is a user typing the URL or following a bookmark.
        expect(refusalFor(undefined, "same-origin")).toBeNull();
        expect(refusalFor(undefined, "none")).toBeNull();
      });
    });

    it("is case- and whitespace-insensitive", () => {
      withAllowlist(undefined, () => {
        expect(refusalFor(undefined, " CROSS-SITE ")).not.toBeNull();
      });
    });

    it("ignores an unrecognised value rather than failing closed on a new browser", () => {
      /*
       * Deliberate, and the one place here that does NOT fail closed. The value
       * set is defined by the Fetch standard and this header is advisory
       * defence-in-depth, not the barrier; refusing an unknown token would mean
       * a future browser revision could take a working deployment offline for no
       * security gain. An attacker gains nothing either way — they can already
       * omit the header entirely.
       */
      withAllowlist(undefined, () => {
        expect(refusalFor(undefined, "some-future-value")).toBeNull();
        expect(refusalFor(undefined, "")).toBeNull();
      });
    });

    it("does not override a PRESENT and allowlisted Origin", () => {
      /*
       * When `Origin` is there it is the authority. An operator who allowlists
       * their console at another host is describing a cross-site request on
       * purpose, and this header must not quietly overrule that decision.
       */
      withAllowlist("https://console.example.com", () => {
        expect(refusalFor("https://console.example.com", "cross-site")).toBeNull();
      });
    });

    it("does not rescue a PRESENT and non-allowlisted Origin", () => {
      // The mirror: a friendly `Sec-Fetch-Site` cannot buy an origin past the list.
      withAllowlist("https://console.example.com", () => {
        expect(refusalFor("https://evil.com", "same-origin")).not.toBeNull();
      });
    });
  });
});

describe("MCP Origin validation over HTTP", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  /** A well-formed `tools/list`, so a refusal can only come from the envelope. */
  function frame(): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientCapabilities]: {},
        },
      },
    };
  }

  function headers(extra: Record<string, string>): Record<string, string> {
    return {
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "tools/list",
      "X-Oathrion-Agent-Id": "agt_billing",
      ...extra,
    };
  }

  it("refuses a cross-site browser request before the JSON-RPC frame is examined", async () => {
    /*
     * The body is valid JSON and NOT a valid JSON-RPC frame: no `method`, no
     * `jsonrpc`. If the answer is the Origin refusal rather than a frame error,
     * the envelope check genuinely ran first — the property that stops a hostile
     * page using this endpoint to probe behaviour or spend its rate budget.
     *
     * SCOPED CLAIM, corrected after measuring. The first version of this test
     * sent a bare string as the body to prove the check ran "before the body is
     * parsed", and got a 400 of Express HTML. Express's own JSON body parser
     * runs before any route handler, so that claim was never true and could not
     * be made true here. What IS true is the narrower and still useful thing:
     * this check precedes Oathrion's interpretation of the frame.
     */
    const res = await api.post<{ error?: { code: number; message: string } }>(
      "/api/mcp",
      { not: "a frame" },
      {
        auth: TEST_API_KEY,
        headers: headers({ Origin: "https://evil.example.com" }),
      },
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
    expect(res.body.error?.message).toMatch(/not permitted/i);
  });

  it("answers 401, not 403, to an anonymous caller — auth is the outer gate", async () => {
    /*
     * Recorded because it corrects an assumption this file was written on.
     * `authenticate()` is mounted on `/api` and `/api/mcp` is beneath it, so an
     * unauthenticated request never reaches the Origin check at all. The
     * envelope validation is therefore not a pre-auth surface, and any reasoning
     * that depends on it being one is wrong.
     *
     * Pinned rather than deleted: if the MCP route is ever moved out from under
     * that gate — the change the route's own docblock warns about — this test
     * fails, which is the earliest anything would notice.
     */
    const res = await api.post("/api/mcp", frame(), {
      auth: null,
      headers: headers({ Origin: "https://evil.example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses on Sec-Fetch-Site alone when no Origin is sent", async () => {
    const res = await api.post<{ error?: { code: number; message: string } }>(
      "/api/mcp",
      frame(),
      { auth: TEST_API_KEY, headers: headers({ "Sec-Fetch-Site": "cross-site" }) },
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
  });

  it("does not echo the configured allowlist to the caller it refuses", async () => {
    /*
     * The refusal may name the origin the caller itself sent and the variable an
     * operator would set. It must not enumerate the origins a deployment trusts:
     * that is reconnaissance, and the caller here holds nothing but `read`.
     *
     * A viewer, not an anonymous request — see the 401 test above for why the
     * anonymous case never reaches this code.
     */
    const previous = process.env.OATHRION_MCP_ALLOWED_ORIGINS;
    process.env.OATHRION_MCP_ALLOWED_ORIGINS = "https://secret-console.internal.example.com";
    try {
      const res = await api.post<{ error?: { message: string } }>("/api/mcp", frame(), {
        auth: ROLE_KEYS.viewer,
        headers: headers({ Origin: "https://evil.example.com" }),
      });
      expect(res.status).toBe(403);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("secret-console.internal.example.com");
      expect(body).toContain("evil.example.com");
    } finally {
      if (previous === undefined) delete process.env.OATHRION_MCP_ALLOWED_ORIGINS;
      else process.env.OATHRION_MCP_ALLOWED_ORIGINS = previous;
    }
  });

  it("permits a loopback Origin, which is what the bundled console sends", async () => {
    const res = await api.post<{ result?: unknown; error?: unknown }>("/api/mcp", frame(), {
      auth: TEST_API_KEY,
      headers: headers({ Origin: "http://localhost:5173", "Sec-Fetch-Site": "same-origin" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result).toBeDefined();
  });

  it("permits a non-browser request that sends neither header", async () => {
    const res = await api.post<{ result?: unknown }>("/api/mcp", frame(), {
      auth: TEST_API_KEY,
      headers: headers({}),
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });
});
