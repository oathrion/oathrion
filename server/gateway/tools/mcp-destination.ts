/**
 * Where Oathrion is allowed to dispatch an authorised action. (Phase 9)
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * Through Phase 8 the downstream MCP relay accepted `OATHRION_LOCAL_MCP_URL` and
 * refused any host that was not loopback. That is safe, and it is also the
 * reason the relay could not be used: the whole promise of Oathrion — "whatever your
 * agent is, control every action before it executes" — assumes the action then
 * goes somewhere real. A gateway that can only talk to 127.0.0.1 is a demo.
 *
 * The obvious fix — drop the loopback check — is the wrong one. This module is
 * the one place in Oathrion that takes an operator-supplied hostname and opens a
 * socket to it while holding the caller's action. That is the textbook shape of
 * an SSRF sink, and here it is a particularly bad one: the request it emits is
 * an *authorised instruction*, so an attacker who can steer the destination does
 * not merely read an internal endpoint, they get Oathrion to vouch for the call.
 *
 * WHAT IT DOES INSTEAD
 * --------------------
 * The destination must be on an explicit allowlist AND must survive the same
 * address checks the webhook channel already applies. Both, not either:
 *
 *   1. **OATHRION_MCP_ALLOWED_DESTINATIONS** — a comma-separated list of origins the
 *      operator has decided Oathrion may dispatch to. There is no wildcard. An empty
 *      or missing list means no remote destination is permitted, so the failure
 *      direction of forgetting to configure it is "dispatches nowhere", not
 *      "dispatches anywhere". This mirrors `OATHRION_MCP_ALLOWED_ORIGINS`, which
 *      also refuses `*`.
 *
 *   2. **The address rules in `server/notifications/webhook-url.ts`** — loopback,
 *      private ranges, link-local and cloud metadata, carrier-grade NAT,
 *      multicast, IPv4-mapped IPv6, reserved internal DNS suffixes, non-HTTP
 *      schemes, and URLs carrying credentials. That module is reused rather than
 *      reimplemented, deliberately: two copies of an SSRF blocklist means one of
 *      them is out of date, and it is never the one you are looking at.
 *
 * An allowlist entry does NOT buy an exemption from (2). An operator who
 * allowlists `http://169.254.169.254` is refused, because the plausible way that
 * entry got there is a copied config or a compromised environment, and the
 * address rules are exactly the check that survives that.
 *
 * THE DNS PROBLEM IS NOT SOLVED HERE
 * ----------------------------------
 * Everything in this file inspects a *string*. A hostname that is public now can
 * resolve to 127.0.0.1 when the socket is opened; validating it here cannot stop
 * that, because the connection uses a later lookup. The check that cannot be
 * raced is applied to the address the socket is about to use, and it lives in
 * `server/notifications/webhook-transport.ts` — which is why the MCP client
 * dispatches through that transport rather than through `fetch`.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * `OATHRION_LOCAL_MCP_URL` is unchanged and still loopback-only. It is the local
 * fixture the existing suite, `npm run mcp:local` and the quickstart point at,
 * and there is no reason to break them: a loopback fixture named by a variable
 * with "LOCAL" in it is not an SSRF risk, it is the thing SSRF checks exist to
 * distinguish real destinations from. The two variables are separate on purpose
 * so that "a developer's fixture" and "a production destination" can never be
 * confused for one another, and configuring both is refused rather than silently
 * resolved by precedence.
 */

import net from "node:net";
import { blockedAddressReason } from "../../notifications/webhook-url";

/** Raised when a destination is refused. Distinct so callers can classify it. */
export class McpDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDestinationError";
  }
}

/** How the destination was configured. Recorded in the tool result and audit. */
export type DestinationKind = "LOCAL_FIXTURE" | "ALLOWLISTED_REMOTE";

export interface McpDestination {
  /** Origin only — scheme, host, port. Never carries a path, query or credentials. */
  origin: string;
  /** The parsed URL, so callers do not re-parse the raw string. */
  url: URL;
  kind: DestinationKind;
}

/**
 * Hostnames refused by name whatever they resolve to.
 *
 * Not the security boundary — `blockedAddressReason` applied to resolved
 * addresses is — but it turns a metadata-service misconfiguration into a legible
 * boot error instead of a timeout, and the metadata aliases have addresses that
 * differ by cloud provider.
 */
const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Reserved for local or internal resolution (RFC 6761, RFC 8375). */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];

/**
 * Ports that are refused even on an allowlisted, publicly-routable host.
 *
 * The reasoning is narrow and worth stating, because a port blocklist is usually
 * security theatre. It is not theatre here: this sink speaks HTTP, and several
 * of these services parse a stray HTTP request as a sequence of their own
 * commands. Redis in particular treats the lines of an HTTP request as inline
 * commands, which is how an HTTP client becomes a database client.
 *
 * An MCP server does not listen on any of these. Refusing them costs nothing
 * real and removes the protocol-confusion class of attack.
 */
const DANGEROUS_PORTS = new Map<number, string>([
  [22, "SSH"],
  [23, "Telnet"],
  [25, "SMTP"],
  [110, "POP3"],
  [143, "IMAP"],
  [445, "SMB"],
  [465, "SMTPS"],
  [587, "SMTP submission"],
  [1433, "MS SQL Server"],
  [3306, "MySQL"],
  [3389, "RDP"],
  [5432, "PostgreSQL"],
  [6379, "Redis"],
  [9200, "Elasticsearch"],
  [11211, "memcached"],
  [27017, "MongoDB"],
]);

/** The effective port for a URL, filling in the scheme default. */
function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Bare hostname: brackets stripped, lowercased. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Everything that is refused regardless of how the destination was configured.
 *
 * Shared by the fixture path and the remote path so a rule cannot be enforced on
 * one and forgotten on the other — with one stated exception, `allowLoopback`,
 * which is the *only* difference between the two.
 */
function assertGenerallySafe(url: URL, variable: string, allowLoopback: boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    /*
     * Refuses file:, data:, gopher:, ftp: and the rest. `gopher:` is the classic
     * vector for turning an HTTP client into a Redis client; `file:` would turn
     * a dispatch into a local file read.
     */
    throw new McpDestinationError(
      `${variable} uses scheme "${url.protocol}", which is not supported. Use http or https.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    /*
     * Credentials in a URL end up in logs, in error text and in Referer headers.
     * They are also not how MCP authenticates. Refused rather than stripped,
     * because stripping would silently send an unauthenticated request that the
     * operator believes is authenticated.
     */
    throw new McpDestinationError(
      `${variable} must not embed credentials in the URL.`,
    );
  }

  const host = hostOf(url);
  if (host === "") throw new McpDestinationError(`${variable} has no host.`);

  const isLoopbackName = host === "localhost";
  const literal = net.isIP(host) !== 0;
  const addressReason = literal ? blockedAddressReason(host) : null;
  const isLoopbackLiteral =
    literal && addressReason !== null && /loopback/i.test(addressReason);

  if (allowLoopback && (isLoopbackName || isLoopbackLiteral)) {
    // The fixture path, and the single exemption this function grants. Port and
    // scheme rules below still apply.
  } else {
    if (isLoopbackName) {
      throw new McpDestinationError(
        `${variable} points at "localhost". A remote MCP destination must be a routable host; ` +
          "use OATHRION_LOCAL_MCP_URL for a loopback fixture.",
      );
    }

    if (BLOCKED_HOSTNAMES.has(host)) {
      throw new McpDestinationError(
        `${variable} points at "${host}", a cloud instance metadata alias. Refused.`,
      );
    }

    for (const suffix of BLOCKED_SUFFIXES) {
      if (host.endsWith(suffix)) {
        throw new McpDestinationError(
          `${variable} points at "${host}", which uses the reserved internal suffix ` +
            `"${suffix}". Refused.`,
        );
      }
    }

    if (addressReason !== null) {
      throw new McpDestinationError(
        `${variable} points at ${host}, which is refused: ${addressReason}. ` +
          "Oathrion does not dispatch authorised actions to internal addresses.",
      );
    }
  }

  const port = portOf(url);
  const service = DANGEROUS_PORTS.get(port);
  if (service !== undefined) {
    throw new McpDestinationError(
      `${variable} points at port ${port} (${service}), which is not an MCP endpoint. ` +
        "Refused: sending an HTTP request to that service can be interpreted as its own " +
        "protocol.",
    );
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    /*
     * Only an origin is accepted. The MCP client builds its own request against
     * the origin, so a path here would be silently discarded — and a setting
     * that is silently discarded is a setting an operator believes is in effect.
     */
    throw new McpDestinationError(
      `${variable} must be an origin (scheme, host, optional port) with no path; ` +
        `got path "${url.pathname}".`,
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new McpDestinationError(
      `${variable} must be an origin with no query string or fragment.`,
    );
  }
}

/**
 * The operator's allowlist of origins Oathrion may dispatch to.
 *
 * Parsed strictly. Every entry must itself be a legal destination, so a bad
 * entry is a boot-time error naming that entry rather than a mystery refusal
 * later. `*` is refused explicitly, because it is the value someone reaches for
 * when the list is inconvenient and it would turn this module off entirely.
 */
export function parseAllowedDestinations(raw: string | undefined): Set<string> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const allowed = new Set<string>();
  for (const entry of entries) {
    if (entry === "*") {
      throw new McpDestinationError(
        "OATHRION_MCP_ALLOWED_DESTINATIONS does not accept \"*\". Every destination Oathrion may " +
          "dispatch an authorised action to has to be named. A wildcard here would make the " +
          "gateway a general-purpose request forwarder.",
      );
    }

    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new McpDestinationError(
        `OATHRION_MCP_ALLOWED_DESTINATIONS entry "${entry}" is not a valid absolute URL.`,
      );
    }

    assertGenerallySafe(url, `OATHRION_MCP_ALLOWED_DESTINATIONS entry "${entry}"`, false);
    allowed.add(url.origin);
  }
  return allowed;
}

/**
 * Resolve the configured downstream MCP destination, or `null` when there is none.
 *
 * Throws {@link McpDestinationError} for any configuration that is present but
 * not acceptable. Never falls back: a destination Oathrion cannot validate is a
 * destination Oathrion does not use, and the alternative — quietly reverting to the
 * simulator — would make an audit entry claim `SIMULATED` for a deployment whose
 * operator believes actions are being dispatched, or the reverse.
 *
 * Read per call rather than cached, matching the rest of the codebase: a test
 * can point it at an ephemeral port after import, and an operator changing it
 * does not have to reason about module load order.
 */
export function resolveDownstreamDestination(
  env: NodeJS.ProcessEnv = process.env,
): McpDestination | null {
  const local = env.OATHRION_LOCAL_MCP_URL?.trim();
  const remote = env.OATHRION_MCP_DOWNSTREAM_URL?.trim();

  if (local && remote) {
    /*
     * Refused rather than ranked. Picking one by precedence means half the
     * operators who set both get the other one, and the failure is invisible:
     * the actions go somewhere, just not where the person thought.
     */
    throw new McpDestinationError(
      "Both OATHRION_LOCAL_MCP_URL and OATHRION_MCP_DOWNSTREAM_URL are set. They are different " +
        "things — a loopback development fixture and a real destination — and Oathrion will not " +
        "guess which one you meant. Set exactly one.",
    );
  }

  if (local) {
    let url: URL;
    try {
      url = new URL(local);
    } catch {
      throw new McpDestinationError(`OATHRION_LOCAL_MCP_URL is not a valid URL: "${local}"`);
    }
    assertGenerallySafe(url, "OATHRION_LOCAL_MCP_URL", true);

    const host = hostOf(url);
    const literalReason = net.isIP(host) !== 0 ? blockedAddressReason(host) : null;
    const loopback = host === "localhost" || (literalReason !== null && /loopback/i.test(literalReason));
    if (!loopback) {
      /*
       * The Phase 4 rule, kept verbatim in effect. This variable names a local
       * fixture; a non-loopback value in it is a misread environment, and the
       * safe reading of a misread environment is not "send the refund there".
       */
      throw new McpDestinationError(
        `OATHRION_LOCAL_MCP_URL must point at loopback, got "${url.hostname}". ` +
          "Use OATHRION_MCP_DOWNSTREAM_URL with OATHRION_MCP_ALLOWED_DESTINATIONS for a real " +
          "destination.",
      );
    }
    return { origin: url.origin, url, kind: "LOCAL_FIXTURE" };
  }

  if (!remote) return null;

  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new McpDestinationError(`OATHRION_MCP_DOWNSTREAM_URL is not a valid URL: "${remote}"`);
  }

  // Rule (2): the address checks. Applied before the allowlist so that an
  // allowlisted internal address is still refused, and so the error names the
  // real reason rather than "not allowlisted".
  assertGenerallySafe(url, "OATHRION_MCP_DOWNSTREAM_URL", false);

  // Rule (1): the allowlist.
  const allowed = parseAllowedDestinations(env.OATHRION_MCP_ALLOWED_DESTINATIONS);
  if (allowed.size === 0) {
    throw new McpDestinationError(
      "OATHRION_MCP_DOWNSTREAM_URL is set but OATHRION_MCP_ALLOWED_DESTINATIONS is empty. " +
        "Oathrion dispatches authorised actions only to destinations an operator has named, " +
        "so an unset allowlist permits nothing rather than everything.",
    );
  }
  if (!allowed.has(url.origin)) {
    throw new McpDestinationError(
      `OATHRION_MCP_DOWNSTREAM_URL origin "${url.origin}" is not in OATHRION_MCP_ALLOWED_DESTINATIONS. ` +
        `Allowed: ${[...allowed].join(", ")}.`,
    );
  }

  return { origin: url.origin, url, kind: "ALLOWLISTED_REMOTE" };
}
