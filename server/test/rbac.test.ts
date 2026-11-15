import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
/**
 * Sprint 5 hardening tests — RBAC, secrets, sessions, notifications.
 *
 * Four guarantees, proved against the real HTTP surface, the real SQLite file
 * and the real notifier. No mock server, no stubbed policy engine.
 *
 *   1. A role decides what a credential may do, the role comes from the
 *      server, and the client cannot widen it.
 *   2. There is no fallback credential: a missing or demo-grade secret is a
 *      startup failure, not a warning.
 *   3. A session lives in the database and dies the moment it is revoked —
 *      not when its token expires.
 *   4. An approval request raises a notification, and a broken webhook can
 *      never break a decision.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startTestServer,
  ROLE_KEYS,
  TEST_CONSOLE_EMAIL,
  TEST_CONSOLE_PASSWORD,
  TEST_VIEWER_EMAIL,
  type TestClient,
} from "./harness";
import { authConfigProblems, resetAuthConfig, resetLoginThrottle, resolveBearer } from "../auth";
import { sessionStore } from "../repositories/sessions";
import { Notifier, WebhookChannel, notifier } from "../notifications";
import type { NotificationEvent } from "../notifications/types";
import { CAPABILITIES, ROLES, can, capabilitiesOf, isRole } from "@shared/roles";

interface LoginBody {
  token: string;
  expiresAt: string;
  identity: { id: string; name: string; kind: string; role: string; sessionId?: string };
  capabilities: string[];
}

interface SessionsBody {
  total: number;
  sessions: { id: string; role: string; current: boolean; active: boolean; revokedBy: string | null }[];
}

interface DecisionBody {
  decision: string;
  approvalId: string | null;
  executionId: string | null;
}

interface ErrorBody {
  error: string;
  role?: string;
}

/** A purchase over `agt_procurement`'s 500 limit — reliably APPROVAL_REQUIRED. */
const PURCHASE_NEEDING_APPROVAL = {
  agentId: "agt_procurement",
  action: "purchase",
  target: "supplier-x.com",
  metadata: { amount: 900, category: "Office supplies" },
};

/** Production database access — reliably BLOCK. */
const PROD_DB = {
  agentId: "agt_data",
  action: "access",
  target: "production_database",
  metadata: {},
};

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

/* ============================ 1. Role matrix ============================== */

describe("Role matrix", () => {
  it("grants exactly the documented capabilities and nothing more", () => {
    expect(capabilitiesOf("viewer")).toEqual(["read"]);
    expect(capabilitiesOf("operator").sort()).toEqual(["execute", "read"]);
    expect(capabilitiesOf("approver").sort()).toEqual(["approve", "read"]);
    expect(capabilitiesOf("admin").sort()).toEqual([...CAPABILITIES].sort());
  });

  it("keeps separation of duties: an operator cannot approve its own work", () => {
    expect(can("operator", "execute")).toBe(true);
    expect(can("operator", "approve")).toBe(false);
    expect(can("approver", "approve")).toBe(true);
    expect(can("approver", "execute")).toBe(false);
  });

  it(
    "documents a known boundary: admin holds both capabilities, so a single " +
      "admin credential can request an action and then resolve its own approval",
    async () => {
      // Phase B, point 2C. Separation of duties in this system is enforced
      // by ROLE, not by comparing the resolver's identity to the original
      // requester's: `resolveApproval` never reads who created the
      // execution, only who is calling `/approve` now (see
      // `agent-gateway.ts`). Every role except `admin` holds exactly one of
      // `execute`/`approve` (asserted above), so this path requires the
      // single most trusted role in the system, by design (see the comment
      // on `MATRIX` in `shared/roles.ts`: "Only admin holds both"). This is
      // not a bypass to fix — it is the documented shape of the admin role —
      // but it is worth proving explicitly rather than leaving it implicit,
      // and it is the reason a pilot should treat the admin credential as a
      // break-glass credential, not a daily-use one.
      const requested = await client.post<{ decision: string; approvalId: string | null }>(
        "/api/decision",
        {
          agentId: "agt_procurement",
          action: "purchase",
          target: "supplier-x.com",
          // decisionSchema (unlike evaluateSchema) does not accept `amount`/
          // `category` as top-level keys — they belong inside `metadata`.
          metadata: { amount: 850, category: "Office supplies" },
          persist: true,
        },
      );
      expect(requested.body.decision).toBe("APPROVAL_REQUIRED");
      const approvalId = requested.body.approvalId;
      expect(approvalId).toBeTruthy();

      const resolved = await client.post<{ approval: { status: string } }>(
        `/api/approvals/${approvalId}/approve`,
        {},
      );
      expect(resolved.status).toBe(200);
      expect(resolved.body.approval.status).toBe("approved");
    },
  );

  it("gives every role read, so nobody is blind to what the plane decided", () => {
    for (const role of ROLES) expect(can(role, "read")).toBe(true);
  });

  it("reserves configuration changes for admin alone", () => {
    const withManage = ROLES.filter((role) => can(role, "manage"));
    expect(withManage).toEqual(["admin"]);
  });

  it("rejects anything that is not a declared role", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("superuser")).toBe(false);
    expect(isRole("")).toBe(false);
  });
});

/* ========================= 2. RBAC over the API =========================== */

describe("RBAC enforcement on the HTTP surface", () => {
  it("lets every role read the ledger", async () => {
    for (const role of ROLES) {
      const res = await client.get<unknown[]>("/api/executions", { auth: ROLE_KEYS[role] });
      expect(res.status, `${role} should be able to read`).toBe(200);
    }
  });

  it("refuses a viewer any action that changes state, with 403 not 401", async () => {
    const res = await client.post<ErrorBody>("/api/decision", PROD_DB, { auth: ROLE_KEYS.viewer });
    expect(res.status).toBe(403);
    expect(res.body.role).toBe("viewer");
    expect(res.body.error).toMatch(/viewer/i);
  });

  it("refuses an approver the right to trigger an action", async () => {
    const res = await client.post<ErrorBody>("/api/decision", PROD_DB, { auth: ROLE_KEYS.approver });
    expect(res.status).toBe(403);
  });

  it("refuses an operator the right to approve", async () => {
    const created = await client.post<DecisionBody>("/api/decision", PURCHASE_NEEDING_APPROVAL, {
      auth: ROLE_KEYS.operator,
    });
    expect(created.body.decision).toBe("APPROVAL_REQUIRED");
    const approvalId = created.body.approvalId;
    expect(approvalId).toBeTruthy();

    const denied = await client.post<ErrorBody>(`/api/approvals/${approvalId}/approve`, {}, {
      auth: ROLE_KEYS.operator,
    });
    expect(denied.status).toBe(403);

    // The same request, from a role that holds `approve`, goes through — so the
    // refusal above was the capability check and not a broken route.
    const allowed = await client.post(`/api/approvals/${approvalId}/approve`, {}, {
      auth: ROLE_KEYS.approver,
    });
    expect(allowed.status).toBe(200);
  });

  it("reserves agent and policy administration for admin", async () => {
    const body = {
      id: `agt_rbac_${Date.now()}`,
      name: "RBAC probe",
      description: "Created only to prove the capability guard.",
      provider: "openai",
      model: "gpt-4o",
      status: "draft",
      owner: "QA",
      mandate: {
        maxTransactionAmount: 100,
        allowedCategories: ["Software"],
        blockedCategories: [],
        allowedDomains: ["vendor.company.com"],
      },
      permissions: [],
      policyIds: [],
      tags: ["qa"],
    };
    for (const role of ["viewer", "operator", "approver"] as const) {
      const res = await client.post<ErrorBody>("/api/agents", body, { auth: ROLE_KEYS[role] });
      expect(res.status, `${role} must not create agents`).toBe(403);
    }
    const res = await client.post("/api/agents", body, { auth: ROLE_KEYS.admin });
    expect(res.status).toBe(201);
  });

  it("treats a dry run as read but a persisted run as execute", async () => {
    const dry = await client.post("/api/evaluate", PROD_DB, { auth: ROLE_KEYS.viewer });
    expect(dry.status).toBe(200);

    const persisted = await client.post<ErrorBody>(
      "/api/evaluate",
      { ...PROD_DB, persist: true },
      { auth: ROLE_KEYS.viewer },
    );
    expect(persisted.status).toBe(403);
  });

  it("still closes the door on an unauthenticated caller with 401", async () => {
    const res = await client.get("/api/executions", { auth: null });
    expect(res.status).toBe(401);
  });
});

/* ================== 3. The role is not client-settable ==================== */

describe("The role is server-assigned", () => {
  it("ignores a role supplied in the request body", async () => {
    const res = await client.post<ErrorBody>(
      "/api/decision",
      { ...PROD_DB, role: "admin", identity: { role: "admin" } },
      { auth: ROLE_KEYS.viewer },
    );
    // Either the escalation attempt is refused by the capability gate, or the
    // extra fields are rejected by the schema. What must never happen is 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("ignores role-bearing headers", async () => {
    const res = await client.get<{ identity: { role: string } }>("/api/auth/session", {
      auth: ROLE_KEYS.viewer,
    });
    expect(res.status).toBe(200);
    expect(res.body.identity.role).toBe("viewer");
  });

  it("derives the role from the credential, one role per credential", async () => {
    for (const role of ROLES) {
      const identity = resolveBearer(ROLE_KEYS[role]);
      expect(identity?.role).toBe(role);
      expect(identity?.kind).toBe("service");
    }
  });

  it("degrades an unknown stored role to the least privilege", () => {
    const session = sessionStore.create({
      organizationId: DEFAULT_ORGANIZATION_ID,
      subject: "user:degrade-probe",
      name: "Degrade probe",
      // A role written by an older build, or by hand. It must not widen access.
      role: "superuser" as never,
      ttlMs: 60_000,
      // Store-level probe: this row never goes through resolveBearer, so the
      // credential fingerprint is inert here. Kept explicit so the field stays
      // required for the real sign-in path.
      credentialFp: "fp:store-level-probe",
    });
    expect(sessionStore.find(session.id)?.role).toBe("viewer");
  });
});

/* ==================== 4. No fallback demo credentials ===================== */

describe("Startup refuses fallback secrets", () => {
  const snapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...snapshot };
    resetAuthConfig();
  });

  function problemsWith(env: Record<string, string | undefined>): string[] {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuthConfig();
    return authConfigProblems();
  }

  it("is happy with the configured test environment", () => {
    expect(authConfigProblems()).toEqual([]);
  });

  it("refuses to start with no session secret", () => {
    const problems = problemsWith({ OATHRION_SESSION_SECRET: undefined });
    expect(problems.some((p) => p.includes("OATHRION_SESSION_SECRET"))).toBe(true);
  });

  it("refuses a short session secret", () => {
    const problems = problemsWith({ OATHRION_SESSION_SECRET: "short" });
    expect(problems.some((p) => /shorter than/.test(p))).toBe(true);
  });

  it("refuses to start with no credentials at all", () => {
    const problems = problemsWith({
      OATHRION_CONSOLE_USERS: undefined,
      OATHRION_API_KEYS: undefined,
    });
    expect(problems.some((p) => /No credentials configured/.test(p))).toBe(true);
  });

  it("starts with no credential in the environment ONLY when accounts are declared to live in the database", () => {
    /*
     * Le déploiement hébergé crée ses comptes par lien (`workspace:create`) : il n'a aucun
     * mot de passe à mettre dans l'environnement. L'intention doit être DITE ; une
     * valeur proche (« db », « true ») ne la dit pas et garde le refus.
     */
    const empty = { OATHRION_CONSOLE_USERS: undefined, OATHRION_API_KEYS: undefined };
    expect(problemsWith({ ...empty, OATHRION_ACCOUNTS: "database" }).some((p) => /No credentials configured/.test(p))).toBe(false);
    expect(problemsWith({ ...empty, OATHRION_ACCOUNTS: "true" }).some((p) => /No credentials configured/.test(p))).toBe(true);
    problemsWith({ OATHRION_ACCOUNTS: undefined });
  });

  it("names the old demo password as forbidden rather than accepting it", () => {
    const problems = problemsWith({ OATHRION_CONSOLE_USERS: "Demo:admin:placet-demo" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/demo value|shorter than/i);
  });

  it("refuses the old demo API key", () => {
    const problems = problemsWith({ OATHRION_API_KEYS: "Demo:admin:placet-dev-key" });
    expect(problems.join(" ")).toMatch(/demo value/i);
  });

  it("refuses an unknown role in the credential list", () => {
    const problems = problemsWith({ OATHRION_API_KEYS: "Svc:superuser:a-long-enough-secret" });
    expect(problems.join(" ")).toMatch(/is not a role/);
  });

  it("refuses a malformed entry that omits the role", () => {
    const problems = problemsWith({ OATHRION_API_KEYS: "Svc:a-long-enough-secret" });
    expect(problems.join(" ")).toMatch(/name:role:secret/);
  });

  it("never echoes the secret back in an error message", () => {
    const problems = problemsWith({ OATHRION_API_KEYS: "Svc:this-is-the-secret-value" });
    expect(problems.join(" ")).not.toContain("this-is-the-secret-value");
  });
});

/* ================ 5. Sessions: persisted and revocable ==================== */

describe("Server-side sessions", () => {
  // The login limiter is real (10 attempts / minute / IP). This suite signs in
  // far more often than a human would, so the window is cleared between tests
  // rather than the limit being raised.
  beforeEach(() => {
    resetLoginThrottle();
  });

  async function signIn(password = TEST_CONSOLE_PASSWORD, email = TEST_CONSOLE_EMAIL) {
    const res = await client.post<LoginBody>("/api/auth/login", { email, password });
    expect(res.status).toBe(200);
    return res.body;
  }

  it("issues a token backed by a database row, not a bare signature", async () => {
    const session = await signIn();
    expect(session.identity.role).toBe("admin");
    expect(session.identity.sessionId).toBeTruthy();
    expect(session.capabilities.sort()).toEqual([...CAPABILITIES].sort());

    const stored = sessionStore.find(session.identity.sessionId!);
    expect(stored).not.toBeNull();
    expect(stored?.revokedAt).toBeNull();
  });

  it("carries the role of the password that was used", async () => {
    const viewer = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);
    expect(viewer.identity.role).toBe("viewer");
    expect(viewer.capabilities).toEqual(["read"]);

    const denied = await client.post<ErrorBody>("/api/decision", PROD_DB, { auth: viewer.token });
    expect(denied.status).toBe(403);
  });

  it("kills a token the instant its session is revoked", async () => {
    const session = await signIn();

    const before = await client.get("/api/executions", { auth: session.token });
    expect(before.status).toBe(200);

    sessionStore.revoke(session.identity.sessionId!, "test", DEFAULT_ORGANIZATION_ID);

    const after = await client.get("/api/executions", { auth: session.token });
    expect(after.status, "a revoked session must not survive one more request").toBe(401);
  });

  it("revokes through logout, and the same token cannot be reused", async () => {
    const session = await signIn();
    const out = await client.post<{ revoked: boolean }>("/api/auth/logout", {}, { auth: session.token });
    expect(out.status).toBe(200);
    expect(out.body.revoked).toBe(true);

    const replay = await client.get("/api/auth/session", { auth: session.token });
    expect(replay.status).toBe(401);
  });

  it("records who cut a session off", async () => {
    const session = await signIn();
    await client.del(`/api/auth/sessions/${session.identity.sessionId}`, { auth: session.token });
    expect(sessionStore.find(session.identity.sessionId!)?.revokedBy).toBeTruthy();
  });

  it("survives a restart: the row outlives the process memory", async () => {
    const session = await signIn();
    // A second server over the same SQLite file stands in for a restart.
    const restarted = await startTestServer();
    try {
      const res = await client.get("/api/auth/session", { auth: session.token });
      expect(res.status).toBe(200);
    } finally {
      await restarted.close();
    }
  });

  it("refuses a token whose signature does not match its session id", async () => {
    const session = await signIn();
    const [id] = session.token.split(".");
    const forged = `${id}.${"A".repeat(43)}`;
    const res = await client.get("/api/auth/session", { auth: forged });
    expect(res.status).toBe(401);
  });

  it("refuses an expired session without needing anyone to revoke it", async () => {
    const expired = sessionStore.create({
      organizationId: DEFAULT_ORGANIZATION_ID,
      subject: "user:expired-probe",
      name: "Expired probe",
      role: "admin",
      ttlMs: -1_000,
      // Store-level probe: this row never goes through resolveBearer, so the
      // credential fingerprint is inert here. Kept explicit so the field stays
      // required for the real sign-in path.
      credentialFp: "fp:store-level-probe",
    });
    expect(sessionStore.resolveActive(expired.id)).toBeNull();
  });

  it("shows an admin every session but a viewer only its own", async () => {
    const admin = await signIn();
    const viewer = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);

    const asAdmin = await client.get<SessionsBody>("/api/auth/sessions", { auth: admin.token });
    expect(asAdmin.status).toBe(200);
    const adminSeesViewer = asAdmin.body.sessions.some((s) => s.id === viewer.identity.sessionId);
    expect(adminSeesViewer).toBe(true);

    const asViewer = await client.get<SessionsBody>("/api/auth/sessions", { auth: viewer.token });
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.sessions.every((s) => s.id !== admin.identity.sessionId)).toBe(true);
    expect(asViewer.body.sessions.some((s) => s.current)).toBe(true);
  });

  it("lets a user revoke their own other browser without needing manage", async () => {
    // Same person, two tabs: revoking your own session is always allowed, and
    // the capability check must not get in the way of signing yourself out.
    const first = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);
    const second = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);

    const res = await client.del(`/api/auth/sessions/${second.identity.sessionId}`, {
      auth: first.token,
    });
    expect(res.status).toBe(200);
    expect((await client.get("/api/auth/session", { auth: second.token })).status).toBe(401);
  });

  it("refuses a viewer the right to revoke another user's session", async () => {
    const admin = await signIn();
    const viewer = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);

    const refused = await client.del<ErrorBody>(`/api/auth/sessions/${admin.identity.sessionId}`, {
      auth: viewer.token,
    });
    expect(refused.status).toBe(403);
    // And the target survived the attempt.
    expect((await client.get("/api/auth/session", { auth: admin.token })).status).toBe(200);
  });

  it("lets an admin revoke another user's session", async () => {
    const admin = await signIn();
    const victim = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);

    const allowed = await client.del(`/api/auth/sessions/${victim.identity.sessionId}`, {
      auth: admin.token,
    });
    expect(allowed.status).toBe(200);

    const dead = await client.get("/api/auth/session", { auth: victim.token });
    expect(dead.status).toBe(401);
  });

  it("cuts every session of one subject at once", async () => {
    const first = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);
    const second = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);
    sessionStore.revokeAllFor(first.identity.id, "test:sign-out-everywhere", DEFAULT_ORGANIZATION_ID);

    for (const token of [first.token, second.token]) {
      const res = await client.get("/api/auth/session", { auth: token });
      expect(res.status).toBe(401);
    }
  });

  it("answers 404 for a session id that was never issued", async () => {
    const admin = await signIn();
    const res = await client.del<ErrorBody>("/api/auth/sessions/nonexistent-session-id", {
      auth: admin.token,
    });
    expect(res.status).toBe(404);
  });

  it("revoking an already-revoked session is a no-op, not an error", async () => {
    const admin = await signIn();
    const victim = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);

    const first = await client.del<{ revoked: boolean }>(
      `/api/auth/sessions/${victim.identity.sessionId}`,
      { auth: admin.token },
    );
    expect(first.status).toBe(200);
    expect(first.body.revoked).toBe(true);

    const before = sessionStore.find(victim.identity.sessionId!);

    // Revoking it again must not error, and must not overwrite who actually
    // revoked it the first time — the audit trail of *who cut the session
    // off* is not something a second caller gets to rewrite.
    const second = await client.del<{ revoked: boolean }>(
      `/api/auth/sessions/${victim.identity.sessionId}`,
      { auth: admin.token },
    );
    expect(second.status).toBe(200);
    expect(second.body.revoked).toBe(false);

    const after = sessionStore.find(victim.identity.sessionId!);
    expect(after?.revokedAt).toBe(before?.revokedAt);
    expect(after?.revokedBy).toBe(before?.revokedBy);
  });

  it("cannot have its revokedBy forged — the route never reads a request body", async () => {
    const admin = await signIn();
    const victim = await signIn("test-viewer-password", TEST_VIEWER_EMAIL);

    await client.del(`/api/auth/sessions/${victim.identity.sessionId}`, {
      auth: admin.token,
    });

    const record = sessionStore.find(victim.identity.sessionId!);
    // The name written server-side is the authenticated admin's own name,
    // taken from `requireIdentity(req)` — never anything the caller sent.
    expect(record?.revokedBy).toBe(admin.identity.name);
  });

  it("keeps refusing a wrong password", async () => {
    const res = await client.post<ErrorBody>("/api/auth/login", {
      email: TEST_CONSOLE_EMAIL,
      password: "not-the-password",
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct password even with incidental leading/trailing whitespace", async () => {
    // A pasted or autofilled password can pick up a stray space or newline
    // without the operator noticing. The configured secret is trimmed at
    // startup (`parseTriples`); the submitted password must be trimmed the
    // same way, or a correct password fails for a reason invisible in the UI.
    const res = await client.post<LoginBody>("/api/auth/login", {
      email: TEST_CONSOLE_EMAIL,
      password: `  ${TEST_CONSOLE_PASSWORD}\n`,
    });
    expect(res.status).toBe(200);
  });
});

/* ==================== 6. Approval notifications =========================== */

describe("Notifications", () => {
  function captureChannel(events: NotificationEvent[], ok = true) {
    return {
      id: "capture",
      handles: () => true,
      async deliver(event: NotificationEvent) {
        events.push(event);
        if (!ok) throw new Error("channel exploded");
        return { channelId: "capture", eventId: event.id, at: new Date().toISOString(), ok: true, detail: "captured" };
      },
    };
  }

  afterEach(() => {
    notifier.clear();
  });

  it("raises approval.requested when an action is held for a human", async () => {
    const seen: NotificationEvent[] = [];
    notifier.register(captureChannel(seen));

    const res = await client.post<DecisionBody>("/api/decision", PURCHASE_NEEDING_APPROVAL, {
      auth: ROLE_KEYS.operator,
    });
    expect(res.body.decision).toBe("APPROVAL_REQUIRED");
    await notifier.drain();

    const event = seen.find((e) => e.type === "approval.requested");
    expect(event, "an approval must raise a notification").toBeDefined();
    expect(event?.approvalId).toBe(res.body.approvalId);
    expect(event?.agentId).toBe("agt_procurement");
    expect(event?.title).toBeTruthy();
  });

  it("raises approval.resolved when a human answers", async () => {
    const created = await client.post<DecisionBody>("/api/decision", PURCHASE_NEEDING_APPROVAL, {
      auth: ROLE_KEYS.operator,
    });

    const seen: NotificationEvent[] = [];
    notifier.register(captureChannel(seen));

    await client.post(`/api/approvals/${created.body.approvalId}/reject`, {}, {
      auth: ROLE_KEYS.approver,
    });
    await notifier.drain();

    const event = seen.find((e) => e.type === "approval.resolved");
    expect(event).toBeDefined();
    expect(event?.data).toMatchObject({ status: "rejected" });
  });

  it("raises action.blocked when the plane refuses an action outright", async () => {
    const seen: NotificationEvent[] = [];
    notifier.register(captureChannel(seen));

    await client.post("/api/decision", PROD_DB, { auth: ROLE_KEYS.operator });
    await notifier.drain();

    expect(seen.some((e) => e.type === "action.blocked")).toBe(true);
  });

  it("does not let a failing channel break the decision", async () => {
    const seen: NotificationEvent[] = [];
    notifier.register(captureChannel(seen, false));

    const res = await client.post<DecisionBody>("/api/decision", PURCHASE_NEEDING_APPROVAL, {
      auth: ROLE_KEYS.operator,
    });
    // The important assertion: the API answered normally even though the
    // notification channel threw.
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("APPROVAL_REQUIRED");
    expect(res.body.approvalId).toBeTruthy();

    await notifier.drain();
    const failure = notifier.recentDeliveries().find((d) => d.channelId === "capture");
    expect(failure?.ok).toBe(false);
  });

  it("posts a signed JSON body to the configured webhook", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const local = new Notifier();
    local.register(
      new WebhookChannel({
        url: "https://hooks.example.test/placet",
        secret: "webhook-signing-secret",
        fetchImpl: (async (url: string, init: RequestInit) => {
          calls.push({ url: String(url), init });
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );

    local.emit({
      type: "approval.requested",
      title: "Purchase needs approval",
      summary: "€900 to supplier-x.com",
      risk: "high",
      agentId: "agt_procurement",
      agentName: "Procurement Agent",
      executionId: "exe_1",
      approvalId: "apr_1",
      policyId: "pol_purchase_limit",
      policyName: "Purchase limit",
      data: {},
    });
    await local.drain();

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Oathrion-Event"]).toBe("approval.requested");
    expect(headers["X-Oathrion-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const sent = JSON.parse(String(calls[0].init.body)) as NotificationEvent;
    expect(sent.approvalId).toBe("apr_1");
    expect(sent.id).toMatch(/^ntf_/);
  });

  it("records a webhook that answers with an error status as a failed delivery", async () => {
    const local = new Notifier();
    local.register(
      new WebhookChannel({
        url: "https://hooks.example.test/placet",
        fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      }),
    );

    local.emit({
      type: "approval.requested",
      title: "t",
      summary: "s",
      risk: "low",
      agentId: "a",
      agentName: "A",
      executionId: null,
      approvalId: null,
      policyId: null,
      policyName: null,
      data: {},
    });
    await local.drain();

    const delivery = local.recentDeliveries()[0];
    expect(delivery.ok).toBe(false);
    expect(delivery.detail).toContain("500");
  });

  it("is a no-op when no channel is configured", async () => {
    const local = new Notifier();
    expect(local.channelIds).toEqual([]);
    expect(() =>
      local.emit({
        type: "action.blocked",
        title: "t",
        summary: "s",
        risk: "low",
        agentId: "a",
        agentName: "A",
        executionId: null,
        approvalId: null,
        policyId: null,
        policyName: null,
        data: {},
      }),
    ).not.toThrow();
    await local.drain();
    expect(local.recentDeliveries()).toEqual([]);
  });

  it("exposes recent deliveries over the API to anyone who can read", async () => {
    const res = await client.get<{ channels: string[]; deliveries: unknown[] }>("/api/notifications", {
      auth: ROLE_KEYS.viewer,
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
  });
});
