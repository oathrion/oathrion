/**
 * SSRF guard for the outbound webhook channel.
 *
 * THE PROBLEM
 * -----------
 * The webhook transport is a server-side HTTP client that signs its payloads and
 * runs inside the trust boundary of the control plane. Whoever controls its target
 * URL controls where that client points. The original code called global `fetch`
 * with the raw configured string, and the only validation anywhere was a
 * `/^https?:\/\//` test in `configureNotifications`. That permitted:
 *
 *   - `http://169.254.169.254/...` — the cloud instance metadata service, which
 *     hands IAM credentials to any process on the host that can make a request;
 *   - `http://localhost:9200/...` — unauthenticated admin/data ports, which is the
 *     normal posture for services that expect to be loopback-only;
 *   - `http://10.x` / `172.16.x` / `192.168.x` — RFC1918 neighbours reachable from
 *     inside the VPC but not from the internet;
 *   - any of the above reached *indirectly*, because `fetch` follows redirects by
 *     default: a public hostname that 302s to 127.0.0.1 defeated hostname checks.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Two layers, because either alone is insufficient:
 *
 *   1. `assertSafeWebhookUrl` — structural validation of the configured URL, run
 *      once at registration so a bad value fails loudly at boot rather than
 *      silently at the first notification.
 *   2. `isBlockedAddress` — an address-level check applied by the transport to
 *      *every* IP the hostname resolves to, at connect time. Layer 1 cannot do
 *      this: a hostname is not an address, and an attacker-controlled DNS record
 *      can return a public address on the first lookup and 127.0.0.1 on the second
 *      (DNS rebinding). Validating the socket's actual destination is the only
 *      check that cannot be raced.
 *
 * The refusal is fail-closed and there is no permissive fallback. `allowPrivate`
 * exists because some operators genuinely do run the receiver on the same host,
 * but it must be set deliberately via `OATHRION_WEBHOOK_ALLOW_PRIVATE=true`; it is
 * never inferred.
 */

import net from "node:net";

/** Distinct type so callers can tell a refusal from an unrelated failure. */
export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

export interface WebhookUrlOptions {
  /**
   * Permit loopback and private-range targets. Off by default. Wired to
   * `OATHRION_WEBHOOK_ALLOW_PRIVATE=true` for the single-host deployment shape.
   */
  allowPrivate?: boolean;
}

/**
 * Hostnames that must never be contacted regardless of what they resolve to.
 *
 * Name-based blocking is not the security boundary — `isBlockedAddress` is — but
 * it produces a far clearer error at boot than "connection refused", and it stops
 * the well-known metadata aliases whose addresses vary by cloud provider.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Suffixes reserved for local/internal resolution (RFC 6761, RFC 8375). */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];

/**
 * Strip the IPv4-mapped IPv6 prefix so `::ffff:127.0.0.1` is judged as the IPv4
 * loopback it actually is. WHATWG URL parsing compresses it to `::ffff:7f00:1`,
 * which no IPv4 rule would otherwise match — a classic bypass.
 */
function unmapIpv4(address: string): string {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }

  return address;
}

/**
 * Is this literal address one the control plane must never open a socket to?
 *
 * Returns the reason it is blocked, or `null` when the address is acceptable.
 * A reason string rather than a boolean so logs say *why*.
 */
export function blockedAddressReason(rawAddress: string): string | null {
  const address = unmapIpv4(rawAddress.replace(/^\[|\]$/g, ""));
  const family = net.isIP(address);
  if (family === 0) return "not a valid IP address";

  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;

    if (a === 127) return "IPv4 loopback (127.0.0.0/8)";
    if (a === 0) return "unspecified / this-network address (0.0.0.0/8)";
    if (a === 10) return "private range 10.0.0.0/8";
    if (a === 172 && b >= 16 && b <= 31) return "private range 172.16.0.0/12";
    if (a === 192 && b === 168) return "private range 192.168.0.0/16";
    if (a === 169 && b === 254) {
      // 169.254.169.254 and friends live here. Called out separately because
      // "link-local" understates what an operator has just been protected from.
      return "link-local / cloud instance metadata range 169.254.0.0/16";
    }
    if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT range 100.64.0.0/10";
    if (a === 192 && b === 0 && octets[2] === 0) return "IETF protocol assignments 192.0.0.0/24";
    if (a === 192 && b === 0 && octets[2] === 2) return "documentation range 192.0.2.0/24";
    if (a === 198 && (b === 18 || b === 19)) return "benchmarking range 198.18.0.0/15";
    if (a === 198 && b === 51 && octets[2] === 100) return "documentation range 198.51.100.0/24";
    if (a === 203 && b === 0 && octets[2] === 113) return "documentation range 203.0.113.0/24";
    if (a >= 224) return "multicast / reserved range (224.0.0.0/4 and above)";
    return null;
  }

  // IPv6.
  const lower = address.toLowerCase();
  if (lower === "::1") return "IPv6 loopback (::1)";
  if (lower === "::" || lower === "::0") return "IPv6 unspecified address (::)";
  if (/^f[cd]/.test(lower)) return "IPv6 unique local address (fc00::/7)";
  if (/^fe[89ab]/.test(lower)) return "IPv6 link-local address (fe80::/10)";
  if (/^ff/.test(lower)) return "IPv6 multicast (ff00::/8)";
  if (/^2001:db8/.test(lower)) return "IPv6 documentation range (2001:db8::/32)";
  if (/^64:ff9b:/.test(lower)) return "NAT64 well-known prefix (64:ff9b::/96)";
  return null;
}

/** Boolean form of {@link blockedAddressReason}, for use in hot paths. */
export function isBlockedAddress(address: string): boolean {
  return blockedAddressReason(address) !== null;
}

/**
 * Validate a configured webhook URL, throwing {@link WebhookUrlError} on refusal.
 *
 * Returns the parsed URL so the caller works with the normalised form rather than
 * re-parsing the raw string — re-parsing is how validate-then-use bugs appear.
 *
 * Error messages never include the raw URL's credentials: this text reaches the
 * application log and, via delivery results, the notifications API.
 */
export function assertSafeWebhookUrl(raw: string, options: WebhookUrlOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebhookUrlError("Webhook URL is not a valid absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // Blocks file:, gopher:, ftp:, data: and the rest. `gopher:` in particular is
    // the classic vector for turning an HTTP client into a Redis/memcached client.
    throw new WebhookUrlError(
      `Webhook URL scheme "${parsed.protocol}" is not supported; use http or https.`,
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    // Credentials in a URL end up in logs, in redirect Referer headers and in
    // error text. The channel signs its payloads instead.
    throw new WebhookUrlError(
      "Webhook URL must not embed credentials; use OATHRION_WEBHOOK_SECRET to authenticate.",
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "") {
    throw new WebhookUrlError("Webhook URL has no host.");
  }

  if (options.allowPrivate === true) {
    // The operator has explicitly accepted the risk. Scheme and credential checks
    // above still apply — those are correctness, not network reachability.
    return parsed;
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    const detail = hostname.startsWith("metadata") || hostname.startsWith("instance-data")
      ? "it is a cloud instance metadata alias"
      : "it resolves to the loopback interface";
    throw new WebhookUrlError(
      `Webhook host "${hostname}" is refused because ${detail}. ` +
        "Set OATHRION_WEBHOOK_ALLOW_PRIVATE=true only if this is deliberate.",
    );
  }

  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new WebhookUrlError(
        `Webhook host "${hostname}" uses the reserved internal suffix "${suffix}". ` +
          "Set OATHRION_WEBHOOK_ALLOW_PRIVATE=true only if this is deliberate.",
      );
    }
  }

  if (net.isIP(hostname) !== 0) {
    const reason = blockedAddressReason(hostname);
    if (reason !== null) {
      throw new WebhookUrlError(
        `Webhook address ${hostname} is refused: ${reason}. ` +
          "Set OATHRION_WEBHOOK_ALLOW_PRIVATE=true only if this is deliberate.",
      );
    }
  }

  // A non-literal hostname cannot be judged here — it has to be resolved, and a
  // resolution done now is not the resolution the socket will use. The transport
  // therefore re-checks every resolved address at connect time.
  return parsed;
}
