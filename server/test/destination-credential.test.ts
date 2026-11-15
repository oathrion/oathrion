/**
 * LE CREDENTIAL D'UNE DESTINATION, PAR LOCATAIRE.
 *
 * ## Le défaut que ces routes ferment
 *
 * Le relais cherchait le credential du fournisseur dans le coffre, puis retombait sur
 * `OATHRION_INTERCEPT_KEY_<DESTINATION>` — une variable d'environnement qui vaut pour TOUT
 * le déploiement. Et le coffre n'acceptait qu'un connecteur du catalogue, lequel ne
 * contient qu'une entrée : `github`.
 *
 * Donc, pour toute autre destination — Stripe, Jira, une API interne — **aucun locataire
 * ne pouvait avoir sa propre clé**. Deux organisations clientes derrière un même Oathrion
 * partageaient la clé Stripe du déploiement, et rien dans le produit ne le disait.
 *
 * Ce n'est pas gênant pour un déploiement par client, qui est la forme livrée. Ça devient
 * bloquant à la deuxième organisation, et c'est le genre de chose qu'on découvre après
 * avoir signé.
 *
 * ## Les deux propriétés que ce fichier tient
 *
 *  1. **L'ISOLATION** — la clé scellée par un locataire n'existe pas pour l'autre, et
 *     c'est vérifié depuis les deux côtés plutôt que déduit du code.
 *  2. **L'HONNÊTETÉ DU STATUT** — aucune sonde n'existe pour une API quelconque, donc
 *     l'état est `stored_unverified` et jamais `connected`. Une pastille verte sur une
 *     clé que personne n'a essayée est exactement le faux statut « protégé » que ce dépôt
 *     refuse.
 *
 * Et une troisième, sur la révocation : révoquer la clé d'un locataire ne coupe PAS
 * l'injection si la variable du déploiement existe — elle y retombe. La réponse doit le
 * dire, sinon un exploitant croit avoir coupé quelque chose.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const DEST = "local-fixture";
const ENV_KEY = "OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE";
const SECRET_A = "sk_locataire_a_jamais_rendu_par_une_route";
const SECRET_B = "sk_locataire_b_different_du_premier";

let client: TestClient;
let fixture: Server;
const saved: Record<string, string | undefined> = {};

interface DestinationRow {
  id: string;
  label: string;
  origin: string;
  credential: {
    tenant: { state: string; fingerprint: string; connectedAt: string | null } | null;
    shared: boolean;
    none: boolean;
  };
}

beforeAll(async () => {
  /*
   * Une destination RÉELLE : `local-fixture` ne se résout que si l'URL de boucle locale
   * est posée, et c'est la seule variable qui accepte une adresse de boucle locale. Un
   * serveur qui écoute suffit — ces tests n'appellent jamais l'amont, ils configurent.
   */
  fixture = createServer((_req, res) => res.end("{}"));
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const { port } = fixture.address() as AddressInfo;

  for (const name of ["OATHRION_LOCAL_MCP_URL", "OATHRION_LOCAL_MCP_ORGANIZATIONS", "OATHRION_KEK", ENV_KEY]) {
    saved[name] = process.env[name];
  }
  process.env.OATHRION_LOCAL_MCP_URL = `http://127.0.0.1:${String(port)}/`;
  process.env.OATHRION_LOCAL_MCP_ORGANIZATIONS = "*";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");

  client = await startTestServer();
},
/*
 * SOIXANTE SECONDES, et pas le défaut de dix.
 *
 * Cette mise en place démarre un serveur amont, importe le harnais, ouvre une session,
 * crée un agent, une politique et une clé — une demi-douzaine d'allers-retours. Sur une
 * machine chargée elle a dépassé dix secondes, et le fichier a été rapporté comme
 * ÉCHOUÉ AVEC ZÉRO TEST : pas un test faux, une mise en place interrompue.
 *
 * Un délai trop court ne protège de rien ici — il n'y a pas de boucle infinie possible
 * dans ces appels — et il transforme une machine occupée en échec de suite, c'est-à-dire
 * en bruit qui apprend à ignorer les échecs.
 */
60_000);

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(async () => {
  /* Chaque test part sans clé de déploiement ; ceux qui l'exercent la posent eux-mêmes. */
  delete process.env[ENV_KEY];
  await client.del(`/api/destinations/${DEST}/credential`, { auth: ROLE_KEYS.admin });
  await client.del(`/api/destinations/${DEST}/credential`, { auth: OTHER_ORG_KEYS.admin });
});

describe("sceller la clé d'une destination", () => {
  it("la scelle et NE L'ANNONCE PAS vérifiée", async () => {
    const res = await client.put<{ stored: boolean; state: string; fingerprint: string; detail: string }>(
      `/api/destinations/${DEST}/credential`,
      { secret: SECRET_A },
      { auth: ROLE_KEYS.admin },
    );
    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(true);
    /* LA propriété : jamais « connected », parce qu'aucune sonde n'a eu lieu. */
    expect(res.body.state).toBe("stored_unverified");
    expect(res.body.state).not.toBe("connected");
    /* Six caractères de SHA-256 : assez pour reconnaître la clé, inutile pour la refaire. */
    expect(res.body.fingerprint).toMatch(/^[0-9a-f]{6}$/);
    /*
     * Et le détail dit l'absence de vérification à l'exploitant qui lira la réponse, pas
     * seulement à celui qui lira la documentation.
     */
    expect(res.body.detail).toContain("NO check");
  });

  it("ne rend jamais le secret, ni son enveloppe, ni sa longueur", async () => {
    const res = await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.admin });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(SECRET_A);
    expect(serialised).not.toContain("envelope");
    expect(serialised).not.toContain(String(SECRET_A.length));
  });

  it("refuse une destination qui n'est pas enregistrée, en nommant la raison", async () => {
    const res = await client.put<{ error?: string; message?: string; code?: string }>(
      `/api/destinations/pas-enregistree/credential`,
      { secret: SECRET_A },
      { auth: ROLE_KEYS.admin },
    );
    expect(res.status).toBe(404);
    /*
     * Sans cette vérification, la route serait un magasin de secrets à clé libre : un
     * appelant pourrait sceller sous n'importe quel identifiant.
     */
    expect(JSON.stringify(res.body)).toContain("enregistr");
  });

  it("refuse un corps avec un champ inconnu", async () => {
    const res = await client.put(
      `/api/destinations/${DEST}/credential`,
      { secret: SECRET_A, state: "connected" },
      { auth: ROLE_KEYS.admin },
    );
    /* Un client qui croit choisir l'état doit l'apprendre par un 400. */
    expect(res.status).toBe(400);
  });

  it("`read` ne suffit pas : écrire un credential est une administration", async () => {
    const res = await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.viewer });
    expect(res.status).toBe(403);
  });
});

describe("l'isolation entre locataires", () => {
  it("la clé d'un locataire n'existe pas pour l'autre", async () => {
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.admin });
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_B }, { auth: OTHER_ORG_KEYS.admin });

    const mine = await client.get<DestinationRow[]>("/api/destinations", { auth: ROLE_KEYS.admin });
    const theirs = await client.get<DestinationRow[]>("/api/destinations", { auth: OTHER_ORG_KEYS.admin });

    const a = mine.body.find((row) => row.id === DEST);
    const b = theirs.body.find((row) => row.id === DEST);
    expect(a?.credential.tenant?.state).toBe("stored_unverified");
    expect(b?.credential.tenant?.state).toBe("stored_unverified");
    /*
     * Deux empreintes DIFFÉRENTES : la preuve que ce sont deux lignes et non une partagée.
     * Comparer les états seuls passerait aussi sur une table sans colonne de locataire.
     */
    expect(a?.credential.tenant?.fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(b?.credential.tenant?.fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(a?.credential.tenant?.fingerprint).not.toBe(b?.credential.tenant?.fingerprint);
  });

  it("révoquer chez l'un ne révoque pas chez l'autre", async () => {
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.admin });
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_B }, { auth: OTHER_ORG_KEYS.admin });

    const revoked = await client.del(`/api/destinations/${DEST}/credential`, { auth: ROLE_KEYS.admin });
    expect(revoked.status).toBe(200);

    const theirs = await client.get<DestinationRow[]>("/api/destinations", { auth: OTHER_ORG_KEYS.admin });
    expect(theirs.body.find((row) => row.id === DEST)?.credential.tenant?.state).toBe("stored_unverified");
  });
});

describe("ce que la liste des destinations DIVULGUE", () => {
  it("dit `shared` quand la clé injectée est celle du DÉPLOIEMENT", async () => {
    /*
     * Le cas mutualisé : aucun credential de locataire, mais la variable existe. Le relais
     * injectera la clé du déploiement — commune à tous les locataires — et c'est ce que
     * cette ligne doit révéler avant qu'on héberge une deuxième organisation.
     */
    process.env[ENV_KEY] = "sk_du_deploiement_partage";
    const res = await client.get<DestinationRow[]>("/api/destinations", { auth: ROLE_KEYS.admin });
    const row = res.body.find((entry) => entry.id === DEST);
    expect(row?.credential.tenant).toBeNull();
    expect(row?.credential.shared).toBe(true);
    expect(row?.credential.none).toBe(false);
    /* Et jamais la valeur de la variable. */
    expect(JSON.stringify(res.body)).not.toContain("sk_du_deploiement_partage");
  });

  it("dit `none` quand Oathrion n'a aucune clé à injecter", async () => {
    const res = await client.get<DestinationRow[]>("/api/destinations", { auth: ROLE_KEYS.admin });
    const row = res.body.find((entry) => entry.id === DEST);
    expect(row?.credential.none).toBe(true);
    expect(row?.credential.shared).toBe(false);
  });

  it("la clé du locataire PRIME sur celle du déploiement, et la liste le montre", async () => {
    process.env[ENV_KEY] = "sk_du_deploiement_partage";
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.admin });
    const res = await client.get<DestinationRow[]>("/api/destinations", { auth: ROLE_KEYS.admin });
    const row = res.body.find((entry) => entry.id === DEST);
    expect(row?.credential.tenant?.state).toBe("stored_unverified");
    /* `shared` retombe à faux : ce locataire n'utilise plus la clé commune. */
    expect(row?.credential.shared).toBe(false);
  });

  it("montre l'origine, pour qu'un exploitant vérifie OÙ ça part", async () => {
    const res = await client.get<DestinationRow[]>("/api/destinations", { auth: ROLE_KEYS.admin });
    expect(res.body.find((entry) => entry.id === DEST)?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("la révocation dit ce qu'elle ne coupe pas", () => {
  it("AVERTIT que le relais retombe sur la clé du déploiement", async () => {
    process.env[ENV_KEY] = "sk_du_deploiement_partage";
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.admin });

    const res = await client.del<{ revoked: boolean; fallsBackToDeploymentKey: boolean; detail: string }>(
      `/api/destinations/${DEST}/credential`,
      { auth: ROLE_KEYS.admin },
    );
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    /*
     * La propriété : révoquer n'a pas COUPÉ l'injection, il l'a remplacée. Un exploitant
     * qui lit « révoqué » tout court croit avoir fermé une porte qui est encore ouverte.
     */
    expect(res.body.fallsBackToDeploymentKey).toBe(true);
    expect(res.body.detail).toContain(ENV_KEY);
  });

  it("et dit l'inverse quand il n'y a rien derrière", async () => {
    await client.put(`/api/destinations/${DEST}/credential`, { secret: SECRET_A }, { auth: ROLE_KEYS.admin });
    const res = await client.del<{ fallsBackToDeploymentKey: boolean; remoteStillValid: boolean; detail: string }>(
      `/api/destinations/${DEST}/credential`,
      { auth: ROLE_KEYS.admin },
    );
    expect(res.body.fallsBackToDeploymentKey).toBe(false);
    /*
     * Et dans les deux cas : Oathrion ne peut pas invalider une clé chez un fournisseur
     * qu'il ne connaît pas. Le dire est la différence entre « oublié ici » et « mort ».
     */
    expect(res.body.remoteStillValid).toBe(true);
    expect(res.body.detail).toContain("delete it there");
  });

  it("révoquer sans credential rend 409, pas un succès silencieux", async () => {
    const res = await client.del(`/api/destinations/${DEST}/credential`, { auth: ROLE_KEYS.admin });
    expect(res.status).toBe(409);
  });
});
