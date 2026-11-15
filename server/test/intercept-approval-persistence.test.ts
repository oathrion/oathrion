/**
 * UNE APPROBATION RENDUE PLUS TARD DOIT ENCORE TROUVER SA REQUÊTE.
 *
 * ## Le défaut que ce fichier existe pour empêcher de revenir
 *
 * Le pare-feu garait la requête interceptée dans une `Map` du processus, TTL **soixante
 * secondes**. Mesuré sur le code livré : *« après 61 s, la requête est : PERDUE »*. Un
 * opérateur qui approuvait après une minute voyait son approbation réussir et rien partir.
 *
 * Et le test qui couvrait ce chemin approuvait dans la milliseconde. Il passait. C'est
 * précisément le genre de test qui donne une fausse assurance : il exerçait la
 * fonctionnalité dans la seule condition où le défaut ne se voit pas.
 *
 * Celui-ci approuve **après** l'ancienne fenêtre, et avec une horloge avancée au-delà,
 * contre une vraie base.
 *
 * ## Ce qui est réel ici
 *
 * Une base SQLite jetable, montée par la MIGRATION elle-même — pas par un `CREATE TABLE`
 * recopié, qui divergerait sans que rien ne le dise. Un vrai chiffrement d'enveloppe avec
 * une clé fraîche. Un vrai registre de destinations.
 */

import { randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import { resetVaultKeyring } from "../connectors/vault";
import { approvalWindowMs, PendingInterceptionStore } from "../intercept/pending-store";
import { resetPending, type PendingForward } from "../intercept/forward";
import { resolveDownstreamDestination } from "../gateway/tools/mcp-destination";
import { pendingInterceptions } from "../migrations/022-pending-interceptions";
import { pendingSuccessField } from "../migrations/024-pending-success-field";
import { sqliteExecutor, type SqlExecutor } from "../sql/executor";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrganizationId;

/*
 * LA VALEUR D'UN EN-TÊTE QUI NE DOIT JAMAIS APPARAÎTRE EN CLAIR — longue, et c'est une
 * correction.
 *
 * Elle valait "abc". Le test cherche cette valeur dans un vidage de la table, et la table
 * contient des enveloppes chiffrées en base64 : du texte ALÉATOIRE, qui contient « abc »
 * de temps en temps par pur hasard. Le test échouait alors sans qu'aucune fuite n'existe —
 * observé une fois, impossible à reproduire en quarante passages. Une sentinelle trop
 * courte ne prouve rien dans un sens et accuse à tort dans l'autre ; celle-ci ne peut pas
 * naître d'un chiffré.
 */
const IDEMPOTENCY_SENTINEL = "idem-SentinelleEnClair-7f3a9c";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrganizationId;

/** Loopback sur un port fermé : la destination doit RÉSOUDRE, jamais être joints. */
const FIXTURE_URL = "http://127.0.0.1:9/";

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    OATHRION_KEK: randomBytes(32).toString("base64"),
    OATHRION_LOCAL_MCP_URL: FIXTURE_URL,
    OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
    ...extra,
  } as NodeJS.ProcessEnv;
}

let database: Database.Database;
let sql: SqlExecutor;
let environment: NodeJS.ProcessEnv;

function forwardFor(body: Record<string, unknown>): PendingForward {
  const destination = resolveDownstreamDestination({
    OATHRION_LOCAL_MCP_URL: FIXTURE_URL,
  } as NodeJS.ProcessEnv);
  expect(destination).not.toBeNull();
  return {
    destination: destination!,
    destinationId: "local-fixture",
    request: {
      method: "POST",
      path: "/v1/refunds",
      query: { expand: "charge" },
      headers: { "content-type": "application/json", "x-idempotency": IDEMPOTENCY_SENTINEL },
      body,
    },
    credentialHeader: "authorization",
    credentialTemplate: "Bearer {secret}",
    forwardHeaders: ["content-type", "x-idempotency"],
  };
}

beforeEach(() => {
  resetVaultKeyring();
  resetPending();
  database = new Database(":memory:");
  /*
   * La table vient des MIGRATIONS, pas d'une copie qui divergerait en silence — et de
   * TOUTES celles qui la touchent : la 22 la crée, la 24 lui ajoute `success_field`.
   * N'appliquer que la première a fait échouer ce fichier dès que la seconde a existé,
   * ce qui est exactement ce qu'une copie aurait caché.
   */
  for (const statement of pendingInterceptions.statements({
    dialect: "sqlite",
    tableExists: () => false,
    columns: () => new Set<string>(),
  })) {
    database.exec(statement);
  }
  for (const statement of pendingSuccessField.statements({
    dialect: "sqlite",
    tableExists: () => true,
    columns: () => new Set<string>(),
  })) {
    database.exec(statement);
  }
  sql = sqliteExecutor(database);
  environment = env();
});

afterEach(() => {
  database.close();
  resetVaultKeyring();
});

describe("la fenêtre laissée à un humain", () => {
  it("est celle du TTL d'approbation, pas soixante secondes", () => {
    /*
     * LE CHIFFRE QUI ÉTAIT LE DÉFAUT. Soixante secondes pour qu'un humain décide, c'est
     * zéro seconde en pratique. La fenêtre suit maintenant
     * `OATHRION_ACTION_APPROVAL_TTL_MS` — 15 minutes par défaut — parce que deux horloges
     * pour le même geste produisent soit une approbation valide dont la requête a
     * disparu, soit une requête gardée pour une approbation périmée.
     */
    expect(approvalWindowMs({} as NodeJS.ProcessEnv)).toBe(900_000);
    expect(approvalWindowMs({ OATHRION_ACTION_APPROVAL_TTL_MS: "600000" } as NodeJS.ProcessEnv)).toBe(600_000);
    /* Une valeur illisible retombe sur le défaut plutôt que sur zéro. */
    expect(approvalWindowMs({ OATHRION_ACTION_APPROVAL_TTL_MS: "bientôt" } as NodeJS.ProcessEnv)).toBe(900_000);
  });

  it("une requête garée est retrouvée APRÈS l'ancienne fenêtre de 60 s", async () => {
    /* Le test qui manquait. L'ancien code rendait `null` ici. */
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    const deposited = new Date("2026-03-01T10:00:00.000Z");
    await store.put({ ref: "ref-lent", executionId: "exe_1", forward: forwardFor({ amount: 4200 }), now: deposited });

    const fiveMinutesLater = new Date(deposited.getTime() + 5 * 60_000);
    const taken = await store.take("ref-lent", fiveMinutesLater);

    expect(taken).not.toBeNull();
    expect(taken?.request.body).toEqual({ amount: 4200 });
    expect(taken?.request.method).toBe("POST");
    expect(taken?.request.path).toBe("/v1/refunds");
    /* Les en-têtes et la chaîne de requête traversent intacts. */
    expect(taken?.request.headers["x-idempotency"]).toBe(IDEMPOTENCY_SENTINEL);
    expect(taken?.request.query).toEqual({ expand: "charge" });
    expect(taken?.credentialHeader).toBe("authorization");
  });

  it("au-delà de la fenêtre, elle n'est plus rendue", async () => {
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    const deposited = new Date("2026-03-01T10:00:00.000Z");
    await store.put({ ref: "ref-perime", executionId: "exe_2", forward: forwardFor({ amount: 1 }), now: deposited });

    const tooLate = new Date(deposited.getTime() + approvalWindowMs(environment) + 1_000);
    expect(await store.take("ref-perime", tooLate)).toBeNull();
  });

  it("… même si aucun balayage n'a eu lieu", async () => {
    /*
     * `expires_at > ?` est répété dans la SUPPRESSION, donc une ligne périmée est
     * inatteignable sans dépendre d'une tâche de fond. Sur plusieurs instances, une
     * tâche de fond serait une tâche à coordonner.
     */
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    const deposited = new Date("2026-03-01T10:00:00.000Z");
    await store.put({ ref: "ref-x", executionId: "e", forward: forwardFor({ a: 1 }), now: deposited });
    const tooLate = new Date(deposited.getTime() + approvalWindowMs(environment) + 1);

    expect(await store.count()).toBe(1);
    expect(await store.take("ref-x", tooLate)).toBeNull();
    /* La ligne est encore là, et pourtant inatteignable. */
    expect(await store.count()).toBe(1);
    expect(await store.purgeExpired(tooLate)).toBe(1);
    expect(await store.count()).toBe(0);
  });
});

describe("usage unique, y compris sous concurrence", () => {
  it("une seconde reprise ne rend rien", async () => {
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    await store.put({ ref: "ref-une-fois", executionId: "e", forward: forwardFor({ a: 1 }) });

    expect(await store.take("ref-une-fois")).not.toBeNull();
    expect(await store.take("ref-une-fois")).toBeNull();
  });

  it("deux approbations simultanées : une seule repart avec la requête", async () => {
    /*
     * LA SECONDE SERRURE SUR LA MÊME PORTE. Le grant à usage unique de la passerelle
     * ferme déjà cette porte ; celle-ci la ferme à nouveau, et c'est la SUPPRESSION
     * conditionnelle qui décide — pas le `SELECT` qui la précède, lequel peut très bien
     * voir la même ligne deux fois.
     */
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    await store.put({ ref: "ref-course", executionId: "e", forward: forwardFor({ a: 1 }) });

    const [first, second] = await Promise.all([store.take("ref-course"), store.take("ref-course")]);
    const winners = [first, second].filter((value) => value !== null);
    expect(winners).toHaveLength(1);
  });
});

describe("le contenu est chiffré, et lié au locataire", () => {
  it("le champ de réussite voyage avec la requête garée", async () => {
    /*
     * Un message Slack approuvé par un humain des minutes plus tard, puis refusé par
     * Slack : sans ce champ conservé, il redevenait « envoyé » dans le reçu — le défaut
     * corrigé, sur la voie précise où un humain a pris la peine de regarder.
     */
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    await store.put({ ref: "ref-slack", executionId: "e", forward: { ...forwardFor({ x: 1 }), successField: "ok" } });
    await store.put({ ref: "ref-sans", executionId: "e", forward: forwardFor({ x: 1 }) });
    expect((await store.take("ref-slack"))?.successField).toBe("ok");
    /* Et une règle qui ne déclarait rien reste jugée sur le statut HTTP. */
    expect((await store.take("ref-sans"))?.successField).toBeUndefined();
  });

  it("ni le corps ni les en-têtes ne sont lisibles dans la base", async () => {
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    await store.put({
      ref: "ref-secret",
      executionId: "e",
      forward: forwardFor({ customer_email: "client@exemple.test", card_last4: "4242" }),
    });

    const dump = JSON.stringify(database.prepare("SELECT * FROM pending_interceptions").all());
    expect(dump).not.toContain("client@exemple.test");
    expect(dump).not.toContain("4242");
    /* L'en-tête d'idempotence non plus : un en-tête peut porter un jeton. */
    expect(dump).not.toContain(IDEMPOTENCY_SENTINEL);
    /* En clair, ce qu'un index doit pouvoir lire et qui n'est pas un secret. */
    expect(dump).toContain("/v1/refunds");
    expect(dump).toContain("local-fixture");
  });

  it("une ligne déplacée chez un autre locataire ne déchiffre pas", async () => {
    /*
     * La défense qui reste debout quand le filtre `organization_id` d'une requête est
     * oublié : le locataire est DANS le contexte authentifié par AES-GCM.
     */
    const storeA = new PendingInterceptionStore(sql, ORG_A, environment);
    await storeA.put({ ref: "ref-vol", executionId: "e", forward: forwardFor({ a: 1 }) });

    const row = database
      .prepare("SELECT * FROM pending_interceptions WHERE organization_id = ?")
      .get(ORG_A) as Record<string, unknown>;
    database
      .prepare(
        `INSERT INTO pending_interceptions
           (organization_id, ref, execution_id, destination_id, method, path, query,
            headers_envelope, body_envelope, credential_header, credential_template,
            created_at, expires_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ORG_B,
        "ref-vol",
        row.destination_id,
        row.method,
        row.path,
        row.query,
        row.headers_envelope,
        row.body_envelope,
        row.credential_header,
        row.credential_template,
        row.created_at,
        row.expires_at,
      );

    const storeB = new PendingInterceptionStore(sql, ORG_B, environment);
    await expect(storeB.take("ref-vol")).rejects.toThrow();
  });

  it("un locataire ne voit pas les requêtes garées d'un autre", async () => {
    const storeA = new PendingInterceptionStore(sql, ORG_A, environment);
    const storeB = new PendingInterceptionStore(sql, ORG_B, environment);
    await storeA.put({ ref: "ref-a", executionId: "e", forward: forwardFor({ a: 1 }) });

    expect(await storeB.take("ref-a")).toBeNull();
    expect(await storeB.count()).toBe(0);
    /* Et la requête de A est intacte : la tentative de B ne l'a pas consommée. */
    expect(await storeA.count()).toBe(1);
  });

  it("sans clé de chiffrement, garer une requête ÉCHOUE au lieu d'écrire en clair", async () => {
    /*
     * La route traduit cet échec en 503 plutôt qu'en 202 : annoncer une approbation en
     * attente pour une requête qu'on n'a pas gardée serait la promesse la plus coûteuse
     * de ce chemin.
     */
    const store = new PendingInterceptionStore(sql, ORG_A, { OATHRION_LOCAL_MCP_URL: FIXTURE_URL } as NodeJS.ProcessEnv);
    await expect(
      store.put({ ref: "ref-sans-cle", executionId: "e", forward: forwardFor({ a: 1 }) }),
    ).rejects.toThrow(/OATHRION_KEK/);
    expect(await store.count()).toBe(0);
  });
});

describe("la destination est re-résolue, jamais crue", () => {
  it("une destination retirée du registre entre-temps ne relaie rien", async () => {
    /*
     * Entre le dépôt et l'approbation, l'exploitant peut avoir retiré la destination ou
     * l'avoir sortie de la portée de ce locataire. Faire confiance à ce qui a été écrit
     * ferait partir une requête vers une destination qui n'est plus permise — c'est la
     * faille de liaison de destination que le plan d'autorité refuse déjà ailleurs.
     */
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    await store.put({ ref: "ref-dest", executionId: "e", forward: forwardFor({ a: 1 }) });

    /* Le même magasin, mais un environnement où la destination n'existe plus. */
    const after = new PendingInterceptionStore(sql, ORG_A, {
      OATHRION_KEK: environment.OATHRION_KEK,
    } as NodeJS.ProcessEnv);
    expect(await after.take("ref-dest")).toBeNull();
  });

  it("une destination sortie de la portée du locataire non plus", async () => {
    const store = new PendingInterceptionStore(sql, ORG_A, environment);
    await store.put({ ref: "ref-portee", executionId: "e", forward: forwardFor({ a: 1 }) });

    const scoped = new PendingInterceptionStore(sql, ORG_A, {
      OATHRION_KEK: environment.OATHRION_KEK,
      OATHRION_LOCAL_MCP_URL: FIXTURE_URL,
      /* La fixture n'est plus partagée : elle appartient à une autre organisation. */
      OATHRION_LOCAL_MCP_ORGANIZATIONS: ORG_B,
    } as NodeJS.ProcessEnv);
    expect(await scoped.take("ref-portee")).toBeNull();
  });
});
