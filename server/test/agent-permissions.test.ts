/**
 * Agent permissions — PATCH /api/agents/:id
 *
 * Covers: the schema accepts a valid permissions array, the write is
 * actually persisted (not just accepted), a re-fetch reflects it, an
 * unknown scope is rejected, an unknown field on a permission entry is
 * rejected, more entries than known scopes is rejected, the full catalog the
 * console sends is accepted, and a credential without
 * `manage` cannot touch this at all.
 *
 * Honesty note on the two items this file does NOT claim to prove: the
 * policy engine (`shared/policy/engine.ts`) does not currently read
 * `agent.permissions` at all — grep confirms zero references. `DecisionService`
 * computes `agent.permissions.filter(p => p.granted).map(p => p.scope)` and
 * hands it to the engine as `EvaluationAgent.permissions`, but nothing in the
 * engine consults that field for ALLOW/BLOCK/APPROVAL_REQUIRED today. This is
 * pre-existing, documented debt (see README/DEPLOYMENT limits), not something
 * introduced or fixed here. So this file proves persistence and round-trip
 * accuracy of `granted` — not that a decision changes based on it, because it
 * factually does not yet.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import type { Permission } from "@shared/types";
import { PERMISSION_CATALOG } from "@shared/seed/agents";
import { MAX_PERMISSIONS } from "@shared/validation";

const AGENT = "agt_infra";

interface AgentBody {
  id: string;
  permissions: Permission[];
}

interface ErrorBody {
  error: string;
}

describe("PATCH /api/agents/:id — permissions", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("accepts a valid permissions array and returns 200", async () => {
    const res = await api.patch<AgentBody>(`/api/agents/${AGENT}`, {
      permissions: [
        {
          scope: "read:analytics",
          label: "Read analytics",
          description: "Query dashboards and warehouse metrics.",
          granted: true,
          risk: "low",
        },
      ],
    });
    expect(res.status).toBe(200);
  });

  it("actually persists the write — a fresh GET reflects it, not just the PATCH response", async () => {
    await api.patch<AgentBody>(`/api/agents/${AGENT}`, {
      permissions: [
        {
          scope: "execute:payments",
          label: "Execute payments",
          description: "Initiate purchases and transfers.",
          granted: true,
          risk: "critical",
        },
      ],
    });

    const fetched = await api.get<AgentBody>(`/api/agents/${AGENT}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.permissions).toHaveLength(1);
    expect(fetched.body.permissions[0].scope).toBe("execute:payments");
    expect(fetched.body.permissions[0].granted).toBe(true);
  });

  it("round-trips granted:false accurately — it is not silently coerced to true", async () => {
    await api.patch<AgentBody>(`/api/agents/${AGENT}`, {
      permissions: [
        {
          scope: "write:database",
          label: "Write database",
          description: "Mutate rows in production databases.",
          granted: false,
          risk: "critical",
        },
      ],
    });
    const fetched = await api.get<AgentBody>(`/api/agents/${AGENT}`);
    expect(fetched.body.permissions[0].granted).toBe(false);
  });

  it("rejects a scope that is not in the fixed catalog", async () => {
    const res = await api.patch<ErrorBody>(`/api/agents/${AGENT}`, {
      permissions: [
        {
          scope: "sudo:everything",
          label: "Everything",
          description: "",
          granted: true,
          risk: "low",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown field on a permission entry", async () => {
    const res = await api.patch<ErrorBody>(`/api/agents/${AGENT}`, {
      permissions: [
        {
          scope: "read:analytics",
          label: "Read analytics",
          description: "Query dashboards and warehouse metrics.",
          granted: true,
          risk: "low",
          expiresAt: "2099-01-01",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("accepts the full catalog, exactly as the console's permission editor sends it", async () => {
    /*
     * The editor sends every catalog entry, granted or not. The cap was a hand-written 24;
     * the `mcp:*` scopes brought the catalog to 25, and every save from the console failed
     * with a bare « Invalid patch » — found on 2026-10-28 in the real `oathrion wrap` trial.
     */
    const draft = PERMISSION_CATALOG.map((p) => (p.scope === "mcp:destructive" ? { ...p, granted: true } : p));
    expect(draft.length).toBe(MAX_PERMISSIONS);
    const res = await api.patch<AgentBody>(`/api/agents/${AGENT}`, { permissions: draft });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.permissions.find((p) => p.scope === "mcp:destructive")?.granted).toBe(true);
  });

  it("rejects more entries than there are known scopes, and says why", async () => {
    const tooMany = Array.from({ length: MAX_PERMISSIONS + 1 }, (_, i) => ({
      scope: "read:analytics" as const,
      label: `Entry ${i}`,
      description: "",
      granted: true,
      risk: "low" as const,
    }));
    const res = await api.patch<ErrorBody>(`/api/agents/${AGENT}`, { permissions: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid patch: /);
  });

  it("refuses a viewer credential — manage capability is required", async () => {
    const res = await api.patch<ErrorBody>(
      `/api/agents/${AGENT}`,
      {
        permissions: [
          {
            scope: "read:analytics",
            label: "Read analytics",
            description: "Query dashboards and warehouse metrics.",
            granted: true,
            risk: "low",
          },
        ],
      },
      { auth: ROLE_KEYS.viewer },
    );
    expect(res.status).toBe(403);
  });

  it("carries the granted scopes into DecisionService's evaluation input (data flow only — see file header)", async () => {
    await api.patch<AgentBody>(`/api/agents/${AGENT}`, {
      permissions: [
        {
          scope: "call:external-api",
          label: "Call external APIs",
          description: "Reach third-party HTTP endpoints.",
          granted: true,
          risk: "medium",
        },
        {
          scope: "read:files",
          label: "Read files",
          description: "Read documents in connected drives.",
          granted: false,
          risk: "low",
        },
      ],
    });
    const fetched = await api.get<AgentBody>(`/api/agents/${AGENT}`);
    const scopes = fetched.body.permissions.filter((p) => p.granted).map((p) => p.scope);
    // This is exactly the projection DecisionService.decide() computes
    // (`agent.permissions.filter(p => p.granted).map(p => p.scope)`) before
    // handing it to the engine. It is verified here at the data layer; it is
    // not asserted to change a decision outcome, because the engine does not
    // yet consult it.
    expect(scopes).toEqual(["call:external-api"]);
  });
});
