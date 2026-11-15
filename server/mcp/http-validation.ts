/**
 * HTTP-level validation for the MCP endpoint: `Origin` and `Accept`.
 *
 * Separate from `protocol.ts` because these are properties of the HTTP request
 * rather than of the JSON-RPC frame. A request can be rejected here without the
 * body ever being parsed, which is the point: an `Origin` check that runs after
 * the body has been interpreted has already lost.
 *
 * WHY `Origin` IS CHECKED, AND HOW MUCH IT ACTUALLY BUYS HERE
 * ----------------------------------------------------------
 * The MCP transport specification requires it:
 *
 *   "Servers MUST validate the `Origin` header on all incoming connections to
 *    prevent DNS rebinding attacks."
 *
 * The attack it addresses: a page the user has open in a browser resolves a
 * hostname it controls to `127.0.0.1` and then posts to a locally-bound server.
 * The browser will happily send the request; the server sees it arrive on
 * loopback and assumes it came from the machine's owner.
 *
 * An honest statement of what this check is worth in Oathrion specifically, rather
 * than the generic version of the claim: **it is defence in depth, not the
 * barrier that stops the attack.** Oathrion authenticates with `Authorization:
 * Bearer` and uses no cookies at all — console sessions are bearer tokens held
 * in memory, not cookies (see the note at the top of `server/auth.ts`). A
 * browser therefore cannot make an authenticated cross-origin request on the
 * user's behalf, because it has nothing to attach; such a request fails at the
 * `401` from the auth gate whether or not `Origin` is checked.
 *
 * The check is still worth having, for reasons that do not depend on that
 * analysis staying true:
 *
 *   1. it fails closed if cookie or session-based auth is ever introduced,
 *      which is exactly the change that would silently re-open the hole;
 *   2. it rejects the request before the body is parsed, so a hostile page
 *      cannot use the endpoint to probe behaviour or consume rate-limit budget;
 *   3. the spec requires it, and a gateway that claims MCP compliance while
 *      skipping a MUST is misrepresenting itself.
 *
 * WHAT AN ABSENT `Origin` MEANS
 * -----------------------------
 * It is allowed. `Origin` is set by browsers; the MCP clients this gateway
 * exists to serve are agent runtimes, CLIs and SDKs, which do not send it.
 * Requiring it would reject every legitimate caller while stopping nothing —
 * a non-browser attacker simply omits or forges the header, since only a
 * browser is bound to send it truthfully. The header is only evidence when it
 * is present, so it is only checked when present.
 *
 * The literal string `"null"` is NOT treated as absent. Browsers send
 * `Origin: null` from sandboxed iframes, `file://` documents and some redirect
 * chains — an opaque origin. That is a browser context that cannot be
 * attributed, so it is refused rather than waved through as "no origin".
 *
 * Since Phase 6, absent `Origin` is additionally cross-checked against
 * `Sec-Fetch-Site` — see `FOREIGN_FETCH_SITES` below. That covers the browser
 * requests that arrive without an `Origin`, and covers nothing else, because
 * nothing else is obliged to send either header truthfully.
 *
 * CONFIGURING THIS FOR A DEPLOYMENT
 * --------------------------------
 * Development / self-hosted on the operator's own machine
 *   Leave `OATHRION_MCP_ALLOWED_ORIGINS` unset. The default is loopback on any
 *   port, which is what the bundled console uses.
 *
 * Anything reachable from another host
 *   Set `OATHRION_MCP_ALLOWED_ORIGINS` to the exact origins of the browser-based
 *   consoles that will call this endpoint, comma-separated, e.g.
 *   `https://console.example.com,https://ops.example.com`. Entries are
 *   canonicalised, so capitals, a trailing slash and an explicit `:443` are all
 *   accepted and mean the same thing. Anything that is not an http(s) origin —
 *   including `*` — is ignored with a warning on the server log; there is no
 *   wildcard.
 *
 *   Leaving it unset in that deployment does not open the endpoint up: the
 *   default stays loopback-only, so a browser console on another host is
 *   refused. The failure is visible and safe, which is the intended direction.
 *
 * Non-browser callers (agent runtimes, CLIs, CI)
 *   Unaffected by this variable. They send no `Origin`, so they are governed by
 *   authentication, capabilities and policy, not by this file.
 */

import { OATHRION_RPC_ERRORS, RpcFault } from "./protocol";

/**
 * The result of reading `OATHRION_MCP_ALLOWED_ORIGINS`.
 *
 * `invalid` is carried rather than discarded so a misconfiguration can be
 * reported. Dropping unparseable entries silently is fail-closed for the origin
 * in question — an entry that cannot be parsed can never match anything — but it
 * leaves an operator believing they permitted an origin they did not. The
 * failure mode being fixed here is a silent one, not an unsafe one.
 */
interface OriginAllowlist {
  origins: string[];
  invalid: string[];
}

/**
 * Canonical form of an origin, or `null` if it is not one.
 *
 * `URL.origin` is the canonicalisation: it lowercases the scheme and host,
 * drops the default port for the scheme, and drops any path, query or fragment.
 * That matters because the comparison used to be an exact string match against
 * raw configuration, and an operator writing any of
 *
 *   `https://Console.Example.com`   (capitals)
 *   `https://console.example.com/`  (trailing slash)
 *   `https://console.example.com:443` (explicit default port)
 *
 * would have configured an entry that could never match the header a browser
 * actually sends. Fail-closed, but for a reason with no relationship to the
 * operator's intent.
 *
 * Anything that is not an http(s) origin returns `null`, including
 * `*`. See `readAllowlist` for why `*` is handled here rather than specially.
 */
function canonicalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // "null" for a URL whose scheme is not special; not reachable via the guard
  // above, but the check is cheap and the value is security-relevant.
  if (url.origin === "null") return null;
  return url.origin;
}

/**
 * Origins accepted when the header is present.
 *
 * Defaults to loopback on any port, which is what a self-hosted deployment and
 * the bundled console actually use. Overridable with
 * `OATHRION_MCP_ALLOWED_ORIGINS` as a comma-separated list of origins.
 *
 * Read per call rather than cached at module load, so a test can set it without
 * fighting module caching, and so an operator changing it does not need a
 * restart to be sure it took effect.
 *
 * `*` IS NOT A WILDCARD, AND IS REFUSED AS AN ENTRY
 * ------------------------------------------------
 * It parses as no origin, so it lands in `invalid` and is reported. It was
 * already inert — an exact string match against `*` never matched a real
 * `Origin` — so this changes no behaviour; it changes whether the operator finds
 * out. An entry that looks like it opens the endpoint up, and silently does
 * nothing, is the kind of configuration that gets "fixed" later by someone
 * making it work as written.
 */
export function readAllowlist(): OriginAllowlist | "loopback" {
  const configured = process.env.OATHRION_MCP_ALLOWED_ORIGINS;
  if (!configured || configured.trim().length === 0) return "loopback";

  const origins: string[] = [];
  const invalid: string[] = [];

  for (const raw of configured.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const canonical = canonicalOrigin(entry);
    if (canonical === null) invalid.push(entry);
    else origins.push(canonical);
  }

  /*
   * A value made only of separators — `","`, `" , , "` — carries no entries at
   * all, so it is treated exactly like an unset variable rather than as an
   * allowlist that happens to be empty.
   *
   * This is a consistency fix, not a relaxation. Before it, `""` and `"   "`
   * meant "not configured, use the loopback default" while `" , , "` meant
   * "configured with nothing, refuse every origin including the bundled
   * console" — three indistinguishable typos with two different meanings, one of
   * which takes the console offline. A configuration language in which
   * whitespace and a comma mean opposite things is a configuration language that
   * will be got wrong.
   *
   * Note the case NOT folded in here: a value with entries that are all
   * INVALID (`"*"`, `"not-a-url"`) still yields an empty `origins` and therefore
   * refuses everything. That is deliberate and is the fail-closed direction —
   * the operator named something, none of it parsed, and quietly substituting a
   * permissive default for garbage input is how a deployment ends up trusting an
   * origin nobody chose. They are told on the log instead.
   */
  if (origins.length === 0 && invalid.length === 0) return "loopback";

  return { origins, invalid };
}

/**
 * Backwards-compatible view of the allowlist.
 *
 * Kept because it is the shape the existing tests and callers were written
 * against, and Phase 6 is not licensed to churn an interface for tidiness. It
 * now returns canonicalised origins.
 */
export function allowedOrigins(): string[] | "loopback" {
  const allowlist = readAllowlist();
  return allowlist === "loopback" ? "loopback" : allowlist.origins;
}

/**
 * Warns once per distinct bad configuration value.
 *
 * Once per distinct value rather than once per process, so an operator who
 * fixes one typo and introduces another still hears about it; and not once per
 * request, because a message repeated on every call to a rate-limited endpoint
 * is a message nobody reads.
 */
const warnedAllowlists = new Set<string>();

function warnAboutInvalidEntries(invalid: string[]): void {
  if (invalid.length === 0) return;
  const key = invalid.join("|");
  if (warnedAllowlists.has(key)) return;
  warnedAllowlists.add(key);
  console.warn(
    `[oathrion][mcp] OATHRION_MCP_ALLOWED_ORIGINS contains ${invalid.length} entr${
      invalid.length === 1 ? "y" : "ies"
    } that are not http(s) origins and will never match: ${invalid
      .map((entry) => JSON.stringify(entry))
      .join(", ")}. ` +
      `An origin is scheme://host[:port] with no path — "*" is not supported as a wildcard. ` +
      `These entries are ignored; the remaining entries are still enforced.`,
  );
}

/** Test seam: forget which configurations have already been warned about. */
export function resetOriginWarnings(): void {
  warnedAllowlists.clear();
}

/**
 * True for `http://localhost:*` and `http://127.0.0.1:*` (and the IPv6
 * loopback), which is the default policy.
 *
 * Parsed with `URL` rather than matched with a substring test. A check like
 * `origin.includes("localhost")` accepts `https://localhost.evil.com`, which is
 * an origin fully controlled by an attacker.
 */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // `hostname` for an IPv6 literal comes back bracketed.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * `Sec-Fetch-Site` values that mean a browser sent this request from a
 * document that is not this origin.
 *
 * WHY THIS HEADER IS CONSULTED AT ALL
 * -----------------------------------
 * It closes the one case `Origin` cannot: a request with NO `Origin` header.
 * Absent `Origin` has to be allowed, because the clients this gateway exists to
 * serve — agent runtimes, CLIs, SDKs — do not send it. But "no Origin" is also
 * what some browser requests look like, and those are precisely the requests
 * the MCP spec's DNS-rebinding requirement is about.
 *
 * `Sec-Fetch-Site` is a forbidden header name: it is set by the browser and
 * cannot be written by page script. So when it is present and says
 * `cross-site`, the request came from a browser, from another site, and the
 * absence of `Origin` does not make it trustworthy.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It stops nothing that is not a browser. A non-browser attacker omits the
 * header, exactly as it omits `Origin`, and is judged by the `Origin` rule
 * (which permits absence) and then by the `401` from the auth gate. This is
 * strictly a second browser-attested signal, not a new barrier — the same
 * honest framing as the `Origin` check above, which is defence in depth because
 * Oathrion uses bearer tokens and no cookies.
 *
 * `same-site` is included: a sibling subdomain is still not this origin, and if
 * an operator wants it accepted they can allowlist it, at which point `Origin`
 * is present and authoritative. `none` (a user typing the URL or a bookmark) and
 * `same-origin` are allowed.
 */
const FOREIGN_FETCH_SITES = new Set(["cross-site", "same-site"]);

/**
 * Rejects a request whose `Origin` is present and not permitted, or which a
 * browser has attested came from another site.
 *
 * `403`, because the request is well-formed and understood: it is the caller
 * that is not allowed to make it.
 *
 * NOTE ON WHAT IS SAID TO THE CALLER.
 *
 * A correction, recorded rather than quietly fixed: this was first written on
 * the assumption that the envelope check runs before authentication, and it does
 * not. `authenticate()` is mounted on `/api` and `/api/mcp` sits beneath it, so
 * an unauthenticated request is answered `401` and never reaches this file. A
 * test asserting a `403` for an anonymous caller is what established that; the
 * assumption would otherwise have survived as a comment nobody re-checked.
 *
 * The refusal is therefore visible only to an authenticated caller — but that
 * caller may hold nothing but `read`, so the reasoning stands with a smaller
 * claim attached to it. The message names the origin the caller itself sent and
 * the variable to set; it deliberately does NOT echo the configured allowlist or
 * the invalid entries in it, because the set of origins a deployment trusts is
 * reconnaissance and the operator who needs that detail is reading the server
 * log, not an HTTP response.
 */
export function validateOrigin(
  origin: string | undefined,
  secFetchSite?: string | undefined,
): void {
  if (origin === "null") {
    throw new RpcFault(
      OATHRION_RPC_ERRORS.originRejected,
      'Origin "null" is refused. An opaque origin — a sandboxed iframe, a file:// document — cannot be attributed to a caller, so it is not treated as an absent Origin.',
      403,
    );
  }

  if (origin === undefined) {
    const site = secFetchSite?.trim().toLowerCase();
    if (site !== undefined && FOREIGN_FETCH_SITES.has(site)) {
      throw new RpcFault(
        OATHRION_RPC_ERRORS.originRejected,
        `Refused: Sec-Fetch-Site "${site}" states this request was made by a browser from another site, and it carries no Origin header to check against the allowlist. Sec-Fetch-Site is set by the browser and cannot be forged by page script.`,
        403,
      );
    }
    // No Origin and no browser-attested cross-site marker: allowed, per the
    // reasoning in this file's header.
    return;
  }

  const allowlist = readAllowlist();
  let permitted: boolean;

  if (allowlist === "loopback") {
    permitted = isLoopbackOrigin(origin);
  } else {
    warnAboutInvalidEntries(allowlist.invalid);
    // The header is canonicalised too, so the comparison is origin-to-origin
    // rather than string-to-string.
    const canonical = canonicalOrigin(origin);
    permitted = canonical !== null && allowlist.origins.includes(canonical);
  }

  if (!permitted) {
    throw new RpcFault(
      OATHRION_RPC_ERRORS.originRejected,
      `Origin "${origin}" is not permitted. The MCP transport specification requires servers to validate Origin to prevent DNS rebinding. Set OATHRION_MCP_ALLOWED_ORIGINS to permit additional origins.`,
      403,
    );
  }
}

/** One parsed entry of an `Accept` header. */
interface MediaRange {
  type: string;
  subtype: string;
  quality: number;
}

/**
 * Parses `Accept` into media ranges with their q-values.
 *
 * Written out rather than reduced to `header.includes("application/json")`,
 * because that shortcut gets two real cases wrong:
 *
 *   - `Accept: application/json;q=0` explicitly states that JSON is NOT
 *     acceptable. RFC 9110: "a value of 0 means not acceptable." A substring
 *     test reads it as acceptance and returns a body the client has said it
 *     cannot handle.
 *   - `Accept: application/*` and `Accept: * / *` are both acceptance of JSON,
 *     and a substring test rejects them.
 *
 * A malformed q-value is treated as 1 rather than 0: the client clearly meant
 * to express a preference, and defaulting to "not acceptable" would turn a
 * typo into an outage.
 */
function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];

  for (const part of header.split(",")) {
    const segments = part.split(";");
    const media = segments[0]?.trim().toLowerCase();
    if (!media) continue;

    const slash = media.indexOf("/");
    if (slash === -1) continue;

    let quality = 1;
    for (const parameter of segments.slice(1)) {
      const [rawKey, rawValue] = parameter.split("=");
      if (rawKey?.trim().toLowerCase() !== "q") continue;
      const parsed = Number.parseFloat(rawValue ?? "");
      if (Number.isFinite(parsed)) quality = parsed;
    }

    ranges.push({
      type: media.slice(0, slash),
      subtype: media.slice(slash + 1),
      quality,
    });
  }

  return ranges;
}

/** Whether the header permits a `type/subtype` response body. */
function accepts(ranges: MediaRange[], type: string, subtype: string): boolean {
  return ranges.some(
    (range) =>
      range.quality > 0 &&
      (range.type === "*" || range.type === type) &&
      (range.subtype === "*" || range.subtype === subtype),
  );
}

/**
 * Rejects a request that cannot accept the only content type this endpoint
 * produces.
 *
 * WHAT IS ENFORCED, AND WHAT IS DELIBERATELY NOT
 * ----------------------------------------------
 * The specification puts a MUST on the *client*: it "MUST include an `Accept`
 * header, listing both `application/json` and `text/event-stream`".
 *
 * This server enforces the half that is load-bearing — that the caller can
 * accept `application/json` — and does NOT reject a client for omitting
 * `text/event-stream`.
 *
 * That is a deliberate decision rather than an oversight, and the reasoning is
 * the one the brief asks for: this gateway never opens an SSE stream. Every
 * response is a single JSON body. Refusing a caller for failing to advertise
 * support for a transport that will never be used would be a check that
 * enforces nothing about this server's behaviour — the definition of a cosmetic
 * validation. It would also break correct clients for no gain in safety.
 *
 * Enforcing the JSON half is not cosmetic: it is the difference between
 * answering with a body the client can read and one it cannot.
 *
 * A missing `Accept` is allowed and means "anything", per RFC 9110.
 */
export function validateAccept(accept: string | undefined): void {
  if (accept === undefined || accept.trim().length === 0) return;

  const ranges = parseAccept(accept);
  if (ranges.length === 0) {
    throw new RpcFault(
      OATHRION_RPC_ERRORS.notAcceptable,
      `Malformed Accept header: "${accept}".`,
      406,
    );
  }

  if (!accepts(ranges, "application", "json")) {
    throw new RpcFault(
      OATHRION_RPC_ERRORS.notAcceptable,
      `This endpoint returns application/json, which Accept "${accept}" does not permit. Note that "q=0" states a type is not acceptable.`,
      406,
    );
  }
}

/**
 * Both HTTP checks, in the order that rejects the cheapest failure first.
 *
 * Called before the JSON-RPC frame is parsed.
 */
export function validateHttpEnvelope(headers: {
  origin?: string;
  accept?: string;
  secFetchSite?: string;
}): void {
  validateOrigin(headers.origin, headers.secFetchSite);
  validateAccept(headers.accept);
}
