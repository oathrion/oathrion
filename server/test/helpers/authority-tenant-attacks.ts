/**
 * Cross-tenant attacks on the action-authority plane, at the repository / service
 * layer, parameterised by SQL engine so the SAME attacks run on SQLite and on a real
 * PostgreSQL server. Used by `multitenant-authority-isolation.test.ts` (SQLite) and
 * `multitenant-authority-postgres.test.ts` (PostgreSQL).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrganizationId } from "@shared/tenancy";
import type { SqlExecutor } from "../../sql/executor";
import { ActionAuthorityStore } from "../../authority/store";
import { AuthorizationService } from "../../authority/authorization-service";
import { EnforcementPoint } from "../../authority/enforcement-point";
import { buildActionEnvelope } from "../../action/canonical";
import { startMockDownstream, type MockDownstream } from "../../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../../mcp-local/local-mcp-server";

const RUN = `${process.pid}${Date.now().toString(36)}`;

/** A destination owned by one tenant only. Public, allowlisted, never contacted. */
export const A_ONLY_DESTINATION = {
  id: "alpha-payments",
  url: "https://mcp.alpha.example.com",
  label: "Alpha payments MCP",
  organizations: ["org_tenant_alpha"] as string[],
};

/* -------------------------------------------------------------------------- */
/* 2. Service / repository layer — B attacks A without HTTP                    */
/* -------------------------------------------------------------------------- */

export function defineAuthorityTenantAttacks(
  engine: "sqlite" | "postgres",
  open: () => Promise<{ executor: SqlExecutor; cleanup: () => Promise<void> }>,
): void {
describe(`action authority (${engine}) — internal paths refuse every cross-tenant use`, () => {
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  let env: NodeJS.ProcessEnv;
  let executor: SqlExecutor;
  let cleanup: () => Promise<void> = async () => {};
  let storeA: ActionAuthorityStore;
  let storeB: ActionAuthorityStore;
  // Unique per run so a reused database can never make a test pass.
  const ORG_A = `org_alpha_${engine}_${RUN}` as OrganizationId;
  const ORG_B = `org_bravo_${engine}_${RUN}` as OrganizationId;
  const deletePolicy = (org: OrganizationId, id: string) =>
    executor.run("DELETE FROM action_policies WHERE organization_id = ? AND id = ?", [org, id]);

  const now = new Date().toISOString();
  function refund(tenant: OrganizationId, agentId: string, amount: number, destinationId = "local-fixture") {
    return buildActionEnvelope({
      tenantId: String(tenant),
      agentId,
      request: {
        action: "stripe.refund",
        destinationId,
        arguments: { customer: "cus_1", amount, currency: "EUR" },
      },
    });
  }
  const delivered = () => mock.receivedOn("/mock/refund").length;

  beforeAll(async () => {
    ({ executor, cleanup } = await open());
    storeA = new ActionAuthorityStore(executor, ORG_A);
    storeB = new ActionAuthorityStore(executor, ORG_B);
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    env = {
      OATHRION_LOCAL_MCP_URL: mcp.url,
      OATHRION_DESTINATIONS: JSON.stringify([{ ...A_ONLY_DESTINATION, organizations: [ORG_A] }]),
      OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.alpha.example.com",
    } as NodeJS.ProcessEnv;

    // Each tenant writes its OWN rules. Same verb, opposite meaning, same rule id.
    for (const [store, effect] of [
      [storeA, "ALLOW"],
      [storeB, "BLOCK"],
    ] as const) {
      await store.savePolicy({
        id: "apol_small_refund",
        name: `small refunds (${effect})`,
        action: "stripe.refund",
        destinationId: null,
        effect,
        constraints: [{ field: "amount", op: "lte", value: 100 }],
        priority: 100,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    await storeA.savePolicy({
      id: "apol_big_refund",
      name: "big refunds need a human",
      action: "stripe.refund",
      destinationId: null,
      effect: "APPROVAL_REQUIRED",
      constraints: [{ field: "amount", op: "gt", value: 100 }],
      priority: 200,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await mock?.close();
    await cleanup();
  });

  it("lets two tenants use the same policy id without touching each other's rule", async () => {
    const a = await storeA.listPolicies();
    const b = await storeB.listPolicies();
    expect(a.find((p) => p.id === "apol_small_refund")?.effect).toBe("ALLOW");
    expect(b.find((p) => p.id === "apol_small_refund")?.effect).toBe("BLOCK");
    expect(b.some((p) => p.id === "apol_big_refund")).toBe(false);
  });

  it("decides each tenant's action with that tenant's rules only", async () => {
    const authA = new AuthorizationService(storeA, ORG_A, env);
    const authB = new AuthorizationService(storeB, ORG_B, env);
    expect((await authA.authorize(refund(ORG_A, "agt_a", 50))).decision).toBe("ALLOW");
    expect((await authB.authorize(refund(ORG_B, "agt_b", 50))).decision).toBe("BLOCK");
    // B has no approval rule: A's APPROVAL_REQUIRED rule does not leak into B.
    expect((await authB.authorize(refund(ORG_B, "agt_b", 500))).decision).toBe("BLOCK");
  });

  /**
   * L'INVARIANTE : UN GRANT DONT LA DÉCISION EST `BLOCK` N'EXISTE PAS.
   *
   * Un passage de la suite complète a produit, deux fois, une ligne de grant portant
   * `decision: "BLOCK"`, `state: "issued"`, `idempotencyKey: null`. L'isolation entre
   * locataires avait tenu — le refus était correct — mais une ligne existait là où
   * `authorize()` rend `grant: null`.
   *
   * La lecture du code ferme les deux seules voies connues : `authorize()` retourne avant
   * tout appel à `createGrant` quand le verdict est BLOCK, et le rejeu idempotent exige
   * une `idempotencyKey` que `buildActionEnvelope` laisse à `null` ici. Le mécanisme
   * reste INCONNU, et il n'a pas été reproduit.
   *
   * Ces deux tests ne prétendent donc pas l'avoir corrigé. Ils posent l'invariante à
   * l'ÉCRITURE, là où elle n'était nulle part : `consumeGrant` portait déjà
   * `AND decision <> 'BLOCK'`, mais une consommation bloquée laisse la base incohérente
   * — un auditeur y lit une autorisation là où il n'y en a jamais eu.
   *
   * Et l'effet le plus utile est le second : si le mécanisme inconnu se déclenche à
   * nouveau, il LÈVE avec son propre nom au lieu d'écrire une ligne en silence. Une
   * anomalie qui se signale finit par être trouvée ; celle-ci avait coûté deux passages
   * de suite à simplement être remarquée.
   */
  it("REFUSE d'écrire un grant dont la décision est BLOCK", async () => {
    await expect(
      storeB.createGrant({
        id: "grant_impossible",
        actionId: "act_impossible",
        agentId: "agt_b",
        action: "stripe.refund",
        actionHash: "x".repeat(64),
        destinationId: "alpha-payments",
        decision: "BLOCK",
        state: "issued",
        requestId: null,
        idempotencyKey: null,
        policyId: null,
        createdAt: now,
        issuedAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        consumedAt: null,
        consumedBy: null,
        approvalId: null,
        approvedAt: null,
        approvedBy: null,
        revokedAt: null,
        revokedReason: null,
      }),
    ).rejects.toThrow(/decision is BLOCK/);

    /* Et RIEN n'a été écrit : le refus précède l'insertion, il ne la défait pas. */
    expect(await storeB.findGrant("grant_impossible")).toBeUndefined();
  });

  it("un BLOCK ne laisse aucune ligne de grant derrière lui", async () => {
    /*
     * L'invariante vue depuis la décision, et non depuis le dépôt : c'est la forme sous
     * laquelle l'anomalie s'était manifestée.
     */
    const authB = new AuthorizationService(storeB, ORG_B, env);
    const outcome = await authB.authorize(refund(ORG_B, "agt_b", 50));
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.grant).toBeNull();
    expect(await storeB.findGrantsForAction(outcome.action.id)).toEqual([]);
  });

  it("BLOCKs B for A's destination at authorization, with no grant", async () => {
    const authB = new AuthorizationService(storeB, ORG_B, env);
    await storeB.savePolicy({
      id: "apol_b_allow_all",
      name: "B allows everything (attacker-written rule)",
      action: "*",
      destinationId: null,
      effect: "ALLOW",
      constraints: [],
      priority: 999,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const outcome = await authB.authorize(refund(ORG_B, "agt_b", 10, "alpha-payments"));
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.grant).toBeNull();
    expect(outcome.reason).toMatch(/not registered for this tenant/);
    // Remove the attacker rule so later tests see B's real posture.
    await deletePolicy(ORG_B, "apol_b_allow_all");
  });

  it("refuses at execution a grant whose destination was re-scoped away from the tenant", async () => {
    // B obtains a grant while the destination is shared…
    const sharedEnv = {
      ...env,
      OATHRION_DESTINATIONS: JSON.stringify([{ ...A_ONLY_DESTINATION, organizations: "*" }]),
    } as NodeJS.ProcessEnv;
    await storeB.savePolicy({
      id: "apol_b_alpha",
      name: "B to alpha",
      action: "stripe.refund",
      destinationId: "alpha-payments",
      effect: "ALLOW",
      constraints: [],
      priority: 500,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const envelope = refund(ORG_B, "agt_b", 10, "alpha-payments");
    const issued = await new AuthorizationService(storeB, ORG_B, sharedEnv).authorize(envelope);
    expect(issued.decision).toBe("ALLOW");
    expect(issued.grant?.state).toBe("issued");

    // …then the operator scopes it to A. The live grant must not outlive that.
    const result = await new EnforcementPoint(storeB, ORG_B, env).execute({
      grantId: issued.grant!.id,
      envelope,
      presentedBy: "attacker",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("DESTINATION_UNKNOWN");
    // Not consumed: refusal happened before the single-use claim.
    expect((await storeB.findGrant(issued.grant!.id))?.state).toBe("issued");
    await deletePolicy(ORG_B, "apol_b_alpha");
  });

  it("does not let B read, consume, approve, reject or revoke A's grants", async () => {
    const authA = new AuthorizationService(storeA, ORG_A, env);
    const allowed = await authA.authorize(refund(ORG_A, "agt_a", 60));
    const held = await authA.authorize(refund(ORG_A, "agt_a", 600));
    expect(allowed.grant?.state).toBe("issued");
    expect(held.grant?.state).toBe("pending_approval");
    const before = delivered();

    // read
    expect(await storeB.findGrant(allowed.grant!.id)).toBeUndefined();
    expect(await storeB.findGrantByApprovalId(held.grant!.approvalId!)).toBeUndefined();
    expect((await storeB.listGrants(1000)).some((g) => g.id === allowed.grant!.id)).toBe(false);
    expect(await storeB.findAction(allowed.action.id)).toBeUndefined();

    // consume, with every bound field correct except the tenant
    const consumed = await storeB.consumeGrant({
      id: allowed.grant!.id,
      agentId: "agt_a",
      actionHash: allowed.grant!.actionHash,
      destinationId: "local-fixture",
      at: new Date().toISOString(),
      consumedBy: "attacker",
    });
    expect(consumed.claimed).toBe(false);

    // execute through B's enforcement point, presenting A's exact envelope
    const viaB = await new EnforcementPoint(storeB, ORG_B, env).execute({
      grantId: allowed.grant!.id,
      envelope: refund(ORG_A, "agt_a", 60),
      presentedBy: "attacker",
    });
    expect(viaB.ok === false && viaB.code).toBe("GRANT_NOT_FOUND");

    // approve / reject / revoke A's pending grant
    const authB = new AuthorizationService(storeB, ORG_B, env);
    expect(
      (await authB.approve({ grantId: held.grant!.id, expectedActionHash: held.grant!.actionHash, approvedBy: "attacker" })).ok,
    ).toBe(false);
    expect((await authB.reject({ grantId: held.grant!.id, rejectedBy: "attacker" })).ok).toBe(false);
    expect(await storeB.revokeGrant(allowed.grant!.id, new Date().toISOString(), "attack")).toBe(false);

    // Nothing changed for A, and nothing reached the tool.
    expect((await storeA.findGrant(allowed.grant!.id))?.state).toBe("issued");
    expect((await storeA.findGrant(held.grant!.id))?.state).toBe("pending_approval");
    expect(delivered()).toBe(before);
  });

  it("A's own grant still works once, so the refusals above are isolation and not breakage", async () => {
    const authA = new AuthorizationService(storeA, ORG_A, env);
    const envelope = refund(ORG_A, "agt_a", 70);
    const issued = await authA.authorize(envelope);
    const before = delivered();
    const enforcement = new EnforcementPoint(storeA, ORG_A, env);
    const first = await enforcement.execute({ grantId: issued.grant!.id, envelope, presentedBy: "agent-a" });
    expect(first.ok).toBe(true);
    expect(delivered()).toBe(before + 1);
    const replay = await enforcement.execute({ grantId: issued.grant!.id, envelope, presentedBy: "agent-a" });
    expect(replay.ok === false && replay.code).toBe("GRANT_ALREADY_CONSUMED");
    expect(delivered()).toBe(before + 1);

    // B cannot see the receipt A just produced.
    const receiptId = first.ok ? first.receipt.receiptId : "";
    expect(await storeB.findReceipt(receiptId)).toBeUndefined();
    expect(await storeB.findReceiptByGrant(issued.grant!.id)).toBeUndefined();
    expect((await storeB.listReceipts(1000)).some((r) => r.receiptId === receiptId)).toBe(false);
    expect(await storeA.findReceipt(receiptId)).toBeDefined();
  });

  it("refuses a wrong agent inside the right tenant, and does not consume the grant", async () => {
    const authA = new AuthorizationService(storeA, ORG_A, env);
    const envelope = refund(ORG_A, "agt_a", 80);
    const issued = await authA.authorize(envelope);
    const before = delivered();
    const result = await new EnforcementPoint(storeA, ORG_A, env).execute({
      grantId: issued.grant!.id,
      envelope: refund(ORG_A, "agt_other", 80),
      presentedBy: "other",
    });
    expect(result.ok === false && ["AGENT_MISMATCH", "ACTION_MISMATCH"]).toContain(
      result.ok === false ? result.code : "",
    );
    expect((await storeA.findGrant(issued.grant!.id))?.state).toBe("issued");
    expect(delivered()).toBe(before);
  });
});
}
