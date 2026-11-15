/**
 * Server-Side Request Forgery proof for the outbound webhook channel.
 *
 * WHY THIS IS A REAL VULNERABILITY HERE, NOT A THEORETICAL ONE
 * -----------------------------------------------------------
 * `OATHRION_WEBHOOK_URL` is operator-supplied configuration, so at first glance an
 * operator pointing it at their own loopback is only harming themselves. The
 * exposure is that the control plane then holds a *credentialed, signed, server-side
 * HTTP client* that anyone able to influence that value — a compromised env file, a
 * templated deployment manifest, a future "add a webhook" UI, an operator pasting a
 * URL from a ticket — can aim at:
 *
 *   - the cloud instance metadata service (169.254.169.254), which hands out IAM
 *     credentials to any process that can issue a plain GET/POST from the host;
 *   - `localhost` services with no authentication, which is the normal posture for
 *     admin ports, Redis, Elasticsearch, Prometheus and the like;
 *   - RFC1918 neighbours reachable from inside the VPC but not from the internet.
 *
 * Every approval decision and every blocked action is POSTed to that URL, so the
 * channel is also an exfiltration path, not only a request-forgery one.
 *
 * The original transport made no attempt to prevent any of this: it called global
 * `fetch` with the raw string, and `configureNotifications` checked only that the
 * value started with `http://` or `https://`. Redirects were followed by default,
 * so even a validated public hostname could bounce the request to 127.0.0.1.
 *
 * These tests are the proof. They were written before the fix and observed to fail.
 */

import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl, WebhookUrlError } from "./webhook-url";

/** Every literal that must be refused before a socket is ever opened. */
const BLOCKED_URLS: Array<[string, string]> = [
  ["loopback by name", "http://localhost:9200/ingest"],
  ["loopback IPv4", "http://127.0.0.1/ingest"],
  ["loopback IPv4, alternate form", "http://127.1/ingest"],
  ["loopback IPv4, decimal form", "http://2130706433/ingest"],
  ["unspecified address", "http://0.0.0.0:8080/ingest"],
  ["loopback IPv6", "http://[::1]/ingest"],
  ["unspecified IPv6", "http://[::]/ingest"],
  ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/ingest"],
  ["cloud metadata by IP", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
  ["cloud metadata by name", "http://metadata.google.internal/computeMetadata/v1/"],
  ["link-local", "http://169.254.10.10/"],
  ["private 10/8", "http://10.0.0.5/ingest"],
  ["private 172.16/12", "http://172.16.4.9/ingest"],
  ["private 192.168/16", "http://192.168.1.1/ingest"],
  ["carrier-grade NAT 100.64/10", "http://100.64.0.1/ingest"],
  ["IPv6 unique local", "http://[fd00::1]/ingest"],
  ["IPv6 link-local", "http://[fe80::1]/ingest"],
  ["non-http scheme: file", "file:///etc/passwd"],
  ["non-http scheme: gopher", "gopher://127.0.0.1:11211/"],
  ["credentials embedded in the URL", "http://admin:hunter2@example.com/ingest"],
];

describe("webhook URL validation refuses SSRF targets", () => {
  it.each(BLOCKED_URLS)("rejects %s", (_label, url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow(WebhookUrlError);
  });

  it("accepts an ordinary public https endpoint", () => {
    const parsed = assertSafeWebhookUrl("https://hooks.example.com/placet");
    expect(parsed.hostname).toBe("hooks.example.com");
  });

  it("accepts a public endpoint on an explicit port", () => {
    expect(() => assertSafeWebhookUrl("https://hooks.example.com:8443/placet")).not.toThrow();
  });

  it("reports which rule refused the URL, without inventing a permissive fallback", () => {
    // A refusal must be legible in a log; an operator debugging a webhook that
    // "silently does nothing" is exactly how permissive fallbacks get added later.
    try {
      assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data/");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookUrlError);
      expect((error as WebhookUrlError).message).toMatch(/link-local|metadata/i);
    }
  });

  it("never echoes embedded credentials back in the error message", () => {
    // The error text reaches logs and the notifications API. Repeating the secret
    // there would turn a validation message into a credential leak.
    try {
      assertSafeWebhookUrl("http://admin:hunter2@example.com/ingest");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });

  it("allows private targets only behind an explicit, documented opt-in", () => {
    // Some operators genuinely do run the receiver on the same host. That must be
    // a deliberate, visible choice rather than the default posture.
    expect(() => assertSafeWebhookUrl("http://127.0.0.1:9000/ingest")).toThrow();
    expect(() =>
      assertSafeWebhookUrl("http://127.0.0.1:9000/ingest", { allowPrivate: true }),
    ).not.toThrow();
  });
});
