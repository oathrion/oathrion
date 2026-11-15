/**
 * LE REGISTRE D'AUTORITÉ DE LA PASSERELLE (`server/gateway/gateway-ledger.ts`).
 *
 * Une vraie passerelle, de vrais outils simples, le vrai plan d'autorité :
 *
 *   · un outil qui réussit, un outil qui refuse, un outil qui lève : chacun laisse UN reçu,
 *     chaîné, avec la bonne issue, et l'autorisation qu'il cite est consommée ;
 *   · FERMÉ PAR DÉFAUT : si le registre ne peut pas inscrire l'autorisation, l'outil ne
 *     tourne pas, et l'exécution dit que rien n'est parti ;
 *   · un reçu qui ne peut pas être écrit ne change pas ce que l'agent apprend : l'outil a
 *     tourné, l'autorisation consommée sans reçu est ce que `receipt.gap` signale.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";

import { authorityFor } from "../authority";
import { AgentGateway } from "../gateway/agent-gateway";
import { gatewayLedgerFor, type GatewayLedger } from "../gateway/gateway-ledger";
import { ToolRegistry } from "../gateway/tool-registry";
import { CountingTool, type ToolContext, type ToolResult } from "../gateway/tools/types";
import { verifyReceiptChain } from "../authority/receipt-chain";
import { repositoriesFor, seedIfEmpty } from "../repositories";
import { DecisionService } from "../services/decision-service";
import { startTestServer, type TestClient } from "./harness";

const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);
/* Lu APRÈS le démarrage du harnais : le plan d'autorité s'initialise avec lui. */
let store: ReturnType<typeof authorityFor>["store"];

class Tool extends CountingTool {
  constructor(
    readonly id: string,
    private readonly behaviour: "succeed" | "refuse" | "throw",
  ) {
    super();
  }
  readonly name = "Outil de test";
  readonly description = "Pour le registre.";
  protected async run(context: ToolContext): Promise<ToolResult> {
    if (this.behaviour === "throw") throw new Error("le fournisseur a raccroché");
    if (this.behaviour === "refuse") return { ok: false, summary: "refusé par le fournisseur", data: { ok: false, error: "declined" } };
    return { ok: true, summary: `fait sur ${context.target}`, data: { ok: true, id: 42 } };
  }
}

function gateway(tool: Tool, ledger: GatewayLedger | null = gatewayLedgerFor(DEFAULT_ORGANIZATION_ID)): AgentGateway {
  return new AgentGateway(new DecisionService(repositories), repositories, new ToolRegistry([tool], { purchase: tool.id }), "EUR", DEFAULT_ORGANIZATION_ID, ledger);
}

const REQUEST = { agentId: "agt_procurement", action: "purchase", target: "supplier-x.com", metadata: { amount: 10, currency: "EUR", category: "Software" } };

let api: TestClient;
beforeAll(async () => {
  api = await startTestServer();
  await seedIfEmpty();
  store = authorityFor(DEFAULT_ORGANIZATION_ID).store;
});
afterAll(async () => {
  await api.close();
});

describe("chaque outil exécuté laisse UN reçu, chaîné", () => {
  it.each([
    ["succeed", "succeeded"],
    ["refuse", "failed"],
    ["throw", "failed"],
  ] as const)("un outil qui %s → reçu « %s », autorisation consommée, chaîne vérifiée", async (behaviour, outcome) => {
    const tool = new Tool(`ledger_${behaviour}`, behaviour);
    const result = await gateway(tool).execute(REQUEST);
    expect(result.decision).toBe("ALLOW");
    expect(tool.toolExecutionCount).toBe(1);

    const receipts = (await store.listReceiptChain()).filter((r) => r.downstreamExecutionId === result.executionId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ action: "purchase", destinationId: tool.id, outcome, decision: "ALLOW" });
    expect((await store.findGrant(receipts[0]!.grantId))?.state).toBe("consumed");

    expect(verifyReceiptChain(DEFAULT_ORGANIZATION_ID, await store.listReceiptChain()).ok).toBe(true);
    expect((await store.consumedWithoutReceipt()).count).toBe(0);
  });
});

describe("fermé par défaut", () => {
  it("le registre ne peut pas inscrire l'autorisation : l'outil NE tourne PAS, et rien n'est dit parti", async () => {
    const tool = new Tool("ledger_closed", "succeed");
    const broken: GatewayLedger = {
      open: () => Promise.reject(new Error("base injoignable")),
      close: () => Promise.reject(new Error("jamais appelé")),
    };
    const before = (await store.listReceiptChain()).length;
    const result = await gateway(tool, broken).execute(REQUEST);
    expect(tool.toolExecutionCount).toBe(0);
    expect(result.succeeded).toBe(false);
    expect(result.toolResult).toMatchObject({ dispatched: false, reason: "ledger_unavailable" });
    expect((await store.listReceiptChain()).length).toBe(before);
  });

  it("un reçu impossible à écrire ne ment pas à l'agent : l'outil a tourné, et le trou se voit", async () => {
    const tool = new Tool("ledger_gap", "succeed");
    const real = gatewayLedgerFor(DEFAULT_ORGANIZATION_ID);
    const lossy: GatewayLedger = { open: (input) => real.open(input), close: () => Promise.reject(new Error("disque plein")) };
    const result = await gateway(tool, lossy).execute(REQUEST);
    expect(tool.toolExecutionCount).toBe(1);
    expect(result.succeeded).toBe(true);
    const gaps = await store.consumedWithoutReceipt();
    expect(gaps.count).toBe(1);
    expect(gaps.grants.map((g) => g.id).join(" ")).toContain(String(result.executionId));
  });
});
