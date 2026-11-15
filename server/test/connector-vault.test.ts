/**
 * LE COFFRE DE CREDENTIALS — ce qu'il protège, et ce qu'il ne rend jamais.
 *
 * Ces tests ne joignent AUCUN service. Ils portent sur le stockage, le chiffrement et la
 * clôture du secret. La preuve qu'un connecteur atteint vraiment GitHub est
 * `npm run verify:github`, qui demande un jeton réel et le dit quand il n'en a pas.
 * La séparation est l'exigence : un test qui n'a pas d'accès réseau ne doit jamais
 * pouvoir laisser croire qu'une intégration fonctionne.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import { ConnectorVault, fingerprintOf, resetVaultKeyring, sealingContext, VaultUnavailableError } from "../connectors/vault";
import { connectorCredentials, CONNECTOR_CREDENTIALS_TABLE } from "../migrations/021-connector-credentials";
import { sqliteExecutor, type SqlExecutor } from "../sql/executor";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrganizationId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrganizationId;
const TOKEN = "github_pat_11ABCDEF0exampletokenvalue_not_real";

/** Un environnement avec une clé, et un sans : les deux sont des cas à tenir. */
const WITH_KEK = { OATHRION_KEK: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
const WITHOUT_KEK = {} as NodeJS.ProcessEnv;

let database: Database.Database;
let sql: SqlExecutor;

beforeEach(() => {
  resetVaultKeyring();
  database = new Database(":memory:");
  /*
   * La table est créée par la MIGRATION elle-même, pas par un `CREATE TABLE` recopié
   * dans ce fichier. Une copie divergerait de la migration sans que rien ne le dise, et
   * les tests passeraient contre un schéma que la production n'a pas.
   */
  for (const statement of connectorCredentials.statements({
    dialect: "sqlite",
    tableExists: () => false,
    columns: () => new Set<string>(),
  })) {
    database.exec(statement);
  }
  sql = sqliteExecutor(database);
});

afterEach(() => {
  database.close();
  resetVaultKeyring();
});

describe("le scellement", () => {
  it("refuse de stocker un credential sans clé de chiffrement", async () => {
    /*
     * LE REFUS LE PLUS IMPORTANT DU FICHIER. L'alternative serait de stocker en clair
     * « en attendant » que l'exploitant configure une clé — c'est-à-dire exactement la
     * fuite que le chiffrement existe pour empêcher, avec en plus la certitude que
     * personne ne reviendrait la corriger.
     */
    const vault = new ConnectorVault(sql, ORG_A, WITHOUT_KEK);
    await expect(
      vault.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: [], connectedBy: "op", verified: true }),
    ).rejects.toThrow(VaultUnavailableError);
    await expect(
      vault.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: [], connectedBy: "op", verified: true }),
    ).rejects.toThrow(/OATHRION_KEK/);
  });

  it("n'écrit rien quand il refuse", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITHOUT_KEK);
    await vault
      .store({ connectorId: "github", secret: TOKEN, account: "a", scopes: [], connectedBy: "op", verified: true })
      .catch(() => undefined);
    expect(await vault.describeAll()).toEqual([]);
  });

  it("le jeton n'est nulle part en clair dans la base", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({
      connectorId: "github",
      secret: TOKEN,
      account: "octocat",
      scopes: ["repo"],
      connectedBy: "op",
      verified: true,
    });

    /*
     * La table entière est relue et sérialisée, puis on cherche le jeton dedans. Vérifier
     * seulement que `secret_envelope` est différent du jeton laisserait passer une
     * seconde colonne où il aurait été recopié — un `status_detail` qui cite le
     * credential, par exemple, ce qui est un défaut très ordinaire.
     */
    const rows = database.prepare(`SELECT * FROM ${CONNECTOR_CREDENTIALS_TABLE}`).all();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(TOKEN.slice(0, 20));
  });

  it("le rend à qui possède la clé, et à personne d'autre", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({ connectorId: "github", secret: TOKEN, account: "octocat", scopes: [], connectedBy: "op", verified: true });
    const opened = await vault.open("github");
    expect(opened?.secretEnvelope).toBe(TOKEN);
  });

  it("une enveloppe copiée dans un autre locataire ne déchiffre pas", async () => {
    /*
     * LA DÉFENSE QUI RESTE DEBOUT QUAND LE FILTRE `organization_id` EST OUBLIÉ.
     *
     * Le contexte de scellement contient l'organisation et il est authentifié par
     * AES-GCM. Déplacer la ligne ne suffit donc pas : il faudrait la clé ET le bon
     * contexte. C'est l'exemple que `envelope.ts` donne lui-même dans son message
     * d'erreur, et c'est la seule protection qui ne dépend pas d'un `WHERE` correct.
     */
    const vaultA = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vaultA.store({ connectorId: "github", secret: TOKEN, account: "octocat", scopes: [], connectedBy: "op", verified: true });

    const stolen = database
      .prepare(`SELECT secret_envelope FROM ${CONNECTOR_CREDENTIALS_TABLE} WHERE organization_id = ?`)
      .get(ORG_A) as { secret_envelope: string };
    database
      .prepare(
        `INSERT INTO ${CONNECTOR_CREDENTIALS_TABLE}
           (organization_id, connector_id, account, scopes, secret_envelope, fingerprint,
            status, status_detail, connected_by, connected_at)
         VALUES (?, 'github', '', '[]', ?, '', 'connected', '', 'voleur', ?)`,
      )
      .run(ORG_B, stolen.secret_envelope, new Date().toISOString());

    const vaultB = new ConnectorVault(sql, ORG_B, WITH_KEK);
    await expect(vaultB.open("github")).rejects.toThrow();
  });

  it("l'empreinte reconnaît le jeton sans en livrer un fragment", () => {
    const print = fingerprintOf(TOKEN);
    expect(print).toHaveLength(6);
    expect(print).toMatch(/^[0-9a-f]{6}$/);
    /* Pas un morceau du secret : c'est tout l'intérêt par rapport aux « 4 derniers caractères ». */
    expect(TOKEN).not.toContain(print);
    expect(fingerprintOf(TOKEN)).toBe(print);
    expect(fingerprintOf(`${TOKEN}x`)).not.toBe(print);
  });

  it("refuse un identifiant de connecteur qui casserait le contexte", () => {
    /* `envelope.ts` refuse un contexte contenant « . » : il faut donc le refuser ici,
     * nommément, plutôt que de produire une enveloppe au contexte tronqué. */
    expect(() => sealingContext(ORG_A, "git.hub")).toThrow(VaultUnavailableError);
    expect(() => sealingContext(ORG_A, "git:hub")).toThrow(VaultUnavailableError);
    expect(() => sealingContext(ORG_A, " ")).toThrow(VaultUnavailableError);
    expect(sealingContext(ORG_A, "github")).toBe(`connector:${ORG_A}:github`);
  });
});

describe("l'isolation entre locataires", () => {
  it("un locataire ne voit pas le connecteur d'un autre", async () => {
    const vaultA = new ConnectorVault(sql, ORG_A, WITH_KEK);
    const vaultB = new ConnectorVault(sql, ORG_B, WITH_KEK);
    await vaultA.store({ connectorId: "github", secret: TOKEN, account: "octocat", scopes: [], connectedBy: "op", verified: true });

    expect((await vaultA.describeAll()).map((s) => s.connectorId)).toEqual(["github"]);
    expect(await vaultB.describeAll()).toEqual([]);
    expect(await vaultB.describe("github")).toBeNull();
    expect(await vaultB.open("github")).toBeNull();
  });

  it("révoquer chez l'un ne touche pas l'autre", async () => {
    const vaultA = new ConnectorVault(sql, ORG_A, WITH_KEK);
    const vaultB = new ConnectorVault(sql, ORG_B, WITH_KEK);
    await vaultA.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: [], connectedBy: "op", verified: true });
    await vaultB.store({ connectorId: "github", secret: `${TOKEN}_b`, account: "b", scopes: [], connectedBy: "op", verified: true });

    expect(await vaultB.revoke("github", "op")).toBe(true);
    expect((await vaultA.describe("github"))?.state).toBe("connected");
    expect((await vaultB.describe("github"))?.state).toBe("revoked");
    expect((await vaultA.open("github"))?.secretEnvelope).toBe(TOKEN);
  });
});

describe("la révocation", () => {
  it("écrase l'enveloppe, pas seulement l'état", async () => {
    /*
     * Un drapeau `revoked` qui laisserait l'enveloppe en place serait un credential
     * encore présent dans un dump, protégé par rien d'autre qu'une colonne de statut
     * qu'une requête oubliée ignorerait.
     */
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: ["repo"], connectedBy: "op", verified: true });
    await vault.revoke("github", "operateur");

    const row = database
      .prepare(`SELECT secret_envelope, scopes FROM ${CONNECTOR_CREDENTIALS_TABLE} WHERE organization_id = ?`)
      .get(ORG_A) as { secret_envelope: string; scopes: string };
    expect(row.secret_envelope).toBe("");
    expect(row.scopes).toBe("[]");
    expect(await vault.open("github")).toBeNull();
  });

  it("dit que le jeton reste valide chez le fournisseur", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: [], connectedBy: "op", verified: true });
    await vault.revoke("github", "operateur");
    const status = await vault.describe("github");
    expect(status?.detail).toMatch(/still considers it valid/i);
    expect(status?.detail).toContain("operateur");
  });

  it("garde la ligne, pour distinguer « révoqué » de « jamais configuré »", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: [], connectedBy: "op", verified: true });
    await vault.revoke("github", "op");
    /* La différence importe à l'exploitant qui cherche pourquoi un agent a cessé d'agir. */
    expect((await vault.describe("github"))?.state).toBe("revoked");
  });

  it("révoquer ce qui n'existe pas ne prétend pas avoir agi", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    expect(await vault.revoke("github", "op")).toBe(false);
  });
});

describe("le test de connexion", () => {
  it("un échec met en erreur et NE révoque PAS", async () => {
    /*
     * Une coupure réseau n'est pas une révocation. Les confondre ferait disparaître un
     * credential encore valide, et l'exploitant devrait recréer un jeton qui n'avait rien.
     */
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({ connectorId: "github", secret: TOKEN, account: "a", scopes: ["repo"], connectedBy: "op", verified: true });
    const after = await vault.recordCheck("github", { ok: false, detail: "API injoignable" });
    expect(after?.state).toBe("error");
    expect(after?.detail).toBe("API injoignable");
    /* Le jeton est toujours là : un test qui échoue ne jette pas le credential. */
    expect((await vault.open("github"))?.secretEnvelope).toBe(TOKEN);
  });

  it("un succès remet en « connecté » et met à jour ce que le service a dit", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    await vault.store({ connectorId: "github", secret: TOKEN, account: "ancien", scopes: [], connectedBy: "op", verified: true });
    await vault.recordCheck("github", { ok: false, detail: "panne" });
    const after = await vault.recordCheck("github", {
      ok: true,
      detail: "Connecté en tant que octocat.",
      account: "octocat",
      scopes: ["repo", "read:org"],
    });
    expect(after?.state).toBe("connected");
    expect(after?.account).toBe("octocat");
    expect(after?.scopes).toEqual(["repo", "read:org"]);
  });

  it("tester un connecteur absent ne crée pas de ligne", async () => {
    const vault = new ConnectorVault(sql, ORG_A, WITH_KEK);
    expect(await vault.recordCheck("github", { ok: true, detail: "ok" })).toBeNull();
    expect(await vault.describeAll()).toEqual([]);
  });
});

describe("la clôture du secret, lue dans les sources", () => {
  /*
   * Les trois assertions ci-dessous sont textuelles, et c'est délibéré : un test
   * fonctionnel ne peut pas prouver qu'AUCUNE route ne rendra jamais le jeton. Il
   * prouverait seulement que celles qu'il connaît ne le font pas.
   */
  const routes = readFileSync(join(ROOT, "server", "routes-connectors.ts"), "utf8");

  it("aucune route de connecteur ne lit l'enveloppe", () => {
    expect(routes).not.toContain("secret_envelope");
    expect(routes).not.toContain("secretEnvelope");
    /* `open()` est le seul déchiffrement, et il n'appartient pas aux routes. */
    expect(routes).not.toMatch(/vault\.open\(/);
  });

  it("un seul gestionnaire de route manipule un secret", () => {
    /*
     * Le fichier est découpé par enregistrement de route, et l'on compte les segments
     * qui parlent d'un secret — pas les occurrences du mot. Compter les occurrences a
     * d'abord donné deux (le schéma zod et le passage au coffre) pour UNE seule route :
     * la mesure ne portait pas sur la propriété voulue, qui est « combien de routes »,
     * et pas « combien de fois ».
     */
    const segments = routes.split(/\n {2}app\.(?=get|post|delete|put|patch)/).slice(1);
    expect(segments.length).toBeGreaterThanOrEqual(5);

    /*
     * LES COMMENTAIRES SONT RETIRÉS AVANT DE COMPTER, et c'est le second affinage de ce
     * garde-fou.
     *
     * La version d'avant comptait les occurrences du mot et donnait deux pour une seule
     * route. Celle-ci comptait les segments, et a donné trois pour deux routes : une
     * route voisine portait un commentaire disant « aucun secret n'est rendu ici » —
     * c'est-à-dire que la PROSE qui affirme l'absence d'un secret déclenchait le garde-fou
     * censé détecter sa présence.
     *
     * La propriété porte sur le CODE. Un commentaire ne doit ni la déclencher, ni la
     * satisfaire : les deux seraient une mesure qu'on peut écrire à côté du code au lieu
     * de la prouver dedans.
     */
    const code = (segment: string) =>
      segment.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const touchingSecret = segments.map(code).filter((segment) => /\bsecret\b/.test(segment));

    /*
     * TROIS routes reçoivent un secret, et chacune doit MÉRITER son entrée dans cette
     * liste. Monter le compte sans rien exiger de la nouvelle aurait transformé ce
     * garde-fou en compteur. La troisième est le retour OAuth (Slack, Linear) : ses
     * exigences sont le point 3 ci-dessous.
     */
    expect(touchingSecret).toHaveLength(4);
    expect(touchingSecret.filter((s) => s.includes('"/api/connectors/:id/connect"'))).toHaveLength(1);
    expect(touchingSecret.filter((s) => s.includes("/destinations/:id/credential"))).toHaveLength(1);
    expect(touchingSecret.filter((s) => s.includes("CONNECTOR_OAUTH_CALLBACK_PATH"))).toHaveLength(1);
    expect(touchingSecret.filter((s) => s.includes('"/api/connectors/:id/check-credential"'))).toHaveLength(1);

    /*
     * 4. « L'ancienne clé de mon agent est-elle morte ? » — la quatrième, ajoutée avec
     * l'écran « Ajouter un agent existant ». Elle reçoit une clé qui N'EST PAS celle de
     * Oathrion, et son entrée se mérite par ce qu'elle ne fait pas : elle ne scelle rien,
     * ne déchiffre rien (la comparaison avec la clé du coffre passe par l'empreinte),
     * et ne fait que poser la question au service.
     */
    const check = touchingSecret.find((s) => s.includes('"/api/connectors/:id/check-credential"'))!;
    expect(check).toContain("connector.credentialAlive(");
    expect(check).toContain("fingerprintOf(presented)");
    expect(check).not.toContain("vault.store(");
    expect(check).not.toMatch(/vault\.open\(/);
    expect(check).not.toContain("connector.verify(");

    /*
     * 3. Le retour OAuth. Publique par nécessité, elle doit, DANS CET ORDRE : consommer la
     * tentative (`takeInstall`), exiger le cookie du navigateur, échanger le code, VÉRIFIER
     * le jeton contre le service, puis seulement sceller. Et l'organisation vient de la
     * tentative, jamais de la requête.
     */
    const callback = touchingSecret.find((s) => s.includes("CONNECTOR_OAUTH_CALLBACK_PATH"))!;
    const at = (needle: string) => callback.indexOf(needle);
    expect(at("takeInstall(")).toBeGreaterThan(-1);
    expect(at("cookie !== state")).toBeGreaterThan(at("takeInstall("));
    expect(at("exchangeCode(")).toBeGreaterThan(at("cookie !== state"));
    expect(at("connector.verify(")).toBeGreaterThan(at("exchangeCode("));
    expect(at("vault.store(")).toBeGreaterThan(at("connector.verify("));
    expect(callback).toContain("planForOrganization(attempt.organizationId)");
    expect(callback).not.toMatch(/req\.(body|query)\.organization/);

    /* 1. Le connecteur du catalogue vérifie AVANT de sceller : l'ordre est la propriété. */
    const connect = touchingSecret.find((s) => s.includes('"/api/connectors/:id/connect"'))!;
    expect(connect.indexOf("connector.verify(")).toBeGreaterThan(-1);
    expect(connect.indexOf("vault.store(")).toBeGreaterThan(connect.indexOf("connector.verify("));

    /*
     * 2. La destination du pare-feu n'a AUCUNE sonde — Oathrion ne connaît pas la méthode
     * de validation d'une API quelconque — donc elle doit sceller en `verified: false`.
     * C'est ce qui l'empêche d'écrire l'état « connecté » sur une clé que personne n'a
     * essayée, c'est-à-dire le faux statut « protégé » que ce dépôt refuse.
     */
    const destination = touchingSecret.find((s) => s.includes("/destinations/:id/credential"))!;
    expect(destination).toContain("verified: false");
    expect(destination).not.toContain(".verify(");

    /*
     * Et elle résout la destination AVANT de sceller : la portée par locataire précède
     * l'écriture, sinon cette route serait un magasin de secrets à clé arbitraire.
     */
    expect(destination.indexOf("resolveDestination(")).toBeGreaterThan(-1);
    expect(destination.indexOf("vault.store(")).toBeGreaterThan(destination.indexOf("resolveDestination("));
  });

  it("le coffre expose deux types, et un seul porte l'enveloppe", () => {
    const vault = readFileSync(join(ROOT, "server", "connectors", "vault.ts"), "utf8");
    /* `ConnectorStatus` est le type des routes : il ne doit pas avoir de champ secret. */
    const statusBlock = vault.slice(
      vault.indexOf("export interface ConnectorStatus"),
      vault.indexOf("/** Interne au module"),
    );
    expect(statusBlock).not.toContain("secretEnvelope");
    expect(statusBlock).toContain("fingerprint");
    /* `StoredCredential` le porte, et il n'est PAS exporté. */
    expect(vault).toContain("interface StoredCredential");
    expect(vault).not.toContain("export interface StoredCredential");
  });
});

describe("les instants rendus par le coffre", () => {
  it("sont du texte ISO même quand la base rend un objet Date (PostgreSQL, TIMESTAMPTZ)", async () => {
    /*
     * Relevé contre le vrai GitHub (STRESS-TEST-LOG §5.19) : sous PostgreSQL, `connectedAt`
     * arrivait en `Date`, et la réconciliation l'envoyait à GitHub comme « Sun Oct 25 2026… ».
     * Ici, une base qui répond comme `pg` : des objets Date.
     */
    const at = new Date("2026-10-25T15:46:11.678Z");
    const row = {
      connector_id: "github",
      account: "kryxor",
      scopes: "[]",
      secret_envelope: "x",
      fingerprint: "abcdef",
      status: "connected",
      status_detail: "",
      connected_by: "admin",
      connected_at: at,
      last_checked_at: at,
    };
    const pgLike = { all: () => Promise.resolve([row]), get: () => Promise.resolve(row), run: () => Promise.resolve({ changes: 1 }), transaction: () => Promise.reject(new Error("non utilisé")) } as unknown as SqlExecutor;
    const status = await new ConnectorVault(pgLike, "org_test" as OrganizationId).describe("github");
    expect(status?.connectedAt).toBe("2026-10-25T15:46:11.678Z");
    expect(status?.lastCheckedAt).toBe("2026-10-25T15:46:11.678Z");
    expect(typeof status?.connectedAt).toBe("string");
  });
});
