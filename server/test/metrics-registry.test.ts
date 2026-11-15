/**
 * Le registre de métriques : ce qu'il compte, et ce qu'il refuse de laisser croître.
 *
 * Ces tests sont ici et non dans `script/verify-observability.ts`, et la raison est la
 * propriété centrale du registre : une valeur d'étiquette hors liste **n'est pas
 * atteignable depuis la surface HTTP**. `surfaceOf` et `statusClass` rendent des valeurs
 * d'un ensemble fermé, les décisions viennent d'une énumération, les codes de refus
 * d'une autre. Le banc ne peut donc pas provoquer une violation — et c'est exactement
 * ce qu'on veut du produit, mais cela veut dire que le garde doit être éprouvé là où on
 * peut l'appeler directement.
 *
 * Constaté en mutant le garde (`if (false && violated …)`) : le banc restait à 50/50,
 * parce qu'aucune violation ne se produit dans un passage sain. Un mutant qui survit
 * parce que la condition n'est jamais réunie ne dit rien sur le garde ; il dit que le
 * garde est testé au mauvais endroit.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  COUNTERS,
  OTHER,
  increment,
  readCounter,
  renderDeploymentMetrics,
  resetMetrics,
  seriesCount,
  noteRateLimitStore,
} from "../observability/metrics";
import { statusClass, surfaceOf } from "../observability/route";

const HEALTHY = { ready: true, databaseReachable: true, draining: false, rateLimitFailClosed: true };

beforeEach(() => resetMetrics());

describe("la cardinalité est bornée par construction", () => {
  it("le nombre de séries est connu et reste modeste", () => {
    /*
     * Un plafond et non une égalité : ajouter une métrique est normal, et un test qui
     * épingle un nombre exact ne ferait qu'exiger d'être réécrit à chaque ajout. Ce qui
     * doit rester vrai, c'est l'ORDRE DE GRANDEUR — quelques dizaines de séries fixes.
     * Le jour où ce test échoue, quelqu'un a étiqueté par une valeur non bornée.
     */
    expect(seriesCount()).toBeGreaterThan(40);
    expect(seriesCount()).toBeLessThan(300);
  });

  it("une page rendue contient exactement les séries déclarées, ni plus ni moins", () => {
    const rendered = renderDeploymentMetrics(HEALTHY);
    const labelled = rendered.split("\n").filter((line) => /^oathrion_[a-z_]+\{/.test(line));
    expect(labelled).toHaveLength(seriesCount());
  });

  it("le trafic ne crée AUCUNE série : dix mille appels, même compte de séries", () => {
    const before = renderDeploymentMetrics(HEALTHY).split("\n").length;
    for (let i = 0; i < 10_000; i += 1) {
      increment("oathrion_http_responses_total", { surface: "actions", class: "2xx" });
    }
    expect(renderDeploymentMetrics(HEALTHY).split("\n")).toHaveLength(before);
  });
});

describe("une valeur d'étiquette hors liste", () => {
  it("est rangée dans `other` plutôt que de créer une série", () => {
    increment("oathrion_action_decisions_total", { decision: "inventé" });
    expect(readCounter("oathrion_action_decisions_total", { decision: OTHER })).toBe(1);
    expect(renderDeploymentMetrics(HEALTHY)).not.toContain("inventé");
  });

  it("est COMPTÉE, parce qu'un compteur qui perd des événements en silence rassure à tort", () => {
    expect(readCounter("oathrion_metric_label_violations_total")).toBe(0);
    increment("oathrion_action_decisions_total", { decision: "inventé" });
    expect(readCounter("oathrion_metric_label_violations_total")).toBe(1);
  });

  it("ne provoque pas de récursion infinie quand c'est la métrique de violation elle-même", () => {
    expect(() => increment("oathrion_metric_label_violations_total", { metric: "inventé" })).not.toThrow();
    expect(readCounter("oathrion_metric_label_violations_total")).toBe(1);
  });

  it("ne lève jamais : la mesure ne doit pas pouvoir casser le mesuré", () => {
    // Un appel sur le chemin d'un remboursement client ne doit pas faire échouer le
    // remboursement parce qu'une étiquette est mal écrite.
    expect(() => increment("oathrion_rate_limit_outcomes_total", { scope: "?", outcome: "?" })).not.toThrow();
  });

  it("une étiquette absente est traitée comme `other`, pas comme une série sans étiquette", () => {
    increment("oathrion_action_refusals_total", {});
    expect(readCounter("oathrion_action_refusals_total", { code: OTHER })).toBe(1);
  });
});

describe("l'ordre des étiquettes ne crée pas de doublon", () => {
  it("deux appels nommant les mêmes étiquettes dans un ordre différent touchent une seule série", () => {
    increment("oathrion_rate_limit_outcomes_total", { scope: "write", outcome: "allowed" });
    increment("oathrion_rate_limit_outcomes_total", { outcome: "allowed", scope: "write" });
    expect(readCounter("oathrion_rate_limit_outcomes_total", { scope: "write", outcome: "allowed" })).toBe(2);
  });
});

describe("ce que la page dit du déploiement", () => {
  it("émet chaque série même à zéro — `absent()` et `== 0` ne sont pas la même alerte", () => {
    const rendered = renderDeploymentMetrics(HEALTHY);
    expect(rendered).toContain('oathrion_action_refusals_total{code="race_lost"} 0');
    expect(rendered).toContain('oathrion_downstream_calls_total{outcome="transport_error"} 0');
  });

  it("reflète une instance en vidange", () => {
    const rendered = renderDeploymentMetrics({ ...HEALTHY, ready: false, draining: true });
    expect(rendered).toContain("oathrion_ready 0");
    expect(rendered).toContain("oathrion_draining 1");
    // Le processus est vivant : c'est tout l'intérêt de distinguer les deux.
    expect(rendered).toContain("oathrion_up 1");
  });

  it("annonce une posture de limiteur ouverte, qui est légale et dangereuse", () => {
    expect(renderDeploymentMetrics({ ...HEALTHY, rateLimitFailClosed: false }))
      .toContain("oathrion_rate_limit_fail_closed 0");
  });

  it("signale un magasin de quotas injoignable", () => {
    noteRateLimitStore(false);
    expect(renderDeploymentMetrics(HEALTHY)).toContain("oathrion_rate_limit_store_reachable 0");
    noteRateLimitStore(true);
    expect(renderDeploymentMetrics(HEALTHY)).toContain("oathrion_rate_limit_store_reachable 1");
  });

  it("porte un en-tête HELP et TYPE pour chaque métrique déclarée", () => {
    const rendered = renderDeploymentMetrics(HEALTHY);
    for (const name of Object.keys(COUNTERS)) {
      expect(rendered).toContain(`# HELP ${name} `);
      expect(rendered).toContain(`# TYPE ${name} counter`);
    }
  });

  it("ne nomme aucun locataire, quelle que soit l'activité", () => {
    increment("oathrion_action_decisions_total", { decision: "allow" });
    expect(renderDeploymentMetrics(HEALTHY)).not.toMatch(/org_[a-z0-9]{20}/);
  });
});

describe("la surface d'un chemin est un ensemble fini", () => {
  it("ne contient jamais d'identifiant, quel que soit le chemin", () => {
    const declared = COUNTERS.oathrion_http_responses_total.labels.surface as readonly string[];
    for (const path of [
      "/api/agents/agt_1234567890",
      "/api/actions/receipts/rcpt_deadbeef",
      "/api/keys/key_abcdef",
      "/api/auth/login",
      "/api/mcp",
      "/api/ready",
      "/",
      "/assets/index-abc123.js",
    ]) {
      expect(declared).toContain(surfaceOf(path));
    }
  });

  it("range les sondes ensemble, y compris la page de métriques elle-même", () => {
    for (const p of ["/api/live", "/api/ready", "/api/health", "/api/metrics"]) {
      expect(surfaceOf(p)).toBe("probe");
    }
  });

  it("classe les statuts et non les statuts eux-mêmes", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(308)).toBe("3xx");
    expect(statusClass(401)).toBe("4xx");
    expect(statusClass(429)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(99)).toBe(OTHER);
  });
});
