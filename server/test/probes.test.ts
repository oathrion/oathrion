/**
 * P1-1 — liveness and readiness must be different questions.
 *
 * THE PROBLEM
 * -----------
 * `/api/health` was the only probe, and it checks the database: it answers 503 when
 * the database is unreachable. That is exactly right for readiness and actively
 * harmful as liveness — and `DEPLOYMENT.md` §14 answered "is the service alive?" by
 * pointing at it.
 *
 * Wire that into a Kubernetes `livenessProbe`, which is what the name invites, and a
 * database outage amplifies itself: every instance answers 503, the kubelet concludes
 * every container is dead, and restarts them all. Each restart re-runs migrations at
 * boot against the database that is already struggling and drops the in-flight
 * requests that would have survived. A restart cannot repair a dependency outside the
 * container, so it can only make the outage worse.
 *
 * The rule these tests encode: **liveness may only fail for something a restart can
 * repair.** Everything else belongs to readiness.
 *
 * WHY THE DRAIN CASE IS HERE
 * --------------------------
 * During a graceful shutdown the process is alive and deliberately finishing work.
 * Liveness answering 503 there would make the kubelet kill the container mid-drain,
 * defeating `server/lifecycle.ts` — which exists so a governed tool call is not cut
 * between its real-world side effect and its audit record.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { resetLifecycle, shutdown } from "../lifecycle";
import { startTestServer, type TestClient } from "./harness";

const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

interface ProbeBody {
  status: string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  uptimeSeconds?: number;
  [key: string]: unknown;
}

describe("GET /api/live", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    resetLifecycle();
    vi.restoreAllMocks();
  });

  it("answers without a credential, because a probe has none", async () => {
    const reply = await api.get<ProbeBody>("/api/live", { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("alive");
  });

  it("stays 200 when the database is unreachable", async () => {
    /*
     * THE CENTRAL ASSERTION OF THIS FILE.
     *
     * If this ever returns 503, a deployment using it as a liveness probe will restart
     * every replica during a database outage. `/api/ready` is the endpoint that must
     * turn traffic away; this one must not invite a restart that cannot help.
     */
    vi.spyOn(repositories, "ping").mockResolvedValue(false);
    const reply = await api.get<ProbeBody>("/api/live", { auth: null });
    expect(reply.status).toBe(200);
  });

  it("stays 200 even when the database check throws", async () => {
    vi.spyOn(repositories, "ping").mockRejectedValue(new Error("disk is gone"));
    const reply = await api.get<ProbeBody>("/api/live", { auth: null });
    expect(reply.status).toBe(200);
  });

  it("stays 200 while the process is draining", async () => {
    /*
     * A 503 here would make an orchestrator SIGKILL the container in the middle of a
     * graceful shutdown, which is the one window in which an in-flight governed action
     * is between its side effect and its audit entry.
     */
    const idle = createServer(() => {});
    await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
    await shutdown(idle, "SIGTERM", { timeoutMs: 50 });

    const reply = await api.get<ProbeBody>("/api/live", { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("alive");
  });

  it("reaches no dependency, so it is cheap enough to probe often", async () => {
    /*
     * Asserted by observation rather than by timing: a timing assertion would be flaky
     * on a loaded machine. If `ping` is never called, the endpoint cannot be slowed by
     * the database — which is the property that matters.
     */
    const ping = vi.spyOn(repositories, "ping");
    await api.get("/api/live", { auth: null });
    expect(ping).not.toHaveBeenCalled();
  });

  it("discloses nothing beyond an uptime", async () => {
    const reply = await api.get<ProbeBody>("/api/live", { auth: null });
    const serialised = JSON.stringify(reply.body);
    // No version, no hostname, no path, no schema version, no tenant, no counts.
    expect(serialised).not.toMatch(/sqlite|postgres|data\.db|migration|\/home|node_modules/i);
    expect(Object.keys(reply.body).sort()).toEqual(["status", "uptimeSeconds"]);
  });
});

describe("GET /api/ready", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    resetLifecycle();
    vi.restoreAllMocks();
  });

  it("answers without a credential", async () => {
    /*
     * A readiness endpoint behind authentication answers 401 to a probe, which every
     * orchestrator reads as "not ready" — so every replica would be permanently
     * unready and no traffic would ever be routed. This is why the path had to be added
     * to PUBLIC_API_PATHS, and why forgetting to would be a total outage rather than a
     * subtle bug.
     */
    const reply = await api.get<ProbeBody>("/api/ready", { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("ok");
  });

  it("fails when the database is unreachable", async () => {
    vi.spyOn(repositories, "ping").mockResolvedValue(false);
    const reply = await api.get<ProbeBody>("/api/ready", { auth: null });
    expect(reply.status).toBe(503);
    expect(reply.body.status).toBe("degraded");
    expect(reply.body.checks?.database.ok).toBe(false);
  });

  it("fails while draining, before the listener closes", async () => {
    const idle = createServer(() => {});
    await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
    await shutdown(idle, "SIGTERM", { timeoutMs: 50 });

    const reply = await api.get<ProbeBody>("/api/ready", { auth: null });
    expect(reply.status).toBe(503);
    expect(reply.body.checks?.accepting.ok).toBe(false);
    // Reported separately, so an operator can tell a deploy from a dependency failure.
    expect(reply.body.checks?.database.ok).toBe(true);
  });

  it("does not report the underlying error, which carries the database path", async () => {
    vi.spyOn(repositories, "ping").mockRejectedValue(
      new Error("SQLITE_CANTOPEN: unable to open /srv/placet/data/data.db"),
    );
    const reply = await api.get<ProbeBody>("/api/ready", { auth: null });
    expect(reply.status).toBe(503);
    expect(JSON.stringify(reply.body)).not.toMatch(/srv|data\.db|SQLITE/i);
    expect(reply.body.checks?.database.detail).toBe("unreachable");
  });
});

describe("/api/health stays an exact alias of /api/ready", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    resetLifecycle();
    vi.restoreAllMocks();
  });

  /*
   * `/api/health` is referenced by the Dockerfile HEALTHCHECK, by `npm run smoke`, by
   * DEPLOYMENT.md and by whatever an operator has already wired up. It is kept rather
   * than renamed, and these tests are what stop the two answers drifting apart — the
   * failure being a load balancer acting on one while an operator reads the other.
   */

  it("agrees when everything is fine", async () => {
    const [health, ready] = await Promise.all([
      api.get<ProbeBody>("/api/health", { auth: null }),
      api.get<ProbeBody>("/api/ready", { auth: null }),
    ]);
    expect(health.status).toBe(ready.status);
    expect(health.body.status).toBe(ready.body.status);
    expect(Object.keys(health.body).sort()).toEqual(Object.keys(ready.body).sort());
  });

  it("agrees when the database is unreachable", async () => {
    vi.spyOn(repositories, "ping").mockResolvedValue(false);
    const health = await api.get<ProbeBody>("/api/health", { auth: null });
    const ready = await api.get<ProbeBody>("/api/ready", { auth: null });
    expect(health.status).toBe(503);
    expect(ready.status).toBe(503);
    expect(health.body.checks?.database.ok).toBe(ready.body.checks?.database.ok);
  });

  it("agrees while draining", async () => {
    const idle = createServer(() => {});
    await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
    await shutdown(idle, "SIGTERM", { timeoutMs: 50 });

    const health = await api.get<ProbeBody>("/api/health", { auth: null });
    const ready = await api.get<ProbeBody>("/api/ready", { auth: null });
    expect(health.status).toBe(503);
    expect(ready.status).toBe(503);
  });
});
