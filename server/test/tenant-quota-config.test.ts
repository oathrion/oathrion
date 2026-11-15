/**
 * Chantier 1, étape 1 — the per-tenant quota ceiling becomes a row in the database.
 *
 * Before this step a tenant's ceiling lived in `OATHRION_QUOTAS`, read once per process
 * (`overrides ??=` in server/quotas.ts): changing one customer's ceiling meant editing
 * the deployment's environment and restarting every instance. These tests pin the
 * properties the change must have, on SQLite here and on PostgreSQL in
 * `tenant-quota-config-postgres.test.ts`:
 *
 *   - a ceiling written to the database applies to the NEXT request, no restart;
 *   - a deployment that has only `OATHRION_QUOTAS` behaves exactly as before, and its
 *     per-organization entries are imported once, idempotently;
 *   - a value that differs between the environment and the database refuses the boot,
 *     naming both (the operator's decision, recorded in the session that opened this
 *     chantier), and the application itself can never write such a divergence;
 *   - an invalid ceiling is refused at write time, with a named reason, and cannot
 *     reach the table even by a direct INSERT (CHECK constraints).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_QUOTAS, InvalidQuotaOverride, parseQuotaOverrides } from "@shared/quotas";
import {
  QuotaConfigurationConflict,
  configureQuotas,
  importQuotaOverrides,
  quotaLimitsFor,
  resetQuotaConfig,
  setOrganizationQuota,
} from "../quotas";
import { organizationQuotaStore } from "../repositories/organization-quotas";
import { organizationStore } from "../repositories/organizations";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";
import { ERROR_CODES } from "@shared/error-codes";
import { resetRateLimits } from "../rate-limit";
import { rawDb } from "../db";

const ORG_A = DEFAULT_ORGANIZATION_ID;
const ORG_B = organizationId("org_rival_corp");
const AS_A = { auth: ROLE_KEYS.admin };
const AS_B = { auth: OTHER_ORG_KEYS.admin };

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  // Both layers are process-wide (env seam) or file-wide (the test database): each test
  // hands them back empty so none passes because of what another one left behind.
  resetQuotaConfig();
  rawDb.prepare(`DELETE FROM organization_quotas`).run();
  resetRateLimits();
});

/** The registered tenants, as `registerRoutes` passes them at boot. */
function known() {
  return organizationStore.list().map((o) => o.id);
}

function agentBody(id: string) {
  return {
    id,
    name: "Tenant quota fixture",
    description: "Fixture for the per-tenant quota suite",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "tenant-quota-suite",
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR" as const,
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [],
    policyIds: [],
    tags: [],
  };
}

async function agentCount(auth: { auth: string }): Promise<number> {
  const res = await client.get<{ counters: { counter: string; used: number }[] }>("/api/usage", auth);
  return res.body.counters.find((c) => c.counter === "agents")!.used;
}

describe("a ceiling stored in the database", () => {
  it("applies to the next request, without a restart, and only to its tenant", async () => {
    const used = await agentCount(AS_B);
    setOrganizationQuota(ORG_B, "agents", used);

    const refused = await client.post<{ code: string; limit: number }>(
      "/api/agents",
      agentBody("agt_tq_refused"),
      AS_B,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(ERROR_CODES.quotaExceeded);
    expect(refused.body.limit).toBe(used);

    // Same process, same server, next request: raised in the database, accepted.
    setOrganizationQuota(ORG_B, "agents", used + 1);
    const accepted = await client.post("/api/agents", agentBody("agt_tq_accepted"), AS_B);
    expect(accepted.status).toBe(201);

    // Tenant A was never touched by B's ceiling (positive control on the other tenant).
    const other = await client.post("/api/agents", agentBody("agt_tq_other_tenant"), AS_A);
    expect(other.status).toBe(201);
  });

  it("is what GET /api/usage reports to the tenant", async () => {
    setOrganizationQuota(ORG_A, "policies", 4321);
    const res = await client.get<{ counters: { counter: string; limit: number }[] }>(
      "/api/usage",
      AS_A,
    );
    expect(res.body.counters.find((c) => c.counter === "policies")?.limit).toBe(4321);
  });

  it("wins over the deployment-wide default from OATHRION_QUOTAS", () => {
    configureQuotas({ overrides: parseQuotaOverrides("default:agents=50") });
    setOrganizationQuota(ORG_A, "agents", 7);
    expect(quotaLimitsFor(ORG_A).agents).toBe(7);
    expect(quotaLimitsFor(ORG_B).agents).toBe(50);
  });

  it("leaves counters it does not mention at the environment's value", () => {
    configureQuotas({ overrides: parseQuotaOverrides("default:executions=999") });
    setOrganizationQuota(ORG_A, "agents", 7);
    expect(quotaLimitsFor(ORG_A).executions).toBe(999);
    expect(quotaLimitsFor(ORG_A).policies).toBe(DEFAULT_QUOTAS.policies);
  });
});

describe("an invalid ceiling", () => {
  const invalid: [string, unknown, unknown][] = [
    ["a negative value", "agents", -1],
    ["a fraction", "agents", 1.5],
    ["NaN", "agents", Number.NaN],
    ["a value too large to compare exactly", "agents", 2 ** 60],
    ["a numeric string", "agents", "10"],
    ["an unknown counter", "seats", 10],
  ];

  for (const [label, counter, ceiling] of invalid) {
    it(`is refused at write, with a named reason, and never stored: ${label}`, () => {
      expect(() =>
        setOrganizationQuota(ORG_A, counter as "agents", ceiling as number),
      ).toThrow(InvalidQuotaOverride);
      expect(organizationQuotaStore.ceilingsFor(ORG_A)).toEqual({});
    });
  }

  it("cannot reach the table through a direct INSERT either (CHECK constraints)", () => {
    const now = new Date().toISOString();
    expect(() =>
      rawDb
        .prepare(
          `INSERT INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ORG_A, "agents", -1, "api", now),
      // The message, not merely a throw: a missing table throws too.
    ).toThrow(/CHECK constraint/);
    expect(() =>
      rawDb
        .prepare(
          `INSERT INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ORG_A, "seats", 1, "api", now),
    ).toThrow(/CHECK constraint/);
  });
});

describe("a deployment that only has OATHRION_QUOTAS", () => {
  const ENV = "default:agents=40,org_rival_corp:agents=12,org_rival_corp:executions=300";

  it("resolves exactly the same ceilings after the import as before it", () => {
    configureQuotas({ overrides: parseQuotaOverrides(ENV) });
    const before = { a: quotaLimitsFor(ORG_A), b: quotaLimitsFor(ORG_B) };
    importQuotaOverrides(known());
    expect({ a: quotaLimitsFor(ORG_A), b: quotaLimitsFor(ORG_B) }).toEqual(before);
  });

  it("imports per-organization entries once, and a second boot changes nothing", () => {
    configureQuotas({ overrides: parseQuotaOverrides(ENV) });
    const first = importQuotaOverrides(known());
    expect(first).toEqual({ imported: 2, updated: 0, removed: 0, unchanged: 0 });
    const stored = rawDb
      .prepare(`SELECT * FROM organization_quotas ORDER BY counter`)
      .all() as { counter: string; ceiling: number; source: string; updated_at: string }[];
    expect(stored.map((r) => [r.counter, Number(r.ceiling), r.source])).toEqual([
      ["agents", 12, "environment"],
      ["executions", 300, "environment"],
    ]);

    const second = importQuotaOverrides(known());
    expect(second).toEqual({ imported: 0, updated: 0, removed: 0, unchanged: 2 });
    const again = rawDb
      .prepare(`SELECT * FROM organization_quotas ORDER BY counter`)
      .all() as { updated_at: string }[];
    expect(again.map((r) => r.updated_at)).toEqual(stored.map((r) => r.updated_at));
  });

  it("does not import the deployment-wide default, which stays a property of the deployment", () => {
    configureQuotas({ overrides: parseQuotaOverrides("default:agents=40") });
    expect(importQuotaOverrides(known())).toEqual({ imported: 0, updated: 0, removed: 0, unchanged: 0 });
    expect(organizationQuotaStore.ceilingsFor(ORG_A)).toEqual({});
  });
});

describe("a row imported from OATHRION_QUOTAS keeps following it, as the variable did before", () => {
  it("is updated when the entry is edited and the server restarts (edit + restart still works)", () => {
    configureQuotas({ overrides: parseQuotaOverrides("org_rival_corp:agents=12") });
    importQuotaOverrides(known());
    configureQuotas({ overrides: parseQuotaOverrides("org_rival_corp:agents=20") });
    expect(importQuotaOverrides(known())).toEqual({ imported: 0, updated: 1, removed: 0, unchanged: 0 });
    expect(quotaLimitsFor(ORG_B).agents).toBe(20);
  });

  it("is removed when the entry is removed — the documented way to lift a freeze (DEPLOYMENT §15.3)", async () => {
    configureQuotas({ overrides: parseQuotaOverrides("org_rival_corp:agents=0") });
    importQuotaOverrides(known());
    const frozen = await client.post("/api/agents", agentBody("agt_tq_frozen"), AS_B);
    expect(frozen.status).toBe(409);

    // The operator removes the line and restarts.
    configureQuotas({ overrides: parseQuotaOverrides("") });
    expect(importQuotaOverrides(known())).toEqual({ imported: 0, updated: 0, removed: 1, unchanged: 0 });
    expect(quotaLimitsFor(ORG_B).agents).toBe(DEFAULT_QUOTAS.agents);
    const lifted = await client.post("/api/agents", agentBody("agt_tq_unfrozen"), AS_B);
    expect(lifted.status).toBe(201);
  });

  it("is never touched by the environment once the application owns it", () => {
    setOrganizationQuota(ORG_B, "agents", 33);
    configureQuotas({ overrides: parseQuotaOverrides("") });
    expect(importQuotaOverrides(known())).toEqual({ imported: 0, updated: 0, removed: 0, unchanged: 0 });
    expect(organizationQuotaStore.ceilingsFor(ORG_B)).toEqual({ agents: 33 });
  });
});

describe("a value that differs between OATHRION_QUOTAS and the database", () => {
  it("refuses the boot, naming the tenant, the counter and both values", () => {
    organizationQuotaStore.set(ORG_B, "agents", 99, "api");
    configureQuotas({ overrides: parseQuotaOverrides("org_rival_corp:agents=12") });

    let thrown: unknown;
    try {
      importQuotaOverrides(known());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(QuotaConfigurationConflict);
    const message = (thrown as Error).message;
    expect(message).toContain("org_rival_corp");
    expect(message).toContain("agents");
    expect(message).toContain("12");
    expect(message).toContain("99");
    // Refusing is not repairing: the database keeps its value.
    expect(organizationQuotaStore.ceilingsFor(ORG_B)).toEqual({ agents: 99 });
  });

  it("cannot be created by the application: a write that would diverge from OATHRION_QUOTAS is refused", () => {
    configureQuotas({ overrides: parseQuotaOverrides("org_rival_corp:agents=12") });
    expect(() => setOrganizationQuota(ORG_B, "agents", 13)).toThrow(QuotaConfigurationConflict);
    expect(organizationQuotaStore.ceilingsFor(ORG_B)).toEqual({});
    // Writing the same value is not a divergence.
    setOrganizationQuota(ORG_B, "agents", 12);
    expect(organizationQuotaStore.ceilingsFor(ORG_B)).toEqual({ agents: 12 });
  });
});
