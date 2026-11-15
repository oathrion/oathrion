/**
 * §20 — `/api/health` must answer a question a load balancer can act on.
 *
 * THE PROBLEM
 * -----------
 * The endpoint returned a hard-coded `{ status: "ok" }`. That is true of any
 * process that managed to run one line of JavaScript, which makes it useless as a
 * health check: the answer is identical whether the database is reachable or the
 * disk holding `data.db` is gone. A load balancer polling it keeps routing traffic
 * into an instance that fails every request, and an orchestrator never restarts it.
 * "Healthy" that cannot become "unhealthy" is a green light wired to nothing.
 *
 * `/api/health` is also in `PUBLIC_API_PATHS` — unauthenticated by necessity,
 * since a probe has no credential. So the response must be *useful to a probe* and
 * *useless to an attacker*: no version string, no file path, no hostname, no
 * dependency versions, no counts that describe the tenant's data.
 *
 * WHAT IS CHECKED
 * ---------------
 * A real query against SQLite. It is the only dependency this deployment has, it
 * is cheap to probe, and it is the thing that actually breaks (a missing file, a
 * read-only volume, a corrupt page).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { resetLifecycle, shutdown } from "../lifecycle";
import { startTestServer, type TestClient } from "./harness";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

interface Health {
  status: string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  uptimeSeconds?: number;
  [key: string]: unknown;
}

describe("GET /api/health", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("reports ok with a real dependency check when everything works", async () => {
    const res = await api.get<Health>("/api/health", { auth: null });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");

    // The point of the change: the answer is derived, not hard-coded.
    expect(res.body.checks?.database?.ok).toBe(true);
  });

  it("stays reachable without a credential, because a probe has none", async () => {
    const res = await api.get<Health>("/api/health", { auth: null });
    expect(res.status).toBe(200);
  });

  it("does not leak anything about the deployment", async () => {
    const res = await api.get<Health>("/api/health", { auth: null });
    const body = JSON.stringify(res.body);

    // No version, path, hostname, secret or dependency detail. This endpoint is
    // the one thing an unauthenticated attacker can always reach.
    expect(body).not.toMatch(/node|v\d+\.\d+\.\d+/i);
    expect(body).not.toMatch(/\/home\/|\/var\/|\.db\b|sqlite/i);
    expect(body).not.toMatch(/secret|token|password|key/i);
    expect(body).not.toMatch(/OATHRION_/);
    // No data-shaped counts either: "412 executions" tells an outsider how busy
    // the tenant is.
    expect(body).not.toMatch(/executions|agents|policies|approvals/i);
  });

  it("exposes uptime, which is operationally useful and reveals nothing", async () => {
    const res = await api.get<Health>("/api/health", { auth: null });
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("answers quickly enough to be polled", async () => {
    const started = Date.now();
    await api.get<Health>("/api/health", { auth: null });
    // A probe runs every few seconds; a health check that is slow is a health
    // check that becomes the outage.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers 503 when the database is unreachable", async () => {
    /*
     * The whole reason for this change. A probe must be able to observe the
     * difference between a working instance and a broken one, and it must be able
     * to do so from the HTTP status alone — an orchestrator does not parse bodies.
     *
     * Simulated at the repository seam rather than by deleting the database file,
     * because the shared test database is used by every other suite.
     */
    const ping = vi.spyOn(repositories, "ping").mockResolvedValue(false);
    try {
      const res = await api.get<Health>("/api/health", { auth: null });
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks?.database?.ok).toBe(false);
    } finally {
      ping.mockRestore();
    }

    // And it recovers on its own once the dependency is back: a health check that
    // latches unhealthy needs a restart to clear, which defeats the purpose.
    const recovered = await api.get<Health>("/api/health", { auth: null });
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("ok");
  });

  it("still says nothing about the deployment when degraded", async () => {
    // The failure path is the one an attacker can most easily provoke, so it is
    // the one most likely to leak. The underlying error carries the database path.
    const ping = vi.spyOn(repositories, "ping").mockResolvedValue(false);
    try {
      const res = await api.get<Health>("/api/health", { auth: null });
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/\/home\/|\/var\/|\.db\b|sqlite/i);
      expect(body).not.toMatch(/SQLITE_|no such table|Error:/i);
    } finally {
      ping.mockRestore();
    }
  });

  it("never throws, even if the dependency check itself fails", async () => {
    /*
     * A health check that raises turns a degraded dependency into a 500 with a
     * stack trace, which is both less useful to the probe and a disclosure. The
     * repository contract promises `ping` resolves rather than throws; this proves
     * the route survives a violation of that promise anyway.
     */
    const ping = vi
      .spyOn(repositories, "ping")
      .mockRejectedValue(new Error("SQLITE_CANTOPEN: unable to open /home/user/data.db"));
    try {
      const res = await api.get<Health>("/api/health", { auth: null });
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toMatch(/SQLITE_CANTOPEN|\/home\//);
    } finally {
      ping.mockRestore();
    }
  });

  it("reports degraded while the process is draining, before the socket closes", async () => {
    /*
     * §20. A draining instance is still able to answer, but it must not be given new
     * work. Reporting degraded from the first moment of the drain is what lets the
     * load balancer move traffic away BEFORE `server.close()` takes the listener
     * down — otherwise the probe races the close and clients see resets on every
     * deploy.
     *
     * Driven through the real `shutdown()` on a throwaway server, so the flag is set
     * by the production code path rather than by a mock.
     */
    const throwaway = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", () => resolve()));

    const draining = shutdown(throwaway, "SIGTERM", { timeoutMs: 2_000 });
    try {
      const res = await api.get<Health>("/api/health", { auth: null });
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks?.accepting?.ok).toBe(false);
      // The database is fine — an operator must be able to tell a deploy apart from
      // a real dependency failure.
      expect(res.body.checks?.database?.ok).toBe(true);
    } finally {
      await draining;
      resetLifecycle();
    }

    // And once the flag is cleared the endpoint is ready again.
    const after = await api.get<Health>("/api/health", { auth: null });
    expect(after.status).toBe(200);
  });

  it("is not rate limited into failure by frequent polling", async () => {
    // A liveness probe hits this far more often than any human. If the endpoint
    // shared the normal rate-limit bucket, the probe would eventually receive 429
    // and the orchestrator would kill a perfectly healthy instance.
    const results = await Promise.all(
      Array.from({ length: 40 }, () => api.get<Health>("/api/health", { auth: null })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
