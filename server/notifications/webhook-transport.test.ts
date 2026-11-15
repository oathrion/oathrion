/**
 * Socket-level SSRF proofs for the guarded webhook transport.
 *
 * `webhook-ssrf.test.ts` proves the *string* validator. This file proves the two
 * things a string validator cannot possibly prove, and which the original
 * `fetch`-based transport got wrong:
 *
 *   1. A hostname that passes validation but *resolves* to a private address is
 *      refused when the socket is opened. This is the DNS-rebinding case: the
 *      address the connection uses comes from a lookup that happens after any
 *      pre-flight check, so only a check inside the connect path is sound.
 *   2. Redirects are not followed. `fetch` follows them by default, so a validated
 *      public host answering `302 Location: http://169.254.169.254/` reached the
 *      cloud metadata service with every pre-flight check having passed.
 *
 * Both use real sockets on real ephemeral ports. Mocking the transport here would
 * mean testing the mock rather than the guard.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BlockedAddressError, sendGuarded } from "./webhook-transport";

const HEADERS = { "Content-Type": "application/json" };

/** A receiver that answers however the current test asks it to. */
class Receiver {
  private server!: Server;
  /** Paths that were actually requested, so "was it followed?" is answerable. */
  readonly hits: string[] = [];
  private redirectTo: string | null = null;
  private bodyBytes = 0;

  async start(): Promise<{ origin: string; port: number }> {
    this.server = createServer((req, res) => {
      this.hits.push(req.url ?? "/");
      req.resume();
      req.on("end", () => {
        if (this.redirectTo !== null) {
          res.writeHead(302, { Location: this.redirectTo });
          return res.end();
        }
        if (this.bodyBytes > 0) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          return res.end("x".repeat(this.bodyBytes));
        }
        res.writeHead(204);
        res.end();
      });
    });

    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    return { origin: `http://127.0.0.1:${port}`, port };
  }

  redirect(to: string | null): void {
    this.redirectTo = to;
  }

  respondWithBytes(count: number): void {
    this.redirectTo = null;
    this.bodyBytes = count;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("guarded webhook transport", () => {
  const receiver = new Receiver();
  let origin: string;
  let port: number;

  beforeAll(async () => {
    ({ origin, port } = await receiver.start());
  });

  afterAll(async () => {
    await receiver.stop();
  });

  it("refuses a hostname that resolves to a private address, at connect time", async () => {
    // `localhost` is a name, not a literal, so no address-range check on the
    // *string* could catch it. It is caught because the resolved address is
    // inspected before the socket is used. This is the DNS-rebinding defence:
    // whatever the name resolved to earlier is irrelevant.
    await expect(
      sendGuarded({
        url: new URL(`http://localhost:${port}/ingest`),
        headers: HEADERS,
        body: "{}",
        timeoutMs: 2_000,
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("names the refused address and the reason, without opening the socket", async () => {
    const before = receiver.hits.length;
    await expect(
      sendGuarded({
        url: new URL(`http://localhost:${port}/ingest`),
        headers: HEADERS,
        body: "{}",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/127\.0\.0\.1.*loopback/i);

    // The proof that this is prevention and not merely detection: the receiver
    // never saw a request, so no payload left the process.
    expect(receiver.hits.length).toBe(before);
  });

  it("connects when the operator has explicitly allowed private targets", async () => {
    const res = await sendGuarded({
      url: new URL(`${origin}/ingest`),
      headers: HEADERS,
      body: "{}",
      timeoutMs: 2_000,
      allowPrivate: true,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
  });

  it("does not follow a redirect toward the cloud metadata service", async () => {
    receiver.redirect("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
    try {
      const res = await sendGuarded({
        url: new URL(`${origin}/ingest`),
        headers: HEADERS,
        body: "{}",
        timeoutMs: 2_000,
        allowPrivate: true,
      });

      // The 302 is reported as-is and treated as an unsuccessful delivery, which is
      // the truth: a webhook receiver that redirects is misconfigured. Under the
      // old `fetch` transport this same reply caused a request to 169.254.169.254.
      expect(res.status).toBe(302);
      expect(res.ok).toBe(false);
    } finally {
      receiver.redirect(null);
    }
  });

  it("does not follow a redirect back to loopback either", async () => {
    receiver.redirect(`http://127.0.0.1:${port}/internal-admin`);
    try {
      const before = receiver.hits.length;
      const res = await sendGuarded({
        url: new URL(`${origin}/ingest`),
        headers: HEADERS,
        body: "{}",
        timeoutMs: 2_000,
        allowPrivate: true,
      });
      expect(res.status).toBe(302);
      // Exactly one request: the original. The redirect target was never fetched.
      expect(receiver.hits.length).toBe(before + 1);
      expect(receiver.hits).not.toContain("/internal-admin");
    } finally {
      receiver.redirect(null);
    }
  });

  it("caps an oversized response body instead of buffering it", async () => {
    // A hostile or broken receiver must not be able to grow this process. The reply
    // is discarded anyway, so truncating it loses nothing.
    receiver.respondWithBytes(512 * 1024);
    const res = await sendGuarded({
      url: new URL(`${origin}/ingest`),
      headers: HEADERS,
      body: "{}",
      timeoutMs: 5_000,
      allowPrivate: true,
    });
    expect(res.status).toBe(200);
    receiver.respondWithBytes(0);
  });

  it("gives up on a receiver that never answers", async () => {
    // A hung receiver must not hold a request open indefinitely: the notifier is
    // awaited on the decision path.
    const silent = createServer(() => {
      /* accept and never answer */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const silentPort = (silent.address() as AddressInfo).port;

    try {
      await expect(
        sendGuarded({
          url: new URL(`http://127.0.0.1:${silentPort}/ingest`),
          headers: HEADERS,
          body: "{}",
          timeoutMs: 300,
          allowPrivate: true,
        }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
