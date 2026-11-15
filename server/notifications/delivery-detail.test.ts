/**
 * The delivery `detail` field must not leak internal topology.
 *
 * `GET /api/notifications` is a `read`-capability endpoint, so the lowest-privileged
 * role in the system — `viewer` — can read every recent delivery result. That is
 * the right design: "did the webhook actually fire?" should not require an admin or
 * a log aggregator.
 *
 * The problem is what `detail` contained on the failure path. It was the raw error
 * message from the transport, and Node's network errors embed the destination:
 *
 *     connect ECONNREFUSED 10.4.2.19:9000
 *     getaddrinfo ENOTFOUND events.internal.corp
 *     Refused to connect to hooks.corp (10.0.0.5): private range 10.0.0.0/8.
 *
 * A viewer therefore learned the internal hostname, private IP and port of the
 * receiver, and — since `OATHRION_WEBHOOK_URL` may carry a token in its path — a
 * URL-bearing error could expose that too. None of that is needed to answer
 * "did it fire?", and internal addressing is exactly what an attacker who has
 * obtained a low-privilege credential wants next.
 *
 * `sanitizeDeliveryDetail` keeps the diagnostic value (which class of failure)
 * and drops the topology (which host). The unredacted text still goes to the
 * server log, where the operator who owns the deployment can see it.
 */

import { describe, expect, it } from "vitest";
import { sanitizeDeliveryDetail } from "./detail";

describe("delivery detail is safe to expose to a viewer", () => {
  it("removes an IPv4 address and port from a connection error", () => {
    const safe = sanitizeDeliveryDetail("connect ECONNREFUSED 10.4.2.19:9000");
    expect(safe).not.toContain("10.4.2.19");
    expect(safe).not.toContain("9000");
    // The failure class survives, because that is the part an operator acts on.
    expect(safe).toContain("ECONNREFUSED");
  });

  it("removes an internal hostname from a DNS error", () => {
    const safe = sanitizeDeliveryDetail("getaddrinfo ENOTFOUND events.internal.corp");
    expect(safe).not.toContain("events.internal.corp");
    expect(safe).toContain("ENOTFOUND");
  });

  it("removes the host and address from a blocked-address refusal", () => {
    const safe = sanitizeDeliveryDetail(
      "Refused to connect to hooks.corp (10.0.0.5): private range 10.0.0.0/8.",
    );
    expect(safe).not.toContain("hooks.corp");
    expect(safe).not.toContain("10.0.0.5");
  });

  it("removes a full URL, which may carry a token in its path", () => {
    const safe = sanitizeDeliveryDetail(
      "request to https://hooks.example.com/t/9f3a-secret-token failed",
    );
    expect(safe).not.toContain("9f3a-secret-token");
    expect(safe).not.toContain("hooks.example.com");
  });

  it("removes an IPv6 address", () => {
    const safe = sanitizeDeliveryDetail("connect ECONNREFUSED fd00::1 port 443");
    expect(safe).not.toContain("fd00::1");
  });

  it("passes through an HTTP status verdict unchanged", () => {
    // The overwhelmingly common case. `HTTP 500` reveals nothing and is the single
    // most useful thing on the screen, so it must not be mangled.
    expect(sanitizeDeliveryDetail("HTTP 500")).toBe("HTTP 500");
    expect(sanitizeDeliveryDetail("HTTP 204")).toBe("HTTP 204");
  });

  it("keeps a timeout message, which names a duration rather than a host", () => {
    const safe = sanitizeDeliveryDetail("Webhook request timed out after 5000ms");
    expect(safe).toMatch(/timed out/i);
    expect(safe).toContain("5000ms");
  });

  it("never returns an empty string, so the UI always has something to render", () => {
    expect(sanitizeDeliveryDetail("10.0.0.1").length).toBeGreaterThan(0);
    expect(sanitizeDeliveryDetail("").length).toBeGreaterThan(0);
  });

  it("bounds the length so a hostile error message cannot flood the response", () => {
    expect(sanitizeDeliveryDetail("x".repeat(10_000)).length).toBeLessThanOrEqual(200);
  });
});
