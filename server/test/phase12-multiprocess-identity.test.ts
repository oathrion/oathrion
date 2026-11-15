/**
 * PHASE 12 — l'identité entre plusieurs processus Oathrion, sur PostgreSQL réel.
 *
 * Ce fichier est la preuve, ou l'absence de preuve, de la seule affirmation qui compte
 * pour la Phase 12 : **la vérité d'identité vit dans la base, pas dans un processus.**
 *
 * Chaque instance est un vrai processus enfant (`server/test/fixtures/phase12-identity-instance.ts`),
 * pas un module réimporté. Deux appels dans le même processus partagent le cache de
 * modules, la connexion et tout état en mémoire ; ils passeraient même si les sessions
 * étaient stockées dans une `Map`. Ici, l'instance qui ouvre la session n'est jamais celle
 * qui la vérifie, et celle qui révoque n'est jamais celle qui doit refuser ensuite.
 *
 * ## Ce que le fichier fait quand PostgreSQL est absent
 *
 * Il est SKIPPÉ, bruyamment, et n'est jamais rejoué sur SQLite. Un test d'identité
 * partagée exécuté sur un fichier local ne teste rien : SQLite ne peut pas être partagé
 * entre deux conteneurs. Un SKIP visible est honnête ; un PASS obtenu sur le mauvais
 * moteur est un mensonge dans un rapport de sécurité.
 *
 * Pour l'exécuter :
 *   OATHRION_TEST_IDENTITY_PG_URL=postgres://postgres:placet@127.0.0.1:5432/oathrion_p12 npm test
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";

import {
  migratePhase12Database,
  PHASE12_IDENTITY_URL as IDENTITY_URL,
  runInstance,
} from "./helpers/phase12-instance";

const suite = IDENTITY_URL === "" ? describe.skip : describe;

if (IDENTITY_URL === "") {
  console.warn(
    "[phase12] SKIPPED — identité multi-processus non testée : OATHRION_TEST_IDENTITY_PG_URL n'est pas défini. " +
      "Ces tests ne sont PAS rejoués sur SQLite ; l'affirmation « identité partagée entre instances » reste NON TESTÉE.",
  );
}

suite("Phase 12 — identité PostgreSQL partagée entre processus", () => {
  const tag = randomBytes(4).toString("hex");
  const org = `org_p12_${tag}`;
  const email = `p12-${tag}@example.test`;
  const password = "correct-horse-battery-staple-12";

  beforeAll(() => {
    // Les migrations sont idempotentes et appliquées par un script dédié, jamais au
    // démarrage d'une instance : plusieurs répliques qui démarrent ensemble se
    // battraient sur le DDL.
    migratePhase12Database();
  }, 130_000);

  it("golden X/Z — le plan d'identité est PostgreSQL et une session valide authentifie", () => {
    const [plane, , login, resolved] = runInstance([
      { op: "plane" },
      { op: "seedUser", organization: org, email, password, role: "admin" },
      { op: "login", email, password, organization: org },
      { op: "plane" },
    ]);
    expect(plane.plane).toBe("postgres");
    expect(resolved.plane).toBe("postgres");
    expect(login.ok).toBe(true);
    expect(login.token).toBeTruthy();
  }, 120_000);

  it("golden X + AF — une session ouverte par l'instance A est reconnue par B, et sa révocation par C bloque D", () => {
    const opened = runInstance([
      { op: "seedUser", organization: org, email, password, role: "admin" },
      { op: "login", email, password, organization: org },
    ]);
    const token = String(opened[1].token);
    const sessionId = String(opened[1].sessionId);

    // B : autre processus, aucune mémoire partagée avec A.
    const [b] = runInstance([{ op: "resolve", credential: token }]);
    expect(b.authenticated).toBe(true);
    expect(b.organizationId).toBe(org);
    expect(b.sessionId).toBe(sessionId);

    // C : révoque.
    const [c] = runInstance([{ op: "revokeSession", sessionId, organization: org }]);
    expect(c.revoked).toBe(true);

    // D : encore un autre processus. Doit refuser — golden AF.
    const [d] = runInstance([{ op: "resolve", credential: token }]);
    expect(d.authenticated).toBe(false);
  }, 180_000);

  it("golden Z + AA + AG — une clé d'API créée par A authentifie chez B, et sa révocation par C bloque D", () => {
    const created = runInstance([{ op: "createApiKey", organization: org, role: "operator" }]);
    const secret = String(created[0].secret);
    const keyId = String(created[0].id);

    const [b] = runInstance([{ op: "resolve", credential: secret }]);
    expect(b.authenticated).toBe(true);
    expect(b.role).toBe("operator");
    expect(b.organizationId).toBe(org);

    const [c] = runInstance([{ op: "revokeApiKey", organization: org, id: keyId }]);
    expect(c.revoked).toBe(true);

    const [d] = runInstance([{ op: "resolve", credential: secret }]);
    expect(d.authenticated).toBe(false);
  }, 180_000);

  it("golden AB + AC + AH — un credential lié à un agent porte ce lien entre processus, et sa révocation le coupe partout", () => {
    const created = runInstance([
      { op: "createApiKey", organization: org, role: "operator", agentId: "agent_alpha" },
    ]);
    const secret = String(created[0].secret);
    const keyId = String(created[0].id);
    expect(created[0].agentId).toBe("agent_alpha");

    // AB : le lien credential↔agent est lu depuis la base par une autre instance, et
    // AD : il vaut exactement l'agent inscrit — il n'y a aucun chemin pour en changer.
    const [b] = runInstance([{ op: "resolve", credential: secret }]);
    expect(b.authenticated).toBe(true);
    expect(b.agentId).toBe("agent_alpha");
    expect(b.agentId).not.toBe("agent_beta");

    const [c] = runInstance([{ op: "revokeApiKey", organization: org, id: keyId }]);
    expect(c.revoked).toBe(true);

    // AC + AH : révoqué chez C, refusé chez D.
    const [d] = runInstance([{ op: "resolve", credential: secret }]);
    expect(d.authenticated).toBe(false);
  }, 180_000);

  it("golden AE — une clé d'un autre tenant n'est ni trouvée ni révocable depuis le tenant courant", () => {
    const rival = `${org}_rival`;
    const created = runInstance([
      { op: "createApiKey", organization: rival, role: "admin", name: "rival" },
    ]);
    const secret = String(created[0].secret);
    const keyId = String(created[0].id);

    // Le credential authentifie — dans SON tenant, et jamais dans l'autre.
    const [resolved] = runInstance([{ op: "resolve", credential: secret }]);
    expect(resolved.authenticated).toBe(true);
    expect(resolved.organizationId).toBe(rival);

    // Vu depuis `org`, la clé n'existe pas : la lecture est filtrée par tenant dans le SQL.
    const [foundFromOtherTenant] = runInstance([
      { op: "findApiKey", organization: org, id: keyId },
    ]);
    expect(foundFromOtherTenant.found).toBe(false);

    // Et la révocation cross-tenant ne fait rien plutôt que de réussir silencieusement.
    const [revoke] = runInstance([{ op: "revokeApiKey", organization: org, id: keyId }]);
    expect(revoke.revoked).toBe(false);

    // Le credential légitime fonctionne toujours : le refus visait le tenant, pas la clé.
    const [still] = runInstance([{ op: "resolve", credential: secret }]);
    expect(still.authenticated).toBe(true);
  }, 200_000);

  it("golden Y — un changement de mot de passe sur une instance invalide les sessions vues par les autres", () => {
    const tag2 = randomBytes(3).toString("hex");
    const email2 = `p12-pw-${tag2}@example.test`;
    const opened = runInstance([
      { op: "seedUser", organization: org, email: email2, password, role: "operator" },
      { op: "login", email: email2, password, organization: org },
    ]);
    const userId = String(opened[0].userId);
    const token = String(opened[1].token);

    const [before] = runInstance([{ op: "resolve", credential: token }]);
    expect(before.authenticated).toBe(true);

    const [changed] = runInstance([
      {
        op: "changePassword",
        userId,
        currentPassword: password,
        newPassword: "another-correct-horse-battery-13",
      },
    ]);
    expect((changed.outcome as { ok: boolean }).ok).toBe(true);

    // Autre processus : la session ouverte avant le changement ne doit plus passer.
    const [after] = runInstance([{ op: "resolve", credential: token }]);
    expect(after.authenticated).toBe(false);
  }, 200_000);

  it("l'organisation suspendue sur une instance est refusée par les autres (booléen PostgreSQL réel)", () => {
    const tag3 = randomBytes(3).toString("hex");
    const suspended = `org_p12_susp_${tag3}`;
    const created = runInstance([
      { op: "createApiKey", organization: suspended, role: "admin", name: "susp" },
    ]);
    const secret = String(created[0].secret);

    const [before] = runInstance([{ op: "resolve", credential: secret }]);
    expect(before.authenticated).toBe(true);

    const [set] = runInstance([
      { op: "setOrganizationActive", organization: suspended, active: false },
    ]);
    expect(set.isActive).toBe(false);

    const [after] = runInstance([{ op: "resolve", credential: secret }]);
    expect(after.authenticated).toBe(false);
  }, 200_000);

  it("golden AB/AC — un token d'identité émis par A est consommé une seule fois, même vu depuis un autre processus", () => {
    const tag4 = randomBytes(3).toString("hex");
    const issued = runInstance([
      {
        op: "createIdentityToken",
        organization: org,
        email: `invite-${tag4}@example.test`,
        role: "operator",
      },
    ]);
    const token = String(issued[0].token);
    const tokenId = String(issued[0].id);

    // B : le token existe et n'est pas consommé — la vérité vient de la base.
    const [seen] = runInstance([{ op: "resolveIdentityToken", token }]);
    expect(seen.found).toBe(true);
    expect(seen.consumedAt).toBeNull();
    expect(seen.organizationId).toBe(org);

    // C : consomme.
    const [first] = runInstance([{ op: "consumeIdentityToken", id: tokenId }]);
    expect(first.consumed).toBe(true);

    // D : rejeu depuis un troisième processus — refusé. Un `consume` en mémoire aurait
    // laissé passer ici, ce qui est exactement la faille que la Phase 12 ferme.
    const [replay] = runInstance([{ op: "consumeIdentityToken", id: tokenId }]);
    expect(replay.consumed).toBe(false);

    const [after] = runInstance([{ op: "resolveIdentityToken", token }]);
    expect(after.consumedAt).not.toBeNull();
  }, 200_000);

  /*
   * Phase 12.2, TEST J. Mutation testing found that replacing the raise below with an
   * empty result set left the whole suite green: nothing asserted that a failed
   * identity query RAISES rather than reporting "no rows".
   *
   * The distinction is the whole fail-closed property. "I could not reach the identity
   * database" and "that credential does not exist" are different answers, and only the
   * second one is safe to turn into a 401. A caller that reads an error as an empty
   * result cannot tell a revoked credential from an unreachable database.
   *
   * The end-to-end effect of that mutation was measured and was still a refusal, so
   * this closes a test-coverage gap rather than a live hole — which is exactly why it
   * needs a test: the next refactor has nothing else stopping it.
   */
  it("une requête d'identité en échec lève, au lieu de rapporter zéro ligne", async () => {
    const { createSyncPostgresDatabase, IdentityDatabaseError } = await import(
      "../identity/sync-postgres"
    );
    const db = createSyncPostgresDatabase(IDENTITY_URL);
    try {
      const statement = db.prepare("SELECT 1 FROM table_that_does_not_exist_p122");
      expect(() => statement.get()).toThrow(IdentityDatabaseError);
    } finally {
      db.close();
    }
  }, 60_000);
});
