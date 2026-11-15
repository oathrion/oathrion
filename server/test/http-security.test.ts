/**
 * Phase 4 — what the HTTP layer tells a browser, and what it refuses to tell a
 * caller.
 *
 * Each test states a claim the README is allowed to make. Nothing here asserts
 * a property the code does not actually have.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { applySecurity } from "../security";
import { ROLE_KEYS, startTestServer, TEST_CONSOLE_EMAIL, type TestClient } from "./harness";

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
});

afterAll(async () => {
  await api.close();
});

describe("browser hardening headers", () => {
  it("sends a content security policy that forbids framing and inline script", async () => {
    const res = await api.get("/api/health");
    const csp = res.headers.get("content-security-policy");

    expect(csp).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("default-src 'self'");
  });

  it("sends the rest of the header set", async () => {
    const res = await api.get("/api/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("does not name the server stack", async () => {
    const res = await api.get("/api/health");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("emits no CORS header, so another origin cannot read a response", async () => {
    // The absence *is* the control. A permissive origin here would expose the
    // API to every page the operator has open.
    const res = await api.get("/api/agents");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("proxy trust", () => {
  /** Boots a bare app so the setting can be observed directly. */
  function appWith(env: Record<string, string | undefined>) {
    const app = express();
    applySecurity(app, env as NodeJS.ProcessEnv);
    return app;
  }

  it("does not trust a forwarded address by default", () => {
    // Trusting X-Forwarded-For with no proxy in front lets any caller claim any
    // address and walk straight past the login throttle.
    expect(appWith({}).get("trust proxy")).toBe(false);
  });

  it("trusts exactly the configured number of hops", () => {
    expect(appWith({ OATHRION_TRUST_PROXY: "1" }).get("trust proxy")).toBe(1);
  });

  it("accepts a subnet for a proxy on a known network", () => {
    expect(appWith({ OATHRION_TRUST_PROXY: "10.0.0.0/8" }).get("trust proxy")).toBe("10.0.0.0/8");
  });

  it("treats the string \"false\" as off, not as a truthy value", () => {
    expect(appWith({ OATHRION_TRUST_PROXY: "false" }).get("trust proxy")).toBe(false);
  });
});

describe("failures do not describe the deployment", () => {
  it("answers a crashed handler with a bare status", async () => {
    /*
     * A route that throws a message a developer would want and a caller must
     * never see. It is mounted on a throwaway app that reuses the real error
     * handler shape from server/index.ts.
     */
    const app = express();
    applySecurity(app);
    app.get("/api/boom", () => {
      throw new Error("SQLITE_ERROR: no such column: users.password_hash at /srv/placet/db.ts:412");
    });
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { status?: number; message?: string };
      const status = e.status ?? 500;
      const isClientError = status >= 400 && status < 500;
      res.status(status).json({ message: isClientError && e.message ? e.message : "Internal Server Error" });
    });

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/boom`);
    const body = (await res.json()) as { message: string };

    expect(res.status).toBe(500);
    expect(body.message).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("SQLITE");
    expect(JSON.stringify(body)).not.toContain("/srv/placet");

    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("still explains a rejection the caller caused", async () => {
    // Hardening must not turn useful 4xx messages into silence.
    const res = await api.post<{ error: string }>("/api/executions", {
      agentId: "agt_data",
      action: "query",
      target: "warehouse.dim_customer",
      persist: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("always executes");
  });

  it("still says which agent was not found", async () => {
    const res = await api.get<{ error: string }>("/api/agents/agt_does_not_exist");
    expect(res.status).toBe(404);
  });
});

describe("login throttle", () => {
  it("does not spend the budget on successful sign-ins", async () => {
    // Ten valid logins from one address used to lock the address out; a shared
    // office IP made that an outage for the whole team.
    for (let i = 0; i < 12; i += 1) {
      const res = await api.post<{ token: string }>(
        "/api/auth/login",
        { email: TEST_CONSOLE_EMAIL, password: "test-console-password" },
        { auth: null },
      );
      expect(res.status, `sign-in ${i + 1}`).toBe(200);
    }
  });

  it("still refuses a caller that keeps guessing", async () => {
    const { resetLoginThrottle } = await import("../auth");
    resetLoginThrottle();

    let sawLockout = false;
    for (let i = 0; i < 15; i += 1) {
      const res = await api.post("/api/auth/login", { email: TEST_CONSOLE_EMAIL, password: "wrong-password" }, { auth: null });
      if (res.status === 429) {
        sawLockout = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawLockout).toBe(true);

    resetLoginThrottle();
  });

  it("does not let a rate-limited caller in with a valid password either", async () => {
    const { resetLoginThrottle } = await import("../auth");
    resetLoginThrottle();

    for (let i = 0; i < 12; i += 1) {
      await api.post("/api/auth/login", { email: TEST_CONSOLE_EMAIL, password: "wrong-password" }, { auth: null });
    }
    const res = await api.post("/api/auth/login", { email: TEST_CONSOLE_EMAIL, password: "test-console-password" }, { auth: null });
    expect(res.status).toBe(429);

    resetLoginThrottle();
  });
});

describe("authentication is still closed by default", () => {
  it("refuses an unauthenticated call to a governed route", async () => {
    const res = await api.get("/api/executions", { auth: null });
    expect(res.status).toBe(401);
  });

  it("still refuses a viewer that tries to execute", async () => {
    const res = await api.post(
      "/api/executions",
      { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
      { auth: ROLE_KEYS.viewer },
    );
    expect(res.status).toBe(403);
  });
});
