/**
 * Redaction for the delivery `detail` string surfaced by `GET /api/notifications`.
 *
 * That endpoint requires only the `read` capability, so a `viewer` — the least
 * privileged role — sees every recent delivery result. Useful and intended: an
 * operator should be able to answer "did the webhook fire?" without a log
 * aggregator. What is not intended is handing that viewer the internal hostname,
 * private IP and port of the receiver, which is what the raw transport error
 * message contains (`connect ECONNREFUSED 10.4.2.19:9000`), or a webhook URL whose
 * path carries a token.
 *
 * The rule applied here: keep the failure *class*, drop the *location*. An operator
 * acts on "ECONNREFUSED" and "timed out"; they do not need the address repeated
 * back, because they configured it. The unredacted message is still written to the
 * server log, which is a higher trust boundary than an API response.
 *
 * See `delivery-detail.test.ts` for the exposure this prevents.
 */

/** Upper bound so a hostile receiver's error text cannot bloat the API response. */
const MAX_DETAIL_LENGTH = 200;

/** `HTTP 204`, `HTTP 500` — a verdict with no topology in it. Passed through. */
const STATUS_ONLY = /^HTTP \d{3}$/;

const REDACTIONS: Array<[RegExp, string]> = [
  // Full URLs first: a URL contains a host, and its path may contain a token.
  [/\bhttps?:\/\/\S+/gi, "[url]"],
  // Bracketed IPv6 with optional port, then bare IPv6.
  [/\[[0-9a-f:]+\](?::\d+)?/gi, "[address]"],
  [/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, "[address]"],
  // IPv4 with optional port.
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, "[address]"],
  // Dotted hostnames. Deliberately after the IPv4 rule so addresses are not
  // mislabelled as hosts. Two or more labels, so ordinary prose is untouched.
  [/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi, "[host]"],
  // `port 443` / `:9000` left over after the rules above.
  [/\bport \d+\b/gi, "port [redacted]"],
];

/**
 * Strip host, address and URL information from a transport error message.
 *
 * Never returns an empty string: the console renders this value directly, and an
 * empty cell reads as "no information available" rather than "redacted".
 */
export function sanitizeDeliveryDetail(detail: string): string {
  if (typeof detail !== "string" || detail.trim() === "") {
    return "No detail reported";
  }

  if (STATUS_ONLY.test(detail.trim())) return detail.trim();

  let safe = detail;
  for (const [pattern, replacement] of REDACTIONS) {
    safe = safe.replace(pattern, replacement);
  }

  // Collapse the whitespace and empty parentheses the substitutions leave behind,
  // e.g. `Refused to connect to [host] ([address]):` reads better without the
  // now-redundant duplicate.
  safe = safe.replace(/\(\s*\[address\]\s*\)/g, "").replace(/\s{2,}/g, " ").trim();

  if (safe === "" || /^[[\](){}:.,\-\s]*$/.test(safe)) {
    return "Delivery failed (details withheld; see server log)";
  }

  return safe.length > MAX_DETAIL_LENGTH ? `${safe.slice(0, MAX_DETAIL_LENGTH - 1)}…` : safe;
}
