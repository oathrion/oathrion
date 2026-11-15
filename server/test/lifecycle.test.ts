/**
 * §20 — the process must have a lifecycle.
 *
 * These tests drive real HTTP servers and a real drain. They never install the
 * process-wide handlers permanently and never call `process.exit`, so a failure
 * here cannot take the test runner down with it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { installLifecycle, isShuttingDown, resetLifecycle, shutdown } from "../lifecycle";

/** A server that holds a response open until released, to create an in-flight request. */
function heldServer(): {
  server: Server;
  port: Promise<number>;
  release: () => void;
  hits: () => number;
} {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hits = 0;

  const server = createServer((req, res) => {
    hits += 1;
    if (req.url === "/slow") {
      void held.then(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("done");
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return { server, port, release, hits: () => hits };
}

afterEach(() => {
  resetLifecycle();
  vi.restoreAllMocks();
});

describe("graceful shutdown", () => {
  it("waits for an in-flight response instead of cutting it", async () => {
    /*
     * The failure this prevents: SIGTERM arrives while a tool call is dispatched.
     * Killing the process there means the side effect happened in the real world
     * and the audit entry never landed.
     */
    const { server, port, release } = heldServer();
    const p = await port;

    const inFlight = fetch(`http://127.0.0.1:${p}/slow`);
    // Give the request time to actually reach the handler.
    await vi.waitFor(async () => {
      expect(isShuttingDown()).toBe(false);
    });
    await new Promise((r) => setTimeout(r, 30));

    const draining = shutdown(server, "SIGTERM", { timeoutMs: 5_000 });

    // Still draining: the response has not been allowed to finish yet.
    await new Promise((r) => setTimeout(r, 50));
    release();

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");

    // Clean drain, so exit code 0.
    expect(await draining).toBe(0);
  });

  it("flips the shutting-down flag immediately, before the socket closes", async () => {
    // This is what lets /api/health report degraded so the load balancer stops
    // sending new work *before* the listener goes away. Without the window, the
    // probe races the close and clients see connection resets.
    const { server, port, release } = heldServer();
    await port;

    expect(isShuttingDown()).toBe(false);
    const draining = shutdown(server, "SIGTERM", { timeoutMs: 5_000 });
    expect(isShuttingDown()).toBe(true);

    release();
    await draining;
  });

  it("stops accepting new connections once draining", async () => {
    const { server, port, release } = heldServer();
    const p = await port;

    const draining = shutdown(server, "SIGTERM", { timeoutMs: 5_000 });
    release();
    await draining;

    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
  });

  it("exits anyway when the drain exceeds its deadline", async () => {
    /*
     * A graceful shutdown with no deadline is a hung deploy: the orchestrator
     * SIGKILLs it eventually, with no log line explaining why. Exiting
     * deliberately, non-zero, with a reason, is strictly better.
     */
    const { server, port, release } = heldServer();
    const p = await port;

    const inFlight = fetch(`http://127.0.0.1:${p}/slow`).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));

    const started = Date.now();
    const code = await shutdown(server, "SIGTERM", { timeoutMs: 100 });
    const elapsed = Date.now() - started;

    expect(code).toBe(1); // non-zero: this was not a clean drain
    expect(elapsed).toBeLessThan(3_000);

    release();
    await inFlight;
  });

  it("releases resources after the listener closes", async () => {
    const { server, port, release } = heldServer();
    await port;
    const onClose = vi.fn();

    release();
    await shutdown(server, "SIGTERM", { timeoutMs: 5_000, onClose });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not let a failing cleanup hook prevent the exit", async () => {
    // A resource that refuses to close must not turn shutdown into a hang.
    const { server, port, release } = heldServer();
    await port;
    release();

    const code = await shutdown(server, "SIGTERM", {
      timeoutMs: 5_000,
      onClose: () => {
        throw new Error("database handle stuck");
      },
    });
    expect(code).toBe(0);
  });

  it("ignores a second signal instead of starting a second drain", async () => {
    // Normal in practice: an impatient operator, or SIGINT following SIGTERM. A
    // second drain would reset the deadline and could double-run cleanup.
    const { server, port, release } = heldServer();
    await port;
    const onClose = vi.fn();

    const first = shutdown(server, "SIGTERM", { timeoutMs: 5_000, onClose });
    const second = await shutdown(server, "SIGINT", { timeoutMs: 5_000, onClose });

    expect(second).toBe(0);
    release();
    await first;

    // Cleanup ran exactly once, from the first drain only.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("fault handlers", () => {
  it("shuts down on an unhandled rejection rather than serving from an unknown state", async () => {
    /*
     * An unhandled rejection means a code path failed and nothing noticed. Node
     * treated this as warn-only for years, so a background promise could reject and
     * leave the process serving governed actions with an already-broken invariant.
     * A restart is better than silent corruption.
     */
    const { server, port, release } = heldServer();
    await port;
    const exit = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const dispose = installLifecycle(server, { exit, timeoutMs: 5_000 });
    try {
      release();
      process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      // Non-zero: the orchestrator must see this as a failure, not a clean stop.
      expect(exit).toHaveBeenCalledWith(1);
      expect(isShuttingDown()).toBe(true);
    } finally {
      dispose();
      errors.mockRestore();
    }
  });

  it("shuts down on an uncaught exception", async () => {
    const { server, port, release } = heldServer();
    await port;
    const exit = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const dispose = installLifecycle(server, { exit, timeoutMs: 5_000 });
    try {
      release();
      process.emit("uncaughtException", new Error("boom"));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      dispose();
      errors.mockRestore();
    }
  });

  it("drains and exits zero on SIGTERM", async () => {
    const { server, port, release } = heldServer();
    await port;
    const exit = vi.fn();

    const dispose = installLifecycle(server, { exit, timeoutMs: 5_000 });
    try {
      release();
      process.emit("SIGTERM");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    } finally {
      dispose();
    }
  });

  it("removes its handlers when disposed, so suites do not leak listeners", async () => {
    const { server, port, release } = heldServer();
    await port;
    const before = process.listenerCount("SIGTERM");

    const dispose = installLifecycle(server, { exit: () => {}, timeoutMs: 1_000 });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    dispose();
    expect(process.listenerCount("SIGTERM")).toBe(before);

    release();
    server.close();
  });
});
