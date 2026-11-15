/**
 * « BLOQUER TOUT SAUF » — les exceptions d'une règle de refus.
 *
 * La phrase qu'un client dit en connectant Slack : « l'agent ne publie que dans
 * #produit ». Elle s'écrit maintenant : BLOCK_TOOL sur `slack.com`, sauf
 * `slack.com/C0PRODUIT`. Ce fichier fixe ce que l'exception laisse passer — la cible
 * exacte — et surtout ce qu'elle ne laisse PAS passer.
 */

import { describe, expect, it } from "vitest";

import { policyCreateContract } from "../validation";
import { evaluateAction } from "./engine";
import type { EvaluationAgent, PolicyRule } from "./types";

const AGENT: EvaluationAgent = {
  id: "agt_dev",
  name: "Agent de dev",
  status: "active",
  permissions: ["read:chat", "write:chat", "read:tasks", "write:tasks"],
  policyIds: [],
};

function rule(overrides: Partial<PolicyRule>): PolicyRule {
  return {
    id: "pol_only_product",
    name: "Seulement #produit",
    description: "",
    type: "BLOCK_TOOL",
    condition: {
      kind: "targetMatches",
      targets: ["slack.com"],
      actions: ["slack.message.post", "slack.history.read"],
      exceptTargets: ["slack.com/C0PRODUIT1"],
    },
    action: "BLOCK",
    status: "enabled",
    appliesToAgentIds: null,
    risk: "HIGH",
    priority: 50,
    ...overrides,
  };
}

function decide(target: string, policies: PolicyRule[], action = "slack.message.post") {
  return evaluateAction({ agent: AGENT, action, target, metadata: { text: "x" }, policies });
}

describe("BLOCK_TOOL avec exceptions", () => {
  it("le canal choisi passe", () => {
    expect(decide("slack.com/C0PRODUIT1", [rule({})]).decision).toBe("ALLOW");
  });

  it("tout autre canal est bloqué, avec la règle nommée", () => {
    const result = decide("slack.com/C0AUTRE001", [rule({})]);
    expect(result.decision).toBe("BLOCK");
    expect(result.policyId).toBe("pol_only_product");
  });

  it("l'exception est STRICTE : elle ne s'applique pas par segment", () => {
    /* Le segment `slack.com/C0PRODUIT1` n'existe pas dans ces cibles, mais un appariement
       laxiste l'y trouverait. Bloqué. */
    expect(decide("evil.example/slack.com/C0PRODUIT1", [rule({ condition: { kind: "targetMatches", targets: ["slack.com", "evil.example"], exceptTargets: ["slack.com/C0PRODUIT1"] } })]).decision).toBe("BLOCK");
    expect(decide("slack.com/C0PRODUIT1/../C0AUTRE001", [rule({})]).decision).toBe("BLOCK");
  });

  it("une cible écrite autrement reste bloquée — la règle échoue fermée", () => {
    expect(decide("https://slack.com/C0PRODUIT1", [rule({})]).decision).toBe("BLOCK");
  });

  it("les actions hors de la règle ne sont pas touchées", () => {
    expect(decide("slack.com", [rule({})], "slack.channels.list").decision).toBe("ALLOW");
  });

  it("un joker dans l'exception couvre une équipe Linear et ses issues", () => {
    const linear = rule({
      condition: {
        kind: "targetMatches",
        targets: ["linear.app"],
        actions: ["linear.issue.create", "linear.comment.create", "linear.issue.search"],
        exceptTargets: ["linear.app/ENG", "linear.app/ENG/*"],
      },
    });
    expect(decide("linear.app/ENG", [linear], "linear.issue.create").decision).toBe("ALLOW");
    expect(decide("linear.app/ENG/ENG-12", [linear], "linear.comment.create").decision).toBe("ALLOW");
    expect(decide("linear.app/OPS", [linear], "linear.issue.create").decision).toBe("BLOCK");
    expect(decide("linear.app/OPS/OPS-1", [linear], "linear.comment.create").decision).toBe("BLOCK");
  });
});

describe("REQUIRE_HUMAN_APPROVAL avec exceptions", () => {
  it("retient tout sauf l'exception", () => {
    const hold = rule({ type: "REQUIRE_HUMAN_APPROVAL", action: "APPROVAL_REQUIRED" });
    expect(decide("slack.com/C0AUTRE001", [hold]).decision).toBe("APPROVAL_REQUIRED");
    expect(decide("slack.com/C0PRODUIT1", [hold]).decision).toBe("ALLOW");
  });

  it("un BLOCK sans exception l'emporte toujours sur une exception d'approbation", () => {
    const hold = rule({ id: "pol_hold", type: "REQUIRE_HUMAN_APPROVAL", action: "APPROVAL_REQUIRED" });
    const block = rule({ id: "pol_block_all", condition: { kind: "targetMatches", targets: ["slack.com"] } });
    expect(decide("slack.com/C0PRODUIT1", [hold, block]).decision).toBe("BLOCK");
  });
});

describe("le contrat d'API", () => {
  const base = {
    id: "pol_x",
    name: "Seulement le canal produit",
    description: "",
    scope: "organization",
    appliesTo: "all agents",
    effect: "block",
    status: "enabled",
    risk: "high",
    priority: 5,
  };

  it("accepte des exceptions sur BLOCK_TOOL", () => {
    const parsed = policyCreateContract.safeParse({
      ...base,
      type: "BLOCK_TOOL",
      action: "BLOCK",
      condition: { kind: "targetMatches", targets: ["slack.com"], exceptTargets: ["slack.com/C0PRODUIT1"] },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("refuse des exceptions sur ALLOW_TOOL, où elles ne voudraient rien dire", () => {
    const parsed = policyCreateContract.safeParse({
      ...base,
      type: "ALLOW_TOOL",
      action: "ALLOW",
      effect: "allow",
      condition: { kind: "targetMatches", targets: ["slack.com"], exceptTargets: ["slack.com/C0X"] },
    });
    expect(parsed.success).toBe(false);
  });
});
