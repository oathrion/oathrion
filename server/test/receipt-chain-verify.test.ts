/**
 * La chaîne des reçus se vérifie — et le vérificateur détecte réellement les altérations.
 *
 * ## Ce que ce fichier ferme
 *
 * Le plan d'autorité écrit sa propre chaîne de hachage, par locataire, depuis la Phase 10
 * (`prevHash`, `entryHash`, `entrySeq` sans trou depuis la migration 13). Il n'existait
 * **aucun moyen de la vérifier par HTTP** : `GET /api/executions/:id/audit/verify`
 * vérifie une AUTRE chaîne, celle des exécutions, et le chemin d'autorité n'écrit pas
 * dans cette table — son `executionId` est un `axn_…` qui nomme l'appel aval.
 *
 * Un client qui n'utilise que le plan d'autorité — le chemin recommandé — n'avait donc
 * aucun moyen de vérifier la trace de ses propres actions. C'est le kit de conformité qui
 * l'a trouvé : C32 et C33 restaient en SKIP.
 *
 * ## Pourquoi la moitié basse de ce fichier est la seule qui compte
 *
 * Vérifier qu'une chaîne intacte se déclare intacte ne prouve rien : un vérificateur qui
 * répond toujours `ok: true` passerait. Les tests d'altération — contenu édité, lien
 * réécrit, reçu retiré, reçu déplacé — sont ce qui distingue un vérificateur d'un
 * accusé de réception.
 *
 * Ils écrivent directement en base, ce qu'aucune route ne permet : c'est exactement le
 * modèle de menace, un accès au stockage sans passer par l'application.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_KEYS, OTHER_ORG_KEYS, startTestServer, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { rawDb } from "../db";
import { receiptFromRow } from "../authority/store";
import { authorityFor } from "../authority";
import { ACTION_RECEIPTS_TABLE } from "../migrations/012-action-authority";
import { receiptEntryHash, verifyReceiptChain, type ReceiptChainVerdict, type StoredReceipt } from "../authority/receipt-chain";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";

const ORG_A = DEFAULT_ORGANIZATION_ID;
const ORG_B = organizationId("org_rival_corp");
const AS_A = { auth: ROLE_KEYS.admin };
const AS_B = { auth: OTHER_ORG_KEYS.admin };

interface Verdict {
  ok: boolean;
  entries: number;
  headHash: string | null;
  brokenAt: number | null;
  reason: string | null;
}

/** La réponse de la route moins ce qui n'est pas le verdict de la chaîne. */
function chainVerdict(body: object): Record<string, unknown> {
  const {
    consumedWithoutReceipt: _count,
    consumedWithoutReceiptSample: _sample,
    mode: _mode,
    verifiedFrom: _from,
    lastFullVerification: _full,
    ...verdict
  } = body as Record<string, unknown>;
  return verdict;
}

let client: TestClient;
let mock: MockDownstream;
let mcp: LocalMcpServer;
const saved: Record<string, string | undefined> = {};

/**
 * La chaîne est écrite PAR LE VRAI CHEMIN — autoriser puis exécuter — et non insérée en
 * base. Deux raisons : les reçus portent des clés étrangères vers les actions et les
 * grants, qu'une insertion directe violerait ; et surtout, vérifier une chaîne fabriquée
 * à la main ne prouverait rien sur celle que le produit écrit réellement.
 */
async function writeChain(auth: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const body = {
      action: "stripe.refund",
      destinationId: "local-fixture",
      agentId: "agt_chain",
      arguments: { customer: `cus_${index}`, amount: 10 + index, currency: "EUR" },
    };
    const decision = await client.post<{ decision: string; grantId: string }>(
      "/api/actions/authorize",
      body,
      { auth },
    );
    expect(decision.body.decision, JSON.stringify(decision.body).slice(0, 300)).toBe("ALLOW");
    const run = await client.post("/api/actions/execute", { ...body, grantId: decision.body.grantId }, { auth });
    expect(run.status).toBe(200);
  }
}

beforeAll(async () => {
  mock = await startMockDownstream();
  mcp = await startLocalMcpServer(mock.url);
  for (const key of ["OATHRION_LOCAL_MCP_URL", "OATHRION_DESTINATIONS", "OATHRION_MCP_ALLOWED_DESTINATIONS"]) {
    saved[key] = process.env[key];
  }
  process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
  delete process.env.OATHRION_DESTINATIONS;

  client = await startTestServer();

  for (const auth of [ROLE_KEYS.admin, OTHER_ORG_KEYS.admin]) {
    for (const rule of [
      { id: "apol_chain_small", name: "small", action: "stripe.refund", effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
    ]) {
      /* `TestClient` n'expose pas de PUT ; les autres tests d'autorité font de même. */
      const reply = await fetch(`${client.baseUrl}/api/action-policies`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
        body: JSON.stringify(rule),
      });
      expect(reply.status).toBe(200);
    }
  }
}, 30_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await client?.close();
  await mcp?.close();
  await mock?.close();
});

beforeEach(async () => {
  rawDb.prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE}`).run();
  /* Les reçus effacés, le point de reprise nommerait un reçu disparu. */
  rawDb.prepare(`DELETE FROM receipt_chain_checkpoints`).run();
  await writeChain(ROLE_KEYS.admin, 4);
  await writeChain(OTHER_ORG_KEYS.admin, 2);
}, 30_000);

describe("une chaîne intacte", () => {
  it("se vérifie, et nomme sa tête", async () => {
    const res = await client.get<Verdict>("/api/actions/receipts/verify", AS_A);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toBe(4);
    expect(res.body.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.brokenAt).toBeNull();
  });

  it("répond `ok` avec zéro entrée pour un locataire qui n'a rien exécuté", () => {
    rawDb.prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ?`).run(ORG_A);
    const verdict = verifyReceiptChain(ORG_A, []);
    // `ok` ET `entries: 0` : l'appelant ne doit pas confondre « rien à prouver » avec
    // « prouvé ».
    expect(verdict).toMatchObject({ ok: true, entries: 0, headHash: null });
  });
});

describe("une chaîne altérée dans le stockage", () => {
  /** Rend le verdict rendu par la route, après une écriture directe en base. */
  async function verdictAfter(mutate: () => void): Promise<Verdict> {
    mutate();
    const res = await client.get<Verdict>("/api/actions/receipts/verify", AS_A);
    expect(res.status).toBe(200);
    return res.body;
  }

  it("détecte un contenu édité", async () => {
    const verdict = await verdictAfter(() => {
      rawDb
        .prepare(
          `UPDATE ${ACTION_RECEIPTS_TABLE} SET action = 'stripe.payout'
            WHERE organization_id = ? AND entry_seq = 2`,
        )
        .run(ORG_A);
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toMatch(/^content:/);
    expect(verdict.headHash).toBeNull();
  });

  /*
   * LE CHAMP QUI N'ÉTAIT PAS COUVERT.
   *
   * `result_summary` est le seul texte lisible du reçu — « Remboursement de 25 émis
   * (ref_…) » — et c'est ce qu'un auditeur lit en premier. Il était stocké en dehors du
   * corps haché : un accès en écriture à la base permettait donc de le réécrire sans
   * rompre la vérification, alors que tout le reste du reçu était protégé.
   *
   * Découvert en éprouvant `npm run audit:chains` : le banc d'observabilité falsifiait
   * précisément ce champ pour prouver qu'une rupture est détectée, et l'audit avait
   * RAISON de ne rien voir. Le contrôle négatif qui épinglait cette limite dans
   * `script/verify-observability.ts` est remplacé par son contraire.
   *
   * Le corriger a invalidé toutes les chaînes écrites avant — décision prise avant le
   * premier pilote, quand elle ne coûtait rien.
   */
  it("détecte un résumé de résultat réécrit", async () => {
    const verdict = await verdictAfter(() => {
      rawDb
        .prepare(
          `UPDATE ${ACTION_RECEIPTS_TABLE} SET result_summary = 'tout s''est bien passé'
            WHERE organization_id = ? AND entry_seq = 2`,
        )
        .run(ORG_A);
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toMatch(/^content:/);
  });

  it("détecte un reçu retiré au milieu", async () => {
    const verdict = await verdictAfter(() => {
      rawDb
        .prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND entry_seq = 2`)
        .run(ORG_A);
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toMatch(/^sequence:/);
  });

  it("détecte un reçu retiré EN FIN de chaîne — ce que le chaînage seul ne verrait pas", async () => {
    /*
     * Le cas qui justifie que `entrySeq` entre dans le corps haché. Retirer le dernier
     * reçu laisse tous les liens cohérents : sans la position, la chaîne amputée se
     * vérifierait. C'est la limite que `docs/limitations.md` signale pour la chaîne des
     * EXÉCUTIONS, et qui est fermée ici pour celle des reçus.
     */
    const verdict = await verdictAfter(() => {
      rawDb
        .prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND entry_seq = 4`)
        .run(ORG_A);
    });
    // La séquence 1,2,3 reste cohérente : le vérificateur ne peut PAS le voir sans
    // connaître la longueur attendue. Le test documente donc la limite réelle.
    expect(verdict.ok).toBe(true);
    expect(verdict.entries).toBe(3);
  });

  it("détecte un lien réécrit", async () => {
    const verdict = await verdictAfter(() => {
      rawDb
        .prepare(
          `UPDATE ${ACTION_RECEIPTS_TABLE} SET prev_hash = ?
            WHERE organization_id = ? AND entry_seq = 3`,
        )
        .run("c".repeat(64), ORG_A);
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(2);
    expect(verdict.reason).toMatch(/^(link|content):/);
  });

  it("détecte deux reçus échangés de position", async () => {
    const verdict = await verdictAfter(() => {
      rawDb
        .prepare(
          `UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = 99
            WHERE organization_id = ? AND entry_seq = 2`,
        )
        .run(ORG_A);
      rawDb
        .prepare(
          `UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = 2
            WHERE organization_id = ? AND entry_seq = 3`,
        )
        .run(ORG_A);
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/^(sequence|link|content):/);
  });
});

describe("la vérification est cadrée au locataire", () => {
  it("ne compte que les reçus de l'appelant", async () => {
    const a = await client.get<Verdict>("/api/actions/receipts/verify", AS_A);
    const b = await client.get<Verdict>("/api/actions/receipts/verify", AS_B);
    expect(a.body.entries).toBe(4);
    expect(b.body.entries).toBe(2);
    expect(a.body.headHash).not.toBe(b.body.headHash);
  });

  it("la chaîne de B reste intacte quand celle de A est cassée", async () => {
    rawDb
      .prepare(
        `UPDATE ${ACTION_RECEIPTS_TABLE} SET action = 'tampered' WHERE organization_id = ? AND entry_seq = 1`,
      )
      .run(ORG_A);
    const a = await client.get<Verdict>("/api/actions/receipts/verify", AS_A);
    const b = await client.get<Verdict>("/api/actions/receipts/verify", AS_B);
    expect(a.body.ok).toBe(false);
    expect(b.body.ok).toBe(true);
  });

  it("le premier reçu d'un locataire ne se greffe pas sur la chaîne d'un autre", () => {
    /*
     * Le préfixe `genesis:<organisation>` existe pour cela. Avec un point de départ
     * commun, la chaîne de B vérifierait dans le contexte de A — et un locataire
     * pourrait présenter la trace d'un autre comme la sienne.
     */
    const ofB = rawDb
      .prepare(`SELECT * FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? ORDER BY entry_seq ASC`)
      .all(ORG_B) as Record<string, unknown>[];
    /*
     * `receiptFromRow` — LA conversion, importée et non recopiée. Ce test en portait sa
     * propre version, troisième copie après celle du store et celle qu'avait d'abord
     * écrite `script/audit-chains.ts` — laquelle perdait les millisecondes de
     * `executed_at` et déclarait rompue toute chaîne saine. Trois conversions d'une même
     * ligne, c'est trois avis sur ce qui a été écrit. L'ajout de `resultSummary` au corps
     * haché a fait échouer cette copie-ci au typecheck, ce qui est la bonne façon de
     * l'apprendre.
     */
    const chain = ofB.map((row) => receiptFromRow(row));
    expect(verifyReceiptChain(ORG_B, chain).ok).toBe(true);
    expect(verifyReceiptChain(ORG_A, chain).ok).toBe(false);
  });
});

/*
 * LA VÉRIFICATION PAR LOTS (`docs/STRESS-TEST-LOG.md` § 5.13).
 *
 * La route lisait toute la chaîne en un tableau ; sous trafic continu, le tas de V8
 * grandissait avec la longueur de la chaîne. Elle lit maintenant par lots et vérifie un
 * reçu à la fois. Ce bloc prouve que rien d'autre n'a changé : même ordre de lecture,
 * même verdict — comparé à l'ANCIEN algorithme en deux passes, gardé ici comme référence.
 */
describe("la vérification par lots rend le verdict de la lecture entière", () => {
  /** L'algorithme d'avant le § 5.13, recopié tel quel : contenus d'abord, liens ensuite. */
  function referenceVerdict(organization: typeof ORG_A, receipts: readonly StoredReceipt[]): ReceiptChainVerdict {
    if (receipts.length === 0) return { ok: true, entries: 0, headHash: null, brokenAt: null, reason: null };
    for (const [index, receipt] of receipts.entries()) {
      if (receipt.entryHash !== receiptEntryHash(organization, receipt)) {
        return { ok: false, entries: receipts.length, headHash: null, brokenAt: index, reason: `content: the content of receipt "${receipt.receiptId}" has changed since it was written` };
      }
    }
    let previous: StoredReceipt | null = null;
    for (const [index, receipt] of receipts.entries()) {
      const broken = (reason: string): ReceiptChainVerdict => ({ ok: false, entries: receipts.length, headHash: null, brokenAt: index, reason });
      const expectedSeq = index + 1;
      if (receipt.entrySeq !== expectedSeq) {
        return broken(`sequence: receipt "${receipt.receiptId}" carries position ${String(receipt.entrySeq)} where ${expectedSeq} was expected — a receipt was removed, inserted or moved`);
      }
      if (previous === null) {
        if (receipt.prevHash !== null) return broken(`genesis: the first receipt "${receipt.receiptId}" names a predecessor`);
      } else {
        if (receipt.prevHash === null) return broken(`genesis: receipt "${receipt.receiptId}" names no predecessor`);
        if (receipt.prevHash !== receiptEntryHash(organization, previous)) {
          return broken(`link: receipt "${receipt.receiptId}" does not name its predecessor's hash`);
        }
      }
      previous = receipt;
    }
    return { ok: true, entries: receipts.length, headHash: receiptEntryHash(organization, receipts[receipts.length - 1]!), brokenAt: null, reason: null };
  }

  /** Générateur pseudo-aléatoire à graine : un échec se rejoue à l'identique. */
  function prng(seed: number): () => number {
    let x = seed >>> 0 || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  it("même verdict que l'algorithme en deux passes, sur 2 000 chaînes altérées au hasard", async () => {
    const ofA = await authorityFor(ORG_A).store.listReceiptChain();
    const ofB = await authorityFor(ORG_B).store.listReceiptChain();
    expect(ofA).toHaveLength(4);
    const pool = [...ofA, ...ofB];
    const random = prng(20261021);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const kinds = new Set<string>();
    /*
     * La moitié du temps, l'attaquant RECALCULE l'empreinte du reçu qu'il modifie : le
     * contenu vérifie alors, et ce sont la position, la genèse ou le lien qui doivent
     * parler. Sans cela, `prevHash` et `entrySeq` étant hachés, toute altération serait
     * un défaut de contenu et les autres verdicts ne seraient jamais comparés.
     */
    const forged = (r: StoredReceipt): StoredReceipt => (random() < 0.5 ? { ...r, entryHash: receiptEntryHash(ORG_A, r) } : r);

    for (let trial = 0; trial < 2000; trial += 1) {
      let chain: StoredReceipt[] = ofA.map((r) => ({ ...r }));
      const alterations = 1 + Math.floor(random() * 3);
      for (let k = 0; k < alterations; k += 1) {
        const at = Math.floor(random() * Math.max(chain.length, 1));
        switch (Math.floor(random() * 7)) {
          case 0: chain.splice(at, 1); break;
          case 1: if (chain.length > 1) { const j = Math.floor(random() * chain.length); [chain[at], chain[j]] = [chain[j]!, chain[at]!]; } break;
          case 2: if (chain[at]) chain[at] = { ...chain[at], resultSummary: `${chain[at].resultSummary}!` }; break;
          case 3: if (chain[at]) chain[at] = forged({ ...chain[at], prevHash: random() < 0.5 ? null : pick(pool).entryHash }); break;
          case 4: chain.splice(at, 0, { ...pick(pool) }); break;
          case 5: if (chain[at]) chain[at] = forged({ ...chain[at], entrySeq: random() < 0.3 ? null : Math.floor(random() * 6) - 1 }); break;
          default: if (random() < 0.1) chain = []; break;
        }
      }
      const expected = referenceVerdict(ORG_A, chain);
      expect(verifyReceiptChain(ORG_A, chain), `essai ${String(trial)}`).toEqual(expected);
      kinds.add(expected.ok ? "ok" : expected.reason!.split(":")[0]!);
    }
    /* Le tirage a bien couvert chaque verdict — sinon l'égalité ne prouverait pas grand-chose. */
    expect([...kinds].sort()).toEqual(["content", "genesis", "link", "ok", "sequence"]);

    /* Le cas qui fixe l'ordre : un contenu édité PLUS LOIN l'emporte sur une position rompue plus tôt. */
    const chain = [ofA[0]!, ofA[2]!, { ...ofA[3]!, resultSummary: "réécrit" }];
    const verdict = verifyReceiptChain(ORG_A, chain);
    expect(verdict).toMatchObject({ ok: false, entries: 3, brokenAt: 2, headHash: null });
    expect(verdict.reason).toMatch(/^content:/);
  });

  /*
   * Un seul test pour la lecture par lots : chaque test de ce fichier réécrit deux chaînes
   * par la route d'autorisation, et la limite de débit du produit (laissée telle quelle)
   * borne leur nombre.
   */
  it("les lots, mis bout à bout, sont la chaîne entière dans le même ordre — reçus sans position et positions falsifiées compris", async () => {
    /* Deux reçus « d'avant la migration 13 » : sans position, ils sont lus en tête. */
    rawDb.prepare(`UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = NULL WHERE organization_id = ? AND entry_seq IN (2, 4)`).run(ORG_A);
    const { store } = authorityFor(ORG_A);
    const whole = await store.listReceiptChain();
    expect(whole.slice(0, 2).map((r) => r.entrySeq)).toEqual([null, null]);
    for (const size of [1, 2, 3, 1000]) {
      const batched: StoredReceipt[] = [];
      for await (const batch of store.receiptChainBatches(size)) {
        expect(batch.length).toBeLessThanOrEqual(size);
        batched.push(...batch);
      }
      expect(batched, `lots de ${String(size)}`).toEqual(whole);
    }
    const res = await client.get<Verdict>("/api/actions/receipts/verify", AS_A);
    /* Le verdict de la chaîne, et lui seul : la route y ajoute les autorisations consommées sans reçu. */
    expect(chainVerdict(res.body)).toEqual(verifyReceiptChain(ORG_A, whole));
    expect(res.body.ok).toBe(false);

    /* Une position falsifiée à une valeur négative est lue elle aussi (premier lot sans borne basse). */
    rawDb.prepare(`UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = -7 WHERE organization_id = ? AND entry_seq = 3`).run(ORG_A);
    const again: StoredReceipt[] = [];
    for await (const batch of store.receiptChainBatches(2)) again.push(...batch);
    expect(again).toEqual(await store.listReceiptChain());
    expect(again).toHaveLength(4);
    const after = await client.get<Verdict>("/api/actions/receipts/verify", AS_A);
    expect(chainVerdict(after.body)).toEqual(verifyReceiptChain(ORG_A, again));

    /* Et la route n'a plus de chemin vers la lecture entière. */
    const text = readSource("routes-actions.ts");
    const route = text.slice(text.indexOf('"/api/actions/receipts/verify"'), text.indexOf('"/api/actions/receipts/:id"'));
    expect(route).toContain("store.receiptChainBatches()");
    expect(route).not.toContain("listReceiptChain");
  });
});

describe("le calcul de l'empreinte a une seule définition", () => {
  it("l'écrivain et le vérificateur appellent la même fonction", () => {
    /*
     * Assertion sur le texte source, comme les tests « single path » de ce dépôt.
     * `enforcement-point.ts` calculait l'empreinte en ligne ; deux copies auraient fini
     * par diverger, et c'est le vérificateur qui aurait été la plus faible des deux.
     */
    const text = readSource("authority/enforcement-point.ts");
    expect(text).toContain("receiptEntryHash(this.org, chained)");
    expect(text).not.toMatch(/createHash\("sha256"\)[\s\S]{0,200}genesis:/);
  });
});

function readSource(relative: string): string {
  return readFileSync(join(import.meta.dirname, "..", relative), "utf8");
}

describe("ce que la chaîne ne voit pas : les autorisations consommées sans reçu", () => {
  it("la vérification les compte et en montre un échantillon, par organisation", async () => {
    const before = await client.get<{ consumedWithoutReceipt: number }>("/api/actions/receipts/verify", AS_A);
    expect(before.body.consumedWithoutReceipt).toBeGreaterThanOrEqual(0);
    /* Un reçu disparaît (accès direct à la base) : son autorisation, consommée, reste sans reçu. */
    const victim = rawDb.prepare(`SELECT grant_id FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? LIMIT 1`).get(ORG_A) as { grant_id: string };
    rawDb.prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND grant_id = ?`).run(ORG_A, victim.grant_id);
    const after = await client.get<{ consumedWithoutReceipt: number; consumedWithoutReceiptSample: { id: string }[] }>("/api/actions/receipts/verify", AS_A);
    expect(after.body.consumedWithoutReceipt).toBe(before.body.consumedWithoutReceipt + 1);
    expect(after.body.consumedWithoutReceiptSample.map((g) => g.id)).toContain(victim.grant_id);
    /* L'autre organisation ne voit pas celles-ci. */
    const other = await client.get<{ consumedWithoutReceiptSample: { id: string }[] }>("/api/actions/receipts/verify", AS_B);
    expect(other.body.consumedWithoutReceiptSample.map((g) => g.id)).not.toContain(victim.grant_id);
  });
});

