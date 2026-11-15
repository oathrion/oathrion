/**
 * MULTI-TENANT ISOLATION OF THE ACTION AUTHORITY PLANE
 *
 * The legacy decision plane (agents, policies, executions, approvals) is covered by
 * `tenant-isolation.test.ts` and `tenant-isolation-structural.test.ts`. The Phase 10
 * action-authority plane — destinations, action policies, grants, approvals of grants,
 * receipts — had no adversarial cross-tenant suite. This one attacks it twice:
 *
 *   1. at the SERVICE / REPOSITORY layer (`ActionAuthorityStore`, `AuthorizationService`,
 *      `EnforcementPoint`) — the internal paths, no HTTP in between;
 *   2. over HTTP, with a fully privileged admin of a rival organization.
 *
 * Every attack also counts the downstream calls actually received by a real loopback
 * MCP server, so "refused" means "nothing reached the tool", not "a 403 was printed".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrganizationId } from "@shared/tenancy";
import { defineAuthorityTenantAttacks, A_ONLY_DESTINATION } from "./helpers/authority-tenant-attacks";
import { rawDb } from "../db";
import { sqliteExecutor } from "../sql/executor";
import {
  destinationRegistryProblems,
  isRegisteredDestination,
  listDestinations,
  listDestinationsFor,
  resolveDestination,
  UnknownDestinationError,
} from "../authority/destinations";
import { runtimeConfigProblems } from "../config-check";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const ORG_A = A_ONLY_DESTINATION.organizations[0] as OrganizationId;
const ORG_B = "org_tenant_bravo" as OrganizationId;

/** A destination owned by A only. Public, allowlisted, never actually contacted. */
const A_ONLY = A_ONLY_DESTINATION;

function envWith(entries: unknown[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    OATHRION_DESTINATIONS: JSON.stringify(entries),
    OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.alpha.example.com,https://mcp.shared.example.com",
    ...extra,
  } as NodeJS.ProcessEnv;
}

/* -------------------------------------------------------------------------- */
/* 1. Destination registry scoping (pure)                                      */
/* -------------------------------------------------------------------------- */

describe("destination registry — a destination belongs to the tenants it names", () => {
  it("shows A its own destination and hides it from B", () => {
    const env = envWith([A_ONLY]);
    expect(listDestinations(env).map((d) => d.id)).toEqual(["alpha-payments"]);
    expect(listDestinationsFor(ORG_A, env).map((d) => d.id)).toEqual(["alpha-payments"]);
    expect(listDestinationsFor(ORG_B, env)).toEqual([]);
    expect(isRegisteredDestination("alpha-payments", env, ORG_A)).toBe(true);
    expect(isRegisteredDestination("alpha-payments", env, ORG_B)).toBe(false);
  });

  it("resolves A's destination for B exactly like an unknown one, without naming it", () => {
    const env = envWith([A_ONLY]);
    let error: unknown;
    try {
      resolveDestination("alpha-payments", env, ORG_B);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnknownDestinationError);
    // The listing of "registered" ids shown to B must not reveal A's destination.
    expect((error as Error).message).toContain("No destinations are registered");
  });

  it('accepts an explicit "*" as a deliberately shared destination', () => {
    const env = envWith([{ id: "shared-tools", url: "https://mcp.shared.example.com", organizations: "*" }]);
    expect(isRegisteredDestination("shared-tools", env, ORG_A)).toBe(true);
    expect(isRegisteredDestination("shared-tools", env, ORG_B)).toBe(true);
  });

  it("refuses an empty or malformed organizations list instead of guessing", () => {
    for (const organizations of [[], "everyone", ["not-an-org"], [42]]) {
      const env = envWith([{ ...A_ONLY, organizations }]);
      expect(() => listDestinations(env)).toThrow(/organizations|organization id/);
      // And a broken registry authorizes nobody.
      expect(isRegisteredDestination("alpha-payments", env, ORG_A)).toBe(false);
    }
  });

  it("keeps the legacy (undeclared) format shared outside production", () => {
    const { organizations: _ignored, ...legacy } = A_ONLY;
    const env = envWith([legacy]);
    expect(isRegisteredDestination("alpha-payments", env, ORG_B)).toBe(true);
    expect(destinationRegistryProblems(env)).toEqual([]);
  });

  it("refuses at boot, in production, a destination that does not declare its tenants", () => {
    const { organizations: _ignored, ...legacy } = A_ONLY;
    const env = envWith([legacy], { NODE_ENV: "production" });
    const problems = destinationRegistryProblems(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not declare "organizations"/);
    // Wired into the same boot gate as PORT, quotas and posture.
    expect(runtimeConfigProblems(env).join("\n")).toMatch(/does not declare "organizations"/);
    // Defensive runtime behaviour too: nobody can use it.
    expect(isRegisteredDestination("alpha-payments", env, ORG_A)).toBe(false);
  });

  it("accepts the same entry in production once its tenants are declared", () => {
    const env = envWith([A_ONLY], { NODE_ENV: "production" });
    expect(destinationRegistryProblems(env)).toEqual([]);
    expect(isRegisteredDestination("alpha-payments", env, ORG_A)).toBe(true);
    expect(isRegisteredDestination("alpha-payments", env, ORG_B)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 1b. Chantier 1, point 5 — les deux chemins à l'échelle du DÉPLOIEMENT      */
/* -------------------------------------------------------------------------- */

/*
 * Les tests ci-dessus couvrent `OATHRION_DESTINATIONS`, dont chaque entrée nomme ses
 * locataires depuis la Phase 13. Deux chemins y échappaient, et le rapport de la Phase 13
 * le disait (§9) sans que le code l'empêche :
 *
 *   - `OATHRION_LOCAL_MCP_URL` enregistrait `local-fixture` avec `organizations: "*"` sans
 *     que personne ne l'ait déclaré — la faille D1 par un autre chemin ;
 *   - `OATHRION_MCP_DOWNSTREAM_URL` est la destination de repli du déploiement entier, sans
 *     portée possible : l'action de B partirait vers le service aval qui détient les
 *     credentials de A.
 *
 * Note sur la route `/api/execute`, citée avec eux : elle est déjà cadrée par locataire
 * (`scope(req).gateway.execute`). Le danger n'était pas la route mais la destination de
 * repli qu'elle pouvait utiliser, donc il n'y a RIEN à refuser de la route elle-même —
 * et un refus ajouté ici n'aurait mesuré que lui-même.
 */
describe("la fixture loopback doit déclarer ses locataires en production", () => {
  const fixtureEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({ OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/", ...extra }) as NodeJS.ProcessEnv;

  it("reste partagée hors production, comme le développement et le quickstart l'attendent", () => {
    const env = fixtureEnv();
    expect(destinationRegistryProblems(env)).toEqual([]);
    expect(isRegisteredDestination("local-fixture", env, ORG_A)).toBe(true);
    expect(isRegisteredDestination("local-fixture", env, ORG_B)).toBe(true);
  });

  it("refuse le démarrage en production quand sa portée n'est pas déclarée", () => {
    const env = fixtureEnv({ NODE_ENV: "production" });
    const problems = destinationRegistryProblems(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/OATHRION_LOCAL_MCP_ORGANIZATIONS/);
    expect(problems[0]).toMatch(/does not declare "organizations"/);
    // Même porte de démarrage que les quotas, la posture et PORT.
    expect(runtimeConfigProblems(env).join("\n")).toMatch(/OATHRION_LOCAL_MCP_ORGANIZATIONS/);
    // Et, défensivement, elle n'autorise personne en attendant.
    expect(isRegisteredDestination("local-fixture", env, ORG_A)).toBe(false);
  });

  it("démarre en production une fois cadrée, et n'est alors visible que du locataire nommé", () => {
    const env = fixtureEnv({ NODE_ENV: "production", OATHRION_LOCAL_MCP_ORGANIZATIONS: ORG_A });
    expect(destinationRegistryProblems(env)).toEqual([]);
    expect(isRegisteredDestination("local-fixture", env, ORG_A)).toBe(true);
    expect(isRegisteredDestination("local-fixture", env, ORG_B)).toBe(false);
  });

  it('accepte "*" en production, mais seulement écrit noir sur blanc', () => {
    const env = fixtureEnv({ NODE_ENV: "production", OATHRION_LOCAL_MCP_ORGANIZATIONS: "*" });
    expect(destinationRegistryProblems(env)).toEqual([]);
    expect(isRegisteredDestination("local-fixture", env, ORG_B)).toBe(true);
  });

  /*
   * Un cas par forme invalide, avec SON message — pas une alternative qui passerait
   * tant que l'un des trois refus existe. Une liste vide et un identifiant malformé ne
   * sont pas la même erreur d'exploitant, et le message doit le dire.
   */
  const invalidScopes: [string, RegExp][] = [
    ["acme", /is not an organization id/],
    ["org_a, not-an-org", /is not an organization id/],
    [",", /expected a non-empty array of organization ids/],
    ["   ", /does not declare "organizations"/],
  ];

  for (const [scope, reason] of invalidScopes) {
    it(`refuse une portée invalide avec son propre message : ${JSON.stringify(scope)}`, () => {
      const env = fixtureEnv({ NODE_ENV: "production", OATHRION_LOCAL_MCP_ORGANIZATIONS: scope });
      expect(destinationRegistryProblems(env).join("\n")).toMatch(reason);
      // Et, en attendant la correction, la fixture n'autorise personne.
      expect(isRegisteredDestination("local-fixture", env, ORG_A)).toBe(false);
    });
  }
});

describe("la destination de repli du déploiement est refusée en production", () => {
  const remote = {
    OATHRION_MCP_DOWNSTREAM_URL: "https://mcp.shared.example.com",
    OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.shared.example.com",
  };

  it("refuse le démarrage, en nommant la raison et le chemin cadré à utiliser", () => {
    const env = { ...remote, NODE_ENV: "production" } as NodeJS.ProcessEnv;
    const problems = destinationRegistryProblems(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/OATHRION_MCP_DOWNSTREAM_URL is set, and in production it is refused/);
    expect(problems[0]).toMatch(/OATHRION_DESTINATIONS/);
    expect(runtimeConfigProblems(env).join("\n")).toMatch(/OATHRION_MCP_DOWNSTREAM_URL/);
  });

  it("reste utilisable hors production", () => {
    expect(destinationRegistryProblems(remote as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("est refusée même accompagnée d'un registre par ailleurs correct", () => {
    /*
     * Le contrôle qui compte : un déploiement qui a FAIT le travail de cadrer ses
     * destinations peut garder, à côté, un repli non cadré. Le refus ne doit pas se
     * laisser acheter par la présence d'entrées correctes.
     */
    const env = envWith([A_ONLY], { ...remote, NODE_ENV: "production" });
    expect(destinationRegistryProblems(env).join("\n")).toMatch(/OATHRION_MCP_DOWNSTREAM_URL/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Service / repository layer — B attacks A without HTTP (SQLite engine)    */
/*    The same suite runs on PostgreSQL in multitenant-authority-postgres.test */
/* -------------------------------------------------------------------------- */

defineAuthorityTenantAttacks("sqlite", async () => ({
  executor: sqliteExecutor(rawDb),
  cleanup: async () => {},
}));

/* -------------------------------------------------------------------------- */
/* 3. HTTP — a fully privileged rival admin attacks the action routes          */
/* -------------------------------------------------------------------------- */

describe("action authority over HTTP — a rival admin is refused everywhere", () => {
  let api: TestClient;
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  const saved: Record<string, string | undefined> = {};
  const RIVAL = OTHER_ORG_KEYS.admin;
  const OWNER = ROLE_KEYS.admin;

  async function put(path: string, body: unknown, auth: string) {
    const response = await fetch(`${api.baseUrl}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  }
  const delivered = () => mock.receivedOn("/mock/refund").length;
  const refundBody = (amount: number) => ({
    action: "stripe.refund",
    destinationId: "local-fixture",
    agentId: "agt_http_owner",
    arguments: { customer: "cus_9", amount, currency: "EUR" },
  });

  beforeAll(async () => {
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    for (const key of ["OATHRION_LOCAL_MCP_URL", "OATHRION_DESTINATIONS", "OATHRION_MCP_ALLOWED_DESTINATIONS"]) {
      saved[key] = process.env[key];
    }
    process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
    process.env.OATHRION_DESTINATIONS = JSON.stringify([
      { ...A_ONLY, id: "owner-payments", organizations: ["org_default"] },
    ]);
    process.env.OATHRION_MCP_ALLOWED_DESTINATIONS = "https://mcp.alpha.example.com";
    api = await startTestServer();

    for (const rule of [
      { id: "apol_http_small", name: "small", action: "stripe.refund", effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
      { id: "apol_http_big", name: "big", action: "stripe.refund", effect: "APPROVAL_REQUIRED", constraints: [{ field: "amount", op: "gt", value: 100 }], priority: 200 },
    ]) {
      const reply = await put("/api/v1/action-policies", rule, OWNER);
      expect(reply.status).toBe(200);
    }
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await api?.close();
    await mcp?.close();
    await mock?.close();
  });

  it("does not list the owner's tenant-scoped destination to the rival", async () => {
    const owner = await api.get<{ destinations: { id: string }[] }>("/api/v1/actions/destinations", { auth: OWNER });
    const rival = await api.get<{ destinations: { id: string }[] }>("/api/v1/actions/destinations", { auth: RIVAL });
    expect(owner.body.destinations.map((d) => d.id)).toContain("owner-payments");
    expect(rival.body.destinations.map((d) => d.id)).not.toContain("owner-payments");
  });

  it("does not show the rival the owner's action rules, and the rival's PUT does not overwrite them", async () => {
    const rivalList = await api.get<{ policies: { id: string }[] }>("/api/v1/action-policies", { auth: RIVAL });
    expect(rivalList.body.policies.some((p) => p.id.startsWith("apol_http_"))).toBe(false);

    // Same id, opposite effect, written by the rival.
    const squat = await put(
      "/api/v1/action-policies",
      { id: "apol_http_small", name: "rival", action: "stripe.refund", effect: "BLOCK", priority: 100 },
      RIVAL,
    );
    expect(squat.status).toBe(200);
    const ownerList = await api.get<{ policies: { id: string; effect: string }[] }>("/api/v1/action-policies", { auth: OWNER });
    expect(ownerList.body.policies.find((p) => p.id === "apol_http_small")?.effect).toBe("ALLOW");
  });

  it("refuses the rival every use of the owner's grants, approvals and receipts", async () => {
    const allowed = await api.post<{ decision: string; grantId: string; actionHash: string }>(
      "/api/v1/actions/authorize", refundBody(40), { auth: OWNER },
    );
    const held = await api.post<{ decision: string; grantId: string; actionHash: string }>(
      "/api/v1/actions/authorize", refundBody(400), { auth: OWNER },
    );
    expect(allowed.body.decision).toBe("ALLOW");
    expect(held.body.decision).toBe("APPROVAL_REQUIRED");
    const before = delivered();

    // read the grant
    expect((await api.get(`/api/v1/actions/grants/${allowed.body.grantId}`, { auth: RIVAL })).status).toBe(404);
    // execute it
    const exec = await api.post<{ code: string }>(
      "/api/v1/actions/execute", { ...refundBody(40), grantId: allowed.body.grantId }, { auth: RIVAL },
    );
    expect(exec.status).toBe(403);
    // approve / reject the held one
    const approve = await api.post(
      `/api/v1/actions/grants/${held.body.grantId}/approve`, { actionHash: held.body.actionHash }, { auth: RIVAL },
    );
    expect([403, 404, 409]).toContain(approve.status);
    const reject = await api.post(`/api/v1/actions/grants/${held.body.grantId}/reject`, {}, { auth: RIVAL });
    expect([403, 404, 409]).toContain(reject.status);
    expect(delivered()).toBe(before);

    // The owner's state is intact and still usable exactly once.
    const ownerHeld = await api.get<{ grant: { state: string } }>(`/api/v1/actions/grants/${held.body.grantId}`, { auth: OWNER });
    expect(ownerHeld.body.grant.state).toBe("pending_approval");
    const ok = await api.post<{ executed: boolean; receiptId: string }>(
      "/api/v1/actions/execute", { ...refundBody(40), grantId: allowed.body.grantId }, { auth: OWNER },
    );
    expect(ok.status).toBe(200);
    expect(delivered()).toBe(before + 1);

    // receipts
    expect((await api.get(`/api/v1/actions/receipts/${ok.body.receiptId}`, { auth: RIVAL })).status).toBe(404);
    const rivalReceipts = await api.get<{ receipts: { receiptId: string }[] }>("/api/v1/actions/receipts", { auth: RIVAL });
    expect(rivalReceipts.body.receipts.some((r) => r.receiptId === ok.body.receiptId)).toBe(false);
  });

  it("BLOCKs the rival for the owner's destination even with a rule that allows everything", async () => {
    await put(
      "/api/v1/action-policies",
      { id: "apol_rival_all", name: "rival allow all", action: "*", effect: "ALLOW", priority: 999 },
      RIVAL,
    );
    const reply = await api.post<{ decision: string; grantId: string | null }>(
      "/api/v1/actions/authorize",
      { ...refundBody(5), destinationId: "owner-payments", agentId: "agt_rival" },
      { auth: RIVAL },
    );
    expect(reply.body.decision).toBe("BLOCK");
    expect(reply.body.grantId).toBeNull();
  });
});
