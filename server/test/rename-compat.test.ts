/**
 * Tests de non-régression des renommages : AgentOS → ARIA → Placet → Oathrion.
 *
 * Un renommage touche trois endroits où il peut casser — ou affaiblir — un déploiement
 * en silence : la lecture de la configuration, le contrat d'en-têtes HTTP, et la liste
 * des credentials refusés. Chacun a donc ici un test qui échoue si la promesse de
 * compatibilité est abandonnée, **et** un test qui échoue si le chemin obsolète est
 * autorisé à l'emporter sur le nouveau.
 *
 * ## Ce que ce fichier affirme depuis le troisième renommage (Placet → Oathrion)
 *
 * 1. `PLACET_*` est honoré, `OATHRION_*` gagne quand les deux sont posés ;
 * 2. `ARIA_*` et `AGENTOS_*` ne sont **plus** honorés — deux générations au plus, c'est
 *    une décision, et un test l'épingle pour que personne ne le « répare » sans lire
 *    pourquoi ;
 * 3. les en-têtes sortants portent `X-Oathrion-*` **et** `X-Placet-*`, avec des valeurs
 *    identiques, et **plus** `X-ARIA-*` ;
 * 4. l'en-tête entrant accepte les deux noms, le courant gagnant ;
 * 5. les secrets refusés des TROIS générations restent refusés.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLegacyEnvAliases } from "../env-compat";
import { FORBIDDEN_CREDENTIALS } from "../auth";
import { legacyWireHeader, readWireHeader, wireHeader } from "@shared/wire-headers";
import { Notifier, WebhookChannel, type EmitInput } from "../notifications";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

describe("les variables d'environnement héritées", () => {
  it("copie une variable PLACET_ sur son équivalent OATHRION_", () => {
    const env = { PLACET_SESSION_SECRET: "correct-horse-battery-staple" } as NodeJS.ProcessEnv;
    const applied = applyLegacyEnvAliases(env, () => {});

    expect(env.OATHRION_SESSION_SECRET).toBe("correct-horse-battery-staple");
    expect(applied).toEqual([
      { legacy: "PLACET_SESSION_SECRET", current: "OATHRION_SESSION_SECRET" },
    ]);
  });

  it("ne laisse JAMAIS le nom hérité écraser le nom courant", () => {
    const env = {
      PLACET_SESSION_SECRET: "la-vieille-valeur-oubliee",
      OATHRION_SESSION_SECRET: "la-valeur-posee-expres",
    } as NodeJS.ProcessEnv;
    applyLegacyEnvAliases(env, () => {});
    expect(env.OATHRION_SESSION_SECRET).toBe("la-valeur-posee-expres");
  });

  it("nomme chaque alias appliqué dans un seul avertissement", () => {
    const env = {
      PLACET_SESSION_SECRET: "une-valeur-assez-longue",
      PLACET_API_KEYS: "Bot:operator:un-autre-secret-long",
    } as NodeJS.ProcessEnv;
    const messages: string[] = [];
    applyLegacyEnvAliases(env, (m) => messages.push(m));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("PLACET_SESSION_SECRET → rename to OATHRION_SESSION_SECRET");
    expect(messages[0]).toContain("PLACET_API_KEYS → rename to OATHRION_API_KEYS");
  });

  it("ne touche pas une variable dont le préfixe n'est pas au DÉBUT du nom", () => {
    const env = { MON_PLACET_TRUC: "x" } as NodeJS.ProcessEnv;
    applyLegacyEnvAliases(env, () => {});
    expect(env).toEqual({ MON_PLACET_TRUC: "x" });
  });

  it("est idempotent : un second passage n'alias rien", () => {
    const env = { PLACET_SEED: "demo" } as NodeJS.ProcessEnv;
    applyLegacyEnvAliases(env, () => {});
    expect(applyLegacyEnvAliases(env, () => {})).toEqual([]);
    expect(env.OATHRION_SEED).toBe("demo");
  });

  /*
   * LE TEST QUI ÉPINGLE UNE DÉCISION, et non un comportement souhaité.
   *
   * `AGENTOS_*` était honoré jusqu'au second renommage. Il ne l'est plus, et le retirer
   * était un choix : trois générations de noms créent une précédence à trois branches
   * que personne n'éprouve — `AGENTOS_X` l'emporte-t-il sur `ARIA_X` ? dans quel ordre
   * la copie se fait-elle ? Chaque réponse est défendable et aucune n'est évidente, ce
   * qui est exactement la propriété qu'une règle de configuration ne doit pas avoir.
   *
   * Ce test existe pour que quelqu'un qui « répare » ce trou lise d'abord ce paragraphe.
   */
  it("n'honore PLUS ARIA_ ni AGENTOS_, et c'est délibéré", () => {
    const env = { ARIA_SESSION_SECRET: "une-configuration-aria", AGENTOS_SESSION_SECRET: "une-configuration-de-2025" } as NodeJS.ProcessEnv;
    const applied = applyLegacyEnvAliases(env, () => {});

    expect(applied).toEqual([]);
    expect(env.OATHRION_SESSION_SECRET).toBeUndefined();
    expect(env.PLACET_SESSION_SECRET).toBeUndefined();
  });
});

describe("les secrets refusés, à travers trois générations de noms", () => {
  /*
   * Retirer un alias de confort et retirer une protection ne sont pas le même geste.
   * Ces chaînes ont été publiées dans trois documentations successives et dorment
   * certainement dans de vrais fichiers `.env` : un secret refusé doit le RESTER à
   * travers un renommage. Cette liste ne fait que grandir.
   */
  it.each([
    "placet-demo", "placet-dev-key",
    "aria-demo", "aria-dev-key",
    "agentos-demo", "agentos-dev-key",
  ])("refuse toujours %s", (value) => {
    expect(FORBIDDEN_CREDENTIALS.has(value)).toBe(true);
  });
});

describe("l'en-tête entrant", () => {
  it("accepte le nom courant", () => {
    const sent = { "x-oathrion-agent-id": "agt_courant" };
    expect(readWireHeader("agentId", (h) => sent[h.toLowerCase() as keyof typeof sent])).toBe("agt_courant");
  });

  it("accepte encore le nom hérité, seul", () => {
    const sent = { "x-placet-agent-id": "agt_herite" };
    expect(readWireHeader("agentId", (h) => sent[h.toLowerCase() as keyof typeof sent])).toBe("agt_herite");
  });

  it("fait gagner le nom COURANT quand les deux arrivent", () => {
    const sent = { "x-oathrion-agent-id": "agt_courant", "x-placet-agent-id": "agt_herite" };
    expect(readWireHeader("agentId", (h) => sent[h.toLowerCase() as keyof typeof sent])).toBe("agt_courant");
  });

  it("traite une valeur vide comme absente, et retombe sur le nom hérité", () => {
    const sent = { "x-oathrion-agent-id": "", "x-placet-agent-id": "agt_herite" };
    expect(readWireHeader("agentId", (h) => sent[h.toLowerCase() as keyof typeof sent])).toBe("agt_herite");
  });
});

describe("les en-têtes de webhook après le renommage", () => {
  /*
   * Un receveur réel en loopback, comme `notifications.test.ts` : ce qui est affirmé,
   * ce sont les octets et les en-têtes qu'un point de terminaison tiers VOIT
   * réellement — c'est de cela que parle la promesse de compatibilité. `allowPrivate`
   * est posé explicitement parce que le canal refuse le loopback par défaut (garde SSRF).
   */
  const SECRET = "rename-compat-webhook-secret-0123456789";

  let server: Server;
  let url: string;
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];

  beforeEach(async () => {
    received.length = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function event(): EmitInput {
    return {
      type: "approval.requested",
      title: "Approbation requise — achat 700 €",
      summary: "Au-dessus de la limite autonome.",
      risk: "medium",
      agentId: "agt_procurement",
      agentName: "Agent achats",
      executionId: "exe_rename",
      approvalId: "apr_rename",
      policyId: "pol_purchase_limit",
      policyName: "Montant d'achat maximum",
      data: {},
    };
  }

  async function deliver(secret?: string): Promise<IncomingMessage["headers"]> {
    const notifier = new Notifier().register(
      new WebhookChannel({ url, secret, allowPrivate: true }),
    );
    notifier.emit(event());
    await notifier.drain();
    expect(received).toHaveLength(1);
    return received[0]!.headers;
  }

  const lower = (name: string) => name.toLowerCase();

  it("envoie l'événement sous le nom courant ET sous le nom hérité", async () => {
    const headers = await deliver();
    expect(headers[lower(wireHeader("event"))]).toBe("approval.requested");
    expect(headers[lower(legacyWireHeader("event"))]).toBe("approval.requested");
  });

  it("porte le MÊME identifiant de livraison sur les deux noms", async () => {
    const headers = await deliver();
    expect(headers[lower(wireHeader("delivery"))]).toBeDefined();
    // Sinon un receveur qui déduplique sur le nom hérité verrait une livraison pour deux.
    expect(headers[lower(legacyWireHeader("delivery"))]).toBe(headers[lower(wireHeader("delivery"))]);
  });

  it("signe les deux en-têtes avec une valeur IDENTIQUE", async () => {
    const headers = await deliver(SECRET);
    const expected =
      "sha256=" + crypto.createHmac("sha256", SECRET).update(received[0]!.body).digest("hex");

    expect(headers[lower(wireHeader("signature"))]).toBe(expected);
    // Un receveur qui ne vérifie encore que le nom hérité doit continuer de vérifier.
    expect(headers[lower(legacyWireHeader("signature"))]).toBe(expected);
  });

  it("omet les deux signatures quand aucun secret n'est configuré", async () => {
    const headers = await deliver();
    // Le cas non signé reste non signé sur les deux noms : émettre un substitut
    // laisserait un receveur croire qu'il a vérifié quelque chose.
    expect(headers[lower(wireHeader("signature"))]).toBeUndefined();
    expect(headers[lower(legacyWireHeader("signature"))]).toBeUndefined();
  });

  /*
   * La génération d'AVANT est partie. Trois signatures du même corps dans une même
   * requête n'est pas de la compatibilité : c'est un contrat qu'on ne peut plus
   * énoncer, et un receveur qui vérifie la mauvaise des trois se croit protégé.
   */
  it("n'envoie PLUS les en-têtes X-AgentOS-*", async () => {
    const headers = await deliver(SECRET);
    expect(headers["x-agentos-event"]).toBeUndefined();
    expect(headers["x-agentos-delivery"]).toBeUndefined();
    expect(headers["x-agentos-signature"]).toBeUndefined();
  });

  it("annonce le produit sous son nom courant", async () => {
    expect((await deliver())["user-agent"]).toBe("Oathrion/1.0");
  });
});
