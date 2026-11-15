/**
 * Integration harness: boots the real Express app on an ephemeral port and
 * exposes a tiny typed fetch client. No mocks, no stubs — requests travel
 * through Express → DecisionService → Policy Engine → SQLite and back.
 */

import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../routes";
import { applySecurity } from "../security";
import { requestContext } from "../request-context";
import { bodyParseErrorHandler } from "../body-parse-error";
import { ensureRivalOrganization } from "./rival-organization";
import { maxBodyBytes } from "../config-check";

/** Credentials wired in `server/test/setup.ts`. */
export const TEST_API_KEY = "test-api-key-123456";
export const TEST_CONSOLE_PASSWORD = "test-console-password";
/** Identity the API key resolves to — what the audit trail must record. */
export const TEST_SERVICE_IDENTITY = "Test Service";

/** One key per role, so a test can assert what each role may and may not do. */
export const ROLE_KEYS = {
  viewer: "test-viewer-key-123456",
  operator: "test-operator-key-123456",
  approver: "test-approver-key-123456",
  admin: TEST_API_KEY,
} as const;

export const TEST_VIEWER_PASSWORD = "test-viewer-password";

/** Sign-in identifiers for the two configured console users. See `setup.ts`. */
export const TEST_CONSOLE_EMAIL = "admin@placet.test";
export const TEST_VIEWER_EMAIL = "viewer@placet.test";

/**
 * Credentials belonging to a DIFFERENT organization (`org_rival_corp`).
 * Same roles, same privileges — different tenant. See `setup.ts`.
 */
export const OTHER_ORG_KEYS = {
  admin: "test-rival-admin-key-0001",
  viewer: "test-rival-viewer-key-001",
} as const;

/**
 * `auth` overrides the bearer credential for a single call:
 * omit it for the default key, pass a string for a bad key, pass `null` to
 * send no Authorization header at all.
 */
export interface RequestOptions {
  auth?: string | null;
  /**
   * Extra request headers. Added for P1-2 so a test can send an `X-Request-Id` — the
   * only way to assert that an inbound correlation id is honoured when it is safe and
   * replaced when it is not.
   */
  headers?: Record<string, string>;
}

export interface Reply<T> {
  status: number;
  body: T;
  /** Response headers, so a test can assert what the browser is actually told. */
  headers: Headers;
}

export interface TestClient {
  /**
   * Origin the harness is listening on, e.g. `http://127.0.0.1:53124`.
   *
   * Added in Phase 8 so a THIRD-PARTY client — specifically the official MCP
   * SDK — can be pointed at the real gateway. Every other test drives the API
   * through `post`/`get` below, which means every MCP test to date has been
   * written by the same hand as the server: a shared misreading of the spec
   * would pass both. A client built from the published spec cannot share that
   * blind spot, and it needs a URL rather than a method.
   */
  baseUrl: string;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Reply<T>>;
  get<T>(path: string, options?: RequestOptions): Promise<Reply<T>>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Reply<T>>;
  /** Ajouté pour le credential d'une destination, dont l'écriture remplace la précédente. */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Reply<T>>;
  del<T>(path: string, options?: RequestOptions): Promise<Reply<T>>;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestClient> {
  /*
   * Avant toute route : les credentials `Rival Corp/` de `setup.ts` doivent retrouver
   * une organisation portant l'identifiant hérité `org_rival_corp` que les tests
   * d'isolation écrivent en dur. Voir `rival-organization.ts` pour la raison, et pour
   * pourquoi cet appel n'est PAS dans `setup.ts`.
   */
  ensureRivalOrganization();

  const app = express();
  // Mirror the production stack: headers set in `applySecurity` are part of the
  // behaviour under test, so the harness must not bypass them.
  applySecurity(app);
  /*
   * Mounted here, in the same position as `server/index.ts`: before the body parser and
   * before every route.
   *
   * This harness is the only place the API is exercised by the suite, so anything
   * production mounts and the harness does not is, by construction, untestable — the
   * gap that let §14's redaction sit unprotected for 610 tests. Correlation would have
   * been the same kind of hole: present in production, absent under test, and therefore
   * free to regress silently.
   */
  app.use(requestContext());
  /*
   * `verify` et `urlencoded` comme en PRODUCTION. Le harnais ne montait que
   * `express.json()` sans capture : le corps brut dont le pare-feu a besoin pour relayer
   * sans re-sérialiser n'existait donc pas sous test, et une requête form-encoded n'y
   * était pas parsée du tout. Un écart entre le harnais et la production est un écart
   * qu'aucun test ne peut voir — c'est la raison même pour laquelle ce fichier existe.
   */
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  // Mirrors production: without this the harness would see Express's HTML
  // error page for an unreadable body while production returns JSON, making
  // the difference untestable.
  app.use(bodyParseErrorHandler());
  app.use(
    express.urlencoded({
      extended: false,
      limit: maxBodyBytes(),
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  /*
   * `express.raw` COMME EN PRODUCTION. Sans lui, un corps `multipart` n'est capturé par
   * aucun parseur et le relais en enverrait un vide — et le harnais ne pourrait pas le
   * voir. Un écart entre le harnais et la production est un écart qu'aucun test ne peut
   * voir ; c'est la raison d'être de ce fichier.
   */
  app.use(
    express.raw({
      type: "*/*",
      limit: maxBodyBytes(),
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function send<T>(method: string, path: string, body?: unknown, options?: RequestOptions) {
    const credential = options && "auth" in options ? options.auth : TEST_API_KEY;
    const headers: Record<string, string> = { ...options?.headers };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (credential) headers.Authorization = `Bearer ${credential}`;

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  return {
    baseUrl: base,
    post: (path, body, options) => send("POST", path, body, options),
    get: (path, options) => send("GET", path, undefined, options),
    patch: (path, body, options) => send("PATCH", path, body, options),
    put: (path, body, options) => send("PUT", path, body, options),
    del: (path, options) => send("DELETE", path, undefined, options),
    close: () => closeServer(httpServer),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

/** Shape returned by POST /api/decision. */
export interface DecisionBody {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  executionId: string | null;
  approvalId: string | null;
  execution: {
    id: string;
    agentId: string;
    action: string;
    target: string;
    status: string;
    risk: string;
    timestamp: string;
    input: Record<string, string | number>;
    decision: string;
    decisionReason: string;
    policyId: string | null;
    policyEvaluated: string | null;
    approvalId: string | null;
    audit: { at: string; actor: string; event: string; detail: string }[];
  } | null;
  approval: { id: string; executionId: string | null; status: string } | null;
}
