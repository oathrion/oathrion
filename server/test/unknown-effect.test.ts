/**
 * UNE REQUÊTE PARTIE SANS RÉPONSE N'EST NI « RIEN ENVOYÉ » NI REJOUABLE.
 *
 * Défaut trouvé à l'audit de lancement : un délai dépassé APRÈS l'envoi était rapporté
 * `dispatched: false` par les trois connecteurs, et l'exécution restait rejouable. Slack
 * a pu publier, le reçu disait le contraire, et un nouvel essai publiait une seconde fois.
 *
 * Ce fichier fixe les trois étages : le transport sait si la requête est partie, le
 * connecteur le dit, et la règle de rejeu refuse ce qui pourrait doubler un effet.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";
import type { Execution } from "@shared/types";

import { requestMayHaveReached, sendGuarded } from "../notifications/webhook-transport";
import { GithubConnector } from "../connectors/github";
import { SlackConnector } from "../connectors/slack";
import type { ConnectorVault } from "../connectors/vault";
import { replaySafe, retryabilityOf, unknownEffectReason } from "../gateway/retryability";

let silent: Server;
let silentPort = 0;
let received = 0;

beforeAll(async () => {
  /* Accepte la requête, la lit entièrement, et ne répond JAMAIS. */
  silent = createServer((req) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      received += 1;
    });
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  silentPort = (silent.address() as AddressInfo).port;
});

afterAll(async () => {
  silent.closeAllConnections();
  await new Promise<void>((r) => silent.close(() => r()));
});

async function failureOf(url: string, allowPrivate = true): Promise<unknown> {
  try {
    await sendGuarded({ url: new URL(url), method: "POST", headers: {}, body: "{}", timeoutMs: 800, allowPrivate, captureBody: true });
  } catch (error) {
    return error;
  }
  throw new Error("la requête aurait dû échouer");
}

describe("le transport sait si la requête est partie", () => {
  it("un serveur muet après réception : l'effet est INCONNU", async () => {
    const before = received;
    const error = await failureOf(`http://127.0.0.1:${String(silentPort)}/x`);
    expect(String(error)).toMatch(/timed out/);
    expect(received).toBe(before + 1);
    expect(requestMayHaveReached(error)).toBe(true);
  });

  it("une connexion refusée : RIEN n'est parti", async () => {
    /* Un port qu'on vient de libérer : rien n'y écoute. */
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const error = await failureOf(`http://127.0.0.1:${String(port)}/x`);
    expect(requestMayHaveReached(error)).toBe(false);
  });

  it("une adresse bloquée par la garde anti-SSRF : RIEN n'est parti", async () => {
    const error = await failureOf(`http://127.0.0.1:${String(silentPort)}/x`, false);
    expect(requestMayHaveReached(error)).toBe(false);
  });

  it("une adresse IP littérale privée est refusée AVANT toute connexion (métadonnées cloud)", async () => {
    /*
     * Défaut trouvé en écrivant le test précédent : Node n'appelle pas `lookup` pour une
     * IP littérale, donc la garde au niveau de la socket ne la voyait pas. Le serveur muet
     * RECEVAIT la requête malgré `allowPrivate: false`.
     */
    const before = received;
    const started = Date.now();
    for (const url of ["http://169.254.169.254/latest/meta-data/", `http://127.0.0.1:${String(silentPort)}/x`, "http://[::1]:9/x"]) {
      const error = await failureOf(url, false);
      expect((error as Error).name, url).toBe("BlockedAddressError");
    }
    expect(received).toBe(before);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("une erreur venue d'ailleurs est traitée comme inconnue, jamais comme « rien envoyé »", () => {
    expect(requestMayHaveReached(new Error("autre"))).toBe(true);
    expect(requestMayHaveReached("chaîne")).toBe(true);
  });
});

describe("le connecteur le dit", () => {
  it("Slack muet après réception : dispatched « unknown », et la phrase dit de vérifier", async () => {
    const vault = {
      open: () => Promise.resolve({ secretEnvelope: "xoxb-1111111111-2222222222-jetonmuetplacetxxxx", account: "", scopes: [] }),
      describe: () => Promise.resolve(null),
    } as unknown as ConnectorVault;
    const result = await new SlackConnector().execute(
      {
        organizationId: "org_test" as OrganizationId,
        vault,
        env: {
          OATHRION_SLACK_API_ORIGIN: `http://127.0.0.1:${String(silentPort)}`,
          OATHRION_WEBHOOK_ALLOW_PRIVATE: "true",
          OATHRION_CONNECTOR_TIMEOUT_MS: "1000",
        },
      },
      { action: "slack.message.post", target: "slack.com/C0PRODUIT01", metadata: { text: "x" }, executionId: "exe_1" },
    );
    expect(result).toMatchObject({ ok: false, code: "unreachable", data: { dispatched: "unknown" } });
    expect(result.summary).toMatch(/MAY/);
  });

  /*
   * Trouvé à l'audit de l'interface du 27 octobre 2026 (STRESS-TEST-LOG §5.39) : le
   * connecteur GitHub RENDAIT ses appels depuis son `try` sans les attendre, et un délai
   * dépassé sortait en exception brute — sans `dispatched: "unknown"`, donc rejouable.
   * Ce test échoue sur ce code-là : `execute` y rejette au lieu de rendre un résultat.
   */
  it("GitHub muet après réception d'une création d'issue : dispatched « unknown », pas une exception", async () => {
    const before = received;
    const vault = {
      open: () => Promise.resolve({ secretEnvelope: "github_pat_jetonmuetoathrion", account: "", scopes: [] }),
      describe: () => Promise.resolve(null),
    } as unknown as ConnectorVault;
    const result = await new GithubConnector().execute(
      {
        organizationId: "org_test" as OrganizationId,
        vault,
        env: {
          OATHRION_GITHUB_API_ORIGIN: `http://127.0.0.1:${String(silentPort)}`,
          OATHRION_WEBHOOK_ALLOW_PRIVATE: "true",
          OATHRION_CONNECTOR_TIMEOUT_MS: "1000",
        },
      },
      { action: "github.issue.create", target: "github.com/essai/produit", metadata: { title: "x" }, executionId: "exe_1" },
    );
    expect(received).toBe(before + 1);
    expect(result).toMatchObject({ ok: false, code: "unreachable", data: { dispatched: "unknown" } });
    expect(result.summary).toMatch(/^GitHub did not answer in time/);
    expect(result.summary).toMatch(/MAY/);
  });
});

function failedRun(action: string, dispatched: unknown): Execution {
  return {
    id: "exe_x",
    agentId: "agt",
    agentName: "agt",
    action,
    target: "t",
    status: "failed",
    risk: "low",
    durationMs: 1,
    cost: 0,
    timestamp: new Date().toISOString(),
    input: {},
    decision: "allow",
    decisionReason: "",
    policyEvaluated: null,
    policyId: null,
    result: "",
    audit: [],
    runState: "failed",
    attempts: 1,
    toolResult: { dispatched, reason: "transport_error" },
  } as Execution;
}

describe("la règle de rejeu refuse ce qui pourrait doubler un effet", () => {
  it("un message Slack à l'effet inconnu n'est pas rejouable, et le motif le dit", () => {
    const r = retryabilityOf(failedRun("slack.message.post", "unknown"), null);
    expect(r.retryable).toBe(false);
    expect(r.reason).toBe(unknownEffectReason());
  });

  it("une issue GitHub non plus", () => {
    expect(retryabilityOf(failedRun("github.issue.create", "unknown"), null).retryable).toBe(false);
  });

  it("une création Linear NON PLUS : le refus du doublon par Linear n'est pas vérifié contre le service", () => {
    expect(retryabilityOf(failedRun("linear.issue.create", "unknown"), null).retryable).toBe(false);
  });

  it("une lecture l'est : elle n'a pas d'effet", () => {
    expect(retryabilityOf(failedRun("slack.history.read", "unknown"), null).retryable).toBe(true);
  });

  it("un échec où RIEN n'est parti reste rejouable", () => {
    expect(retryabilityOf(failedRun("slack.message.post", false), null).retryable).toBe(true);
  });

  it("la confirmation n'est offerte que si elle suffit : pas quand les essais sont épuisés", () => {
    const unknown = retryabilityOf(failedRun("slack.message.post", "unknown"), null);
    expect(unknown.requiresConfirmation).toBe(true);
    const exhausted = retryabilityOf({ ...failedRun("slack.message.post", "unknown"), attempts: 99 }, null);
    expect(exhausted.retryable).toBe(false);
    expect(exhausted.requiresConfirmation).toBeUndefined();
    expect(exhausted.reason).not.toBe(unknownEffectReason());
  });

  it("une approbation EXPIRÉE l'emporte : ni relance, ni attestation proposée", () => {
    const lapsed = retryabilityOf(failedRun("slack.message.post", "unknown"), { expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(lapsed.retryable).toBe(false);
    expect(lapsed.requiresConfirmation).toBeUndefined();
    expect(lapsed.reason).toMatch(/expired/);
  });

  it("les verbes rejouables sont des lectures, et chacun est sans effet chez le service", () => {
    /*
     * L'inventaire exact de la liste blanche, vérifié verbe par verbe dans les connecteurs :
     * GitHub GET /user/repos, GET /repos/{o}/{r}, GET /repos/{o}/{r}/issues ; Slack
     * users.conversations, conversations.history ; Linear requêtes `teams` et `issues`
     * (GraphQL query, jamais mutation). Une écriture qui ajouterait le suffixe par erreur
     * échouerait ici.
     */
    const safe = [
      "github.repos.list", "github.repo.read", "github.issue.search",
      "slack.channels.list", "slack.history.read",
      "linear.teams.list", "linear.issue.search",
    ];
    for (const verb of safe) expect(replaySafe(verb), verb).toBe(true);
    for (const verb of ["github.issue.create", "github.issue.comment", "slack.message.post", "linear.issue.create", "linear.comment.create"]) {
      expect(replaySafe(verb), verb).toBe(false);
    }
  });

  it("la liste des verbes sûrs est fermée", () => {
    expect(replaySafe("slack.message.post")).toBe(false);
    expect(replaySafe("github.issue.comment")).toBe(false);
    expect(replaySafe("linear.comment.create")).toBe(false);
    expect(replaySafe("github.repos.list")).toBe(true);
  });
});
