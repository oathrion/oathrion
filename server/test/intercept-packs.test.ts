/**
 * LES PAQUETS DE RÈGLES — l'extraction fonctionne-t-elle sur un corps RÉALISTE ?
 *
 * ## Ce que ce fichier prouve, et ce qu'il ne prouve pas
 *
 * Un paquet est un ensemble de règles écrites une fois pour un outil courant, pour qu'un
 * exploitant n'ait pas à deviner où Stripe range son montant. L'intérêt d'un paquet n'est
 * donc pas qu'il EXISTE, c'est qu'il EXTRAIT LA BONNE VALEUR.
 *
 * Chaque cas ci-dessous construit une requête comme le fournisseur la documente et
 * vérifie ce qu'Oathrion en lit : le verbe, la cible, le montant, et l'unité du montant.
 *
 * **Cela ne prouve pas que le fournisseur se comporte comme sa documentation.** Les
 * chemins et les noms de champs viennent de la documentation publiée ; aucun appel réel
 * n'est fait. Classement honnête : implémenté, éprouvé localement, **non vérifié contre
 * le service réel**.
 *
 * ## Le cas qui justifie tout le fichier
 *
 * `amountScale: 100` chez Stripe. L'API compte en centimes ; un exploitant qui écrit un
 * plafond « 100 » pense 100 euros. Sans la conversion, Oathrion comparerait 7500 à 100.
 * L'erreur est SILENCIEUSE — rien dans la réponse ne dit que l'unité était fausse — et
 * elle va dans les deux sens : refuser tout, ou laisser passer cent fois trop.
 */

import { describe, expect, it } from "vitest";

import {
  INTERCEPT_PACKS,
  lookupPack,
  packRules,
  type InterceptPack,
} from "../intercept/packs";
import {
  extractAction,
  matchRule,
  parseInterceptRules,
  type InterceptedRequest,
} from "../intercept/rules";
import { readSuccessField } from "../intercept/forward";
import { ACTION_CATALOG } from "@shared/policy/actions";
import type { CurrencyCode } from "@shared/money";

const env = (packs: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ OATHRION_INTERCEPT_PACKS: packs, ...extra }) as NodeJS.ProcessEnv;

/** Une requête comme un agent l'enverrait. */
function request(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
): InterceptedRequest {
  return { method, path, query: {}, headers: {}, body };
}

/**
 * Le verbe, la cible et le montant qu'Oathrion lit d'une requête, via la règle qui matche.
 *
 * `orgCurrency` vaut EUR par défaut, comme `DEFAULT_CURRENCY` : c'est la devise que la
 * route d'interception transmet pour une organisation qui n'en a pas choisi d'autre.
 */
function judged(packs: string, req: InterceptedRequest, orgCurrency: CurrencyCode = "EUR") {
  const rules = parseInterceptRules(env(packs));
  const rule = matchRule(rules, req);
  expect(rule, `aucune règle de "${packs}" ne reconnaît ${req.method} ${req.path}`).not.toBeNull();
  return { rule: rule!, ...extractAction(rule!, req, { orgCurrency }) };
}

describe("le catalogue de paquets", () => {
  it("développe chaque paquet en règles dont la destination est le paquet", () => {
    for (const pack of INTERCEPT_PACKS) {
      const rules = packRules(env(pack.id));
      expect(rules.length, `${pack.id} ne produit aucune règle`).toBeGreaterThan(0);
      for (const rule of rules) expect(rule.destination).toBe(pack.id);
    }
  });

  it("REFUSE un paquet inconnu, en nommant ceux qui existent", () => {
    /*
     * Tolérer un nom inconnu ferait démarrer un déploiement en croyant gouverner un outil
     * qu'il ne gouverne pas. C'est la pire défaillance possible pour ce produit : une
     * fausse impression de contrôle.
     */
    expect(() => packRules(env("opanai"))).toThrow(/does not exist/);
    expect(() => packRules(env("opanai"))).toThrow(/openai/);
  });

  it("refuse un paquet nommé deux fois", () => {
    expect(() => packRules(env("stripe,stripe"))).toThrow(/twice/);
  });

  it("tolère les espaces et la casse, pas le silence", () => {
    expect(packRules(env(" Stripe , OPENAI ")).length).toBeGreaterThan(0);
    expect(packRules(env("")).length).toBe(0);
    expect(packRules({} as NodeJS.ProcessEnv).length).toBe(0);
  });

  it("chaque verbe employé par un paquet est AU CATALOGUE D'ACTIONS", () => {
    /*
     * Le catalogue est en refus par défaut : un verbe qu'il ne connaît pas est refusé.
     * Un paquet qui en inventerait un démarrerait et refuserait chaque appel, avec un
     * message qui parle du catalogue et non du paquet.
     */
    const known = new Set(ACTION_CATALOG.map((entry) => entry.action));
    for (const pack of INTERCEPT_PACKS) {
      for (const rule of pack.rules) {
        expect(known.has(rule.action), `${pack.id}/${rule.id} emploie "${rule.action}"`).toBe(true);
      }
    }
  });

  it("chaque paquet déclare ses limites, et une origine HTTPS", () => {
    /*
     * `limits` n'est pas décoratif : c'est ce qu'un commercial doit lire avant de
     * promettre. Un paquet sans limite déclarée serait un paquet dont personne n'a
     * cherché les bords.
     */
    for (const pack of INTERCEPT_PACKS) {
      expect(pack.limits.length, `${pack.id} ne déclare aucune limite`).toBeGreaterThan(0);
      expect(pack.origin, `${pack.id}`).toMatch(/^https:\/\//);
      expect(pack.credential.template).toContain("{secret}");
    }
  });

  it("les identifiants de règle sont uniques à travers TOUT le catalogue", () => {
    /*
     * Deux paquets activés ensemble passent par le contrôle d'unicité de
     * `parseInterceptRules`. Une collision ferait échouer le démarrage pour une raison
     * que l'exploitant n'a pas causée.
     */
    const ids = INTERCEPT_PACKS.flatMap((p) => p.rules.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tous les paquets activés ensemble produisent des règles valides", () => {
    const tous = INTERCEPT_PACKS.map((p) => p.id).join(",");
    expect(() => parseInterceptRules(env(tous))).not.toThrow();
    expect(parseInterceptRules(env(tous)).length).toBe(
      INTERCEPT_PACKS.reduce((n, p) => n + p.rules.length, 0),
    );
  });
});

/**
 * LES PAQUETS PASSENT PAR LE MÊME VALIDATEUR QUE LES RÈGLES ÉCRITES À LA MAIN.
 *
 * ## Le défaut que ce bloc empêche de revenir
 *
 * La première version développait les paquets APRÈS la boucle de validation : les règles
 * de paquet ne traversaient AUCUN contrôle. Et le commentaire du code affirmait qu'elles
 * traversaient « exactement les mêmes contrôles » — une promesse plus large que ce qui
 * était appliqué, dans le fichier même qui existe pour empêcher ce genre d'erreur.
 *
 * Ce n'était pas théorique : le paquet Google écrivait `{userId}` en camelCase, que
 * `NAMED_SEGMENT` ne reconnaît pas comme une capture. Chaque envoi de courriel aurait été
 * refusé en 422, avec un message parlant de la requête alors que la faute était livrée
 * par Oathrion.
 *
 * ## Pourquoi ces tests emploient un faux paquet
 *
 * On ne peut pas éprouver le validateur avec les paquets livrés : ils sont corrects, et
 * c'est bien l'objectif. On injecte donc une règle fautive par `OATHRION_INTERCEPTS` et on
 * vérifie que le message distingue les deux origines — parce qu'envoyer un exploitant
 * corriger `OATHRION_INTERCEPTS` quand la faute vient d'un paquet livré lui fait ouvrir un
 * fichier où il n'y a rien à corriger.
 */
describe("une règle de paquet est validée comme les autres", () => {
  it("tous les paquets livrés passent la validation complète", () => {
    /*
     * Si quelqu'un ajoute demain un paquet avec un verbe hors catalogue, une source
     * inconnue ou une capture mal écrite, ce test tombe au lieu de livrer une règle qui
     * refusera chaque appel en 422.
     *
     * CE QU'IL NE PROUVE PAS, et il faut le dire : il ne distingue pas « validé et
     * correct » de « pas validé du tout ». Un retour au défaut d'origine — les paquets
     * concaténés après la boucle — le laisserait passer, puisque rien ne lèverait.
     *
     * Le garde qui attrape CELA est le test « une règle à la main ne peut pas RECOUVRIR
     * une règle de paquet », plus bas : il ne peut passer que si les identifiants de
     * paquet entrent dans l'ensemble `seen` du validateur, ce qui n'arrive que s'ils
     * traversent la boucle. Vérifié par mutation.
     */
    for (const pack of INTERCEPT_PACKS) {
      expect(() => parseInterceptRules(env(pack.id)), `paquet ${pack.id}`).not.toThrow();
    }
  });

  it("le message de refus nomme la VARIABLE à corriger", () => {
    const fautive = JSON.stringify([
      {
        id: "regle_fautive",
        destination: "acme",
        method: "POST",
        path: "/v1/x/{user_id}",
        /* Une source `path.` dont le motif ne déclare pas le segment. */
        action: "purchase",
        target: "path.absent",
      },
    ]);
    let message = "";
    try {
      parseInterceptRules({ OATHRION_INTERCEPTS: fautive } as NodeJS.ProcessEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^OATHRION_INTERCEPTS:/);
    expect(message).toMatch(/\{absent\}/);
  });

  it("une règle de paquet et une règle à la main ne partagent pas le même compteur", () => {
    /*
     * Les identifiants d'unicité couvrent les deux sources d'un seul tenant : une règle
     * à la main qui reprend l'identifiant d'une règle de paquet est refusée, et le test
     * du bloc suivant le prouve. Ici on vérifie seulement que le DÉCOMPTE est juste —
     * une erreur d'indice ferait nommer la mauvaise entrée dans les messages.
     */
    const maison = JSON.stringify([
      { id: "une_regle_a_moi", destination: "acme", method: "POST", path: "/x", action: "purchase", target: "body.t" },
    ]);
    const rules = parseInterceptRules(env("slack", { OATHRION_INTERCEPTS: maison }));
    const slack = INTERCEPT_PACKS.find((p) => p.id === "slack")!;
    expect(rules.length).toBe(slack.rules.length + 1);
    /* Les règles de paquet viennent en premier : l'ordre fixe quelle entrée est nommée. */
    expect(rules[0]!.destination).toBe("slack");
    expect(rules[rules.length - 1]!.id).toBe("une_regle_a_moi");
  });
});

describe("les paquets et les règles écrites à la main se combinent", () => {
  const maison = JSON.stringify([
    {
      id: "erp_maison",
      destination: "acme-erp",
      method: "POST",
      path: "/v1/commandes",
      action: "purchase",
      target: "body.fournisseur",
    },
  ]);

  it("les deux sources sont présentes", () => {
    const rules = parseInterceptRules(env("slack", { OATHRION_INTERCEPTS: maison }));
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("slack_post_message");
    expect(ids).toContain("erp_maison");
  });

  it("une règle à la main ne peut pas RECOUVRIR une règle de paquet en silence", () => {
    /*
     * Les paquets sont ajoutés en premier, donc un identifiant repris déclenche le refus
     * d'unicité. Sans cet ordre, un exploitant pourrait croire avoir modifié une règle de
     * paquet alors qu'il en aurait créé une seconde, ou l'inverse.
     *
     * ET C'EST AUSSI LE SEUL TEST QUI PROUVE QUE LES PAQUETS SONT VALIDÉS. Il ne peut
     * passer que si les identifiants de paquet sont entrés dans l'ensemble `seen` du
     * validateur — ce qui n'arrive que s'ils ont traversé la boucle de validation. Un
     * mutant qui remet les paquets en dehors de la boucle, comme dans la version
     * d'origine, tue ce test et lui seul.
     */
    const collision = JSON.stringify([
      {
        id: "slack_post_message",
        destination: "slack",
        method: "POST",
        path: "/api/chat.postMessage",
        action: "send_message",
        target: "body.text",
      },
    ]);
    expect(() => parseInterceptRules(env("slack", { OATHRION_INTERCEPTS: collision }))).toThrow(
      /slack_post_message/,
    );
  });
});

describe("OpenAI — ce qu'Oathrion lit d'un appel de modèle", () => {
  it("lit le modèle comme cible, et relaie en flux", () => {
    const { rule, action, target } = judged(
      "openai",
      request("POST", "/v1/chat/completions", {
        model: "gpt-4o",
        messages: [{ role: "user", content: "bonjour" }],
        stream: true,
      }),
    );
    expect(action).toBe("api.request");
    expect(target).toBe("gpt-4o");
    /*
     * `stream: true` sur la règle : sans lui, Oathrion tamponnerait la réponse entière et
     * supprimerait le streaming que l'application attend — c'est la différence entre un
     * pare-feu utilisable devant une API de modèle et un pare-feu qu'on retire.
     */
    expect(rule.stream).toBe(true);
  });

  it("reconnaît aussi /v1/responses et /v1/embeddings", () => {
    expect(judged("openai", request("POST", "/v1/responses", { model: "gpt-4o" })).target).toBe("gpt-4o");
    expect(
      judged("openai", request("POST", "/v1/embeddings", { model: "text-embedding-3-small", input: "x" })).target,
    ).toBe("text-embedding-3-small");
  });

  it("une requête vers un chemin non déclaré n'est reconnue par AUCUNE règle", () => {
    /* Refus par défaut : ce que le paquet ne nomme pas n'est pas gouverné, donc refusé. */
    const rules = parseInterceptRules(env("openai"));
    expect(matchRule(rules, request("POST", "/v1/fine_tuning/jobs", { model: "gpt-4o" }))).toBeNull();
  });
});

describe("Anthropic — et l'en-tête sans lequel l'API répond 400", () => {
  it("lit le modèle comme cible", () => {
    const { action, target } = judged(
      "anthropic",
      request("POST", "/v1/messages", {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "bonjour" }],
      }),
    );
    expect(action).toBe("api.request");
    expect(target).toBe("claude-sonnet-5");
  });

  it("`anthropic-version` est dans l'allowlist d'en-têtes", () => {
    /*
     * CE TEST EXISTE À CAUSE D'UN DÉFAUT VÉCU. Sur un autre amont, un en-tête obligatoire
     * absent de l'allowlist a produit 2 100 réponses 400 — avec `x-oathrion-decision: ALLOW`
     * sur chacune. L'allowlist faisait son travail, et le symptôme désignait le mauvais
     * coupable : l'exploitant cherche l'erreur côté fournisseur.
     *
     * `anthropic-version` est obligatoire chez ce fournisseur. L'oublier ici
     * reproduirait exactement ce défaut, en clientèle.
     */
    const rule = parseInterceptRules(env("anthropic")).find((r) => r.id === "anthropic_messages");
    expect(rule?.forwardHeaders).toContain("anthropic-version");
  });
});

/**
 * STRIPE — ce paquet a été corrigé par le vrai service, et ces tests le disent.
 *
 * Écrits d'abord d'après la documentation, ces tests vérifiaient ce que J'AVAIS COMPRIS de
 * l'API. `npm run verify:stripe`, avec une vraie clé de test, a montré trois écarts :
 *
 *   · Stripe REFUSE `currency` sur `/v1/refunds` (`Received unknown parameter: currency`).
 *     L'ancien test envoyait une devise dans un remboursement — il validait donc une
 *     requête que Stripe rejette.
 *   · un remboursement désigne son paiement par `payment_intent` OU par `charge`.
 *   · l'échelle des montants dépend de la devise : centimes pour l'euro, francs pour le
 *     franc CFA.
 */
describe("Stripe — l'échelle des montants vient de la devise", () => {
  it("lit le paiement, et pas de devise, dans un remboursement", () => {
    const { action, target, metadata } = judged(
      "stripe",
      request("POST", "/v1/refunds", { charge: "ch_3Abc", amount: "7500" }),
    );
    expect(action).toBe("refund");
    expect(target).toBe("ch_3Abc");
    /*
     * La règle ne lit PAS `currency` : Stripe la refuse sur cet endpoint. Le montant est
     * jugé dans la devise de l'organisation, que la route transmet.
     */
    expect(metadata.currency).toBeUndefined();
  });

  it("accepte `payment_intent`, la forme des bibliothèques Stripe actuelles", () => {
    const { target } = judged(
      "stripe",
      request("POST", "/v1/refunds", { payment_intent: "pi_3Xyz", amount: "1000" }),
    );
    expect(target).toBe("pi_3Xyz");
  });

  it("préfère `payment_intent` quand les deux sont présents", () => {
    /* L'ordre de la règle décide ; Stripe, lui, refuse une requête qui porte les deux. */
    const { target } = judged(
      "stripe",
      request("POST", "/v1/refunds", { payment_intent: "pi_1", charge: "ch_1", amount: "1000" }),
    );
    expect(target).toBe("pi_1");
  });

  it("refuse un remboursement qui ne désigne aucun paiement", () => {
    const rules = parseInterceptRules(env("stripe"));
    const req = request("POST", "/v1/refunds", { amount: "1000" });
    expect(() => extractAction(matchRule(rules, req)!, req, { orgCurrency: "EUR" })).toThrow(
      /payment_intent\|body\.charge/,
    );
  });

  it("EUR : 7500 centimes valent 75 €", () => {
    const { metadata } = judged("stripe", request("POST", "/v1/refunds", { charge: "ch_1", amount: "7500" }), "EUR");
    expect(metadata.amount).toBe(75);
  });

  it("XOF : 100 000 valent 100 000 francs, PAS 1 000", () => {
    /*
     * LE TEST QUI JUSTIFIE `amountUnit: "minor"`.
     *
     * Stripe compte le franc CFA sans subdivision, comme le registre d'Oathrion
     * (`exponent: 0`). L'ancienne règle divisait tout par 100 : pour une organisation en
     * XOF, ce remboursement de 100 000 F était jugé comme 1 000 F, et un plafond de
     * 50 000 F le laissait passer. Cent fois trop petit, dans le sens qui laisse passer.
     */
    const { metadata } = judged("stripe", request("POST", "/v1/refunds", { charge: "ch_1", amount: "100000" }), "XOF");
    expect(metadata.amount).toBe(100_000);
  });

  it("XAF aussi, et USD comme EUR", () => {
    expect(judged("stripe", request("POST", "/v1/refunds", { charge: "ch_1", amount: "2500" }), "XAF").metadata.amount).toBe(2500);
    expect(judged("stripe", request("POST", "/v1/refunds", { charge: "ch_1", amount: "2500" }), "USD").metadata.amount).toBe(25);
  });

  it("un paiement prend l'échelle de SA devise, pas de celle de l'organisation", () => {
    /*
     * `/v1/payment_intents` porte sa devise — obligatoire chez Stripe. Une organisation en
     * EUR qui encaisse 50 000 XOF : l'échelle est celle du franc CFA, et le moteur, lui,
     * refusera ensuite le paiement parce que la devise diffère de celle du plafond. Les
     * deux décisions sont correctes, et indépendantes.
     */
    const { metadata } = judged(
      "stripe",
      request("POST", "/v1/payment_intents", { customer: "cus_1", amount: "50000", currency: "xof" }),
      "EUR",
    );
    expect(metadata.amount).toBe(50_000);
    expect(metadata.currency).toBe("XOF");
  });

  it("REFUSE de deviner l'unité quand aucune devise n'est connue", () => {
    /*
     * Ni dans la requête, ni pour l'organisation : diviser par 100 « par défaut » serait
     * exactement le défaut que cette option corrige.
     */
    const rules = parseInterceptRules(env("stripe"));
    const req = request("POST", "/v1/refunds", { charge: "ch_1", amount: "7500" });
    expect(() => extractAction(matchRule(rules, req)!, req)).toThrow(/does not guess/);
  });

  it("refuse une devise inconnue du registre", () => {
    const rules = parseInterceptRules(env("stripe"));
    const req = request("POST", "/v1/payment_intents", { customer: "cus_1", amount: "100", currency: "zzz" });
    expect(() => extractAction(matchRule(rules, req)!, req, { orgCurrency: "EUR" })).toThrow(/not a currency Oathrion knows/);
  });

  it("aucune règle Stripe n'emploie plus une échelle fixe", () => {
    for (const rule of lookupPack("stripe")!.rules) {
      expect(rule.amountScale, rule.id).toBeUndefined();
      expect(rule.amountUnit, rule.id).toBe("minor");
    }
  });

  it("ni le remboursement ni la capture ne lisent `currency` — Stripe la refuse", () => {
    const pack = lookupPack("stripe")!;
    expect(pack.rules.find((r) => r.id === "stripe_refund")?.currency).toBeUndefined();
    expect(pack.rules.find((r) => r.id === "stripe_charge_capture")?.currency).toBeUndefined();
  });

  it("lit une ressource placée dans l'URL — la capture d'une charge", () => {
    const { action, target, metadata } = judged(
      "stripe",
      request("POST", "/v1/charges/ch_3Xyz/capture", { amount: "2000" }),
    );
    expect(action).toBe("charge");
    expect(target).toBe("ch_3Xyz");
    expect(metadata.amount).toBe(20);
  });

  it("un virement sans destination est REFUSÉ, pas deviné", () => {
    const rules = parseInterceptRules(env("stripe"));
    const req = request("POST", "/v1/payouts", { amount: "500000", currency: "eur" });
    const rule = matchRule(rules, req);
    expect(rule).not.toBeNull();
    expect(() => extractAction(rule!, req, { orgCurrency: "EUR" })).toThrow(/destination/);
  });

  it("et un virement qui la nomme passe, avec son montant converti", () => {
    const { action, target, metadata } = judged(
      "stripe",
      request("POST", "/v1/payouts", { destination: "ba_1Abc", amount: "500000", currency: "eur" }),
    );
    expect(action).toBe("payout");
    expect(target).toBe("ba_1Abc");
    expect(metadata.amount).toBe(5000);
  });
});

/**
 * LA GRAMMAIRE QUE LE VRAI STRIPE A RENDUE NÉCESSAIRE — et ses garde-fous.
 *
 * Deux ajouts, et chacun refuse ses mauvais usages au démarrage plutôt qu'au premier appel.
 */
describe("plusieurs sources de cible, et l'unité mineure", () => {
  const rule = (extra: Record<string, unknown>) =>
    ({
      OATHRION_INTERCEPTS: JSON.stringify([
        { id: "regle_essai", destination: "acme", method: "POST", path: "/v1/x/{piece}", action: "refund", target: "body.a", ...extra },
      ]),
    }) as NodeJS.ProcessEnv;

  it("accepte jusqu'à quatre sources, chacune validée", () => {
    expect(() => parseInterceptRules(rule({ target: "body.a|body.b|path.piece|query.c" }))).not.toThrow();
  });

  it("refuse une source invalide dans la liste", () => {
    expect(() => parseInterceptRules(rule({ target: "body.a|corps.b" }))).toThrow(/is not a request source/);
  });

  it("refuse une alternative `path.` sans segment déclaré — le contrôle vaut pour chacune", () => {
    expect(() => parseInterceptRules(rule({ target: "body.a|path.absent" }))).toThrow(/\{absent\}/);
  });

  it("refuse plus de quatre sources, et une source répétée", () => {
    expect(() => parseInterceptRules(rule({ target: "body.a|body.b|body.c|body.d|body.e" }))).toThrow(/4 at most/);
    expect(() => parseInterceptRules(rule({ target: "body.a|body.a" }))).toThrow(/twice/);
  });

  it("refuse `amountUnit` autre que \"minor\"", () => {
    expect(() => parseInterceptRules(rule({ amount: "body.m", amountUnit: "cents" }))).toThrow(/minor/);
  });

  it("refuse `amountUnit` et `amountScale` ensemble", () => {
    expect(() => parseInterceptRules(rule({ amount: "body.m", amountUnit: "minor", amountScale: 100 }))).toThrow(/mutually exclusive/);
  });

  it("refuse `amountUnit` sans montant", () => {
    expect(() => parseInterceptRules(rule({ amountUnit: "minor" }))).toThrow(/converts nothing/);
  });
});

describe("Slack — le canal, pas le texte", () => {
  it("lit le canal comme cible", () => {
    const { action, target } = judged(
      "slack",
      request("POST", "/api/chat.postMessage", { channel: "C0123456", text: "bonjour" }),
    );
    expect(action).toBe("send_message");
    expect(target).toBe("C0123456");
  });

  it("le TEXTE n'est pas la cible — une politique porte sur le canal", () => {
    /*
     * Affirmé explicitement pour que personne ne vende « Oathrion filtre le contenu des
     * messages Slack ». Il ne le fait pas, et ce paquet ne le prétend pas.
     */
    const rule = parseInterceptRules(env("slack")).find((r) => r.id === "slack_post_message");
    expect(rule?.target).toBe("body.channel");
    expect(rule?.target).not.toContain("text");
  });
});

describe("Gmail — la limite qu'il faut connaître avant de vendre", () => {
  it("la cible est la BOÎTE EXPÉDITRICE, lue dans le chemin", () => {
    /*
     * `{user_id}` en minuscules, et c'est une correction qui a révélé un trou.
     *
     * Le paquet écrivait d'abord `{userId}` en camelCase. `NAMED_SEGMENT` n'accepte que
     * des minuscules, donc ce segment n'était pas une capture : `path.userId` lisait
     * `undefined`, et chaque envoi de courriel aurait été refusé en 422 avec un message
     * parlant de la requête alors que la faute était dans le paquet.
     *
     * Le contrôle qui attrape exactement cela existait déjà — mais il ne s'appliquait
     * qu'aux règles écrites à la main, pas à celles des paquets. Les deux sources passent
     * désormais par le MÊME validateur, et cette faute est refusée au démarrage.
     */
    const { action, target } = judged(
      "google",
      request("POST", "/gmail/v1/users/agent@acme.example/messages/send", {
        raw: "VG86IGNsaWVudEBhaWxsZXVycy5leGFtcGxl",
      }),
    );
    expect(action).toBe("send_email");
    expect(target).toBe("agent@acme.example");
  });

  it("le DESTINATAIRE n'est pas gouvernable, et le paquet le dit", () => {
    /*
     * LE TEST QUI EMPÊCHE UNE FAUSSE PROMESSE.
     *
     * Gmail encode le message entier en base64url dans `raw` ; l'adresse du destinataire
     * est dans ce blob. Oathrion lit des champs, il ne décode pas du base64 pour analyser
     * des en-têtes RFC 2822 — et il ne doit pas : un extracteur qui se tromperait sur un
     * format aussi tordu produirait une cible fausse, donc une décision prise sur autre
     * chose que la réalité.
     *
     * Une politique peut donc limiter la boîte expéditrice et le nombre d'envois, jamais
     * le « à qui ». Ce test pin la limite ET sa déclaration, pour qu'on ne puisse pas
     * promettre l'inverse sans le voir.
     */
    const pack = lookupPack("google") as InterceptPack;
    const rule = pack.rules.find((r) => r.id === "gmail_send");
    expect(rule?.target).toBe("path.user_id");
    expect(pack.limits.join(" ")).toMatch(/recipient.*CANNOT be governed/i);
  });
});

/**
 * `successField` — lire la réussite dans le corps, quand le fournisseur répond 200 à un refus.
 *
 * Ajouté parce que le vrai Slack répond 200 à un message qu'il rejette. Le bout en bout est
 * éprouvé dans `intercept-streaming.test.ts` ; ici, la grammaire et la lecture.
 */
describe("le champ de réussite", () => {
  const rule = (extra: Record<string, unknown>) =>
    ({
      OATHRION_INTERCEPTS: JSON.stringify([
        { id: "regle_essai", destination: "acme", method: "POST", path: "/x", action: "send_message", target: "body.c", ...extra },
      ]),
    }) as NodeJS.ProcessEnv;

  it("accepte un chemin à points", () => {
    expect(parseInterceptRules(rule({ successField: "result.ok" }))[0]?.successField).toBe("result.ok");
  });

  it("refuse un chemin qui n'en est pas un", () => {
    expect(() => parseInterceptRules(rule({ successField: "ok; DROP" }))).toThrow(/path/);
    expect(() => parseInterceptRules(rule({ successField: 42 }))).toThrow(/path/);
  });

  it("refuse le champ de réussite avec le flux — un flux n'est pas lu avant d'être relayé", () => {
    expect(() => parseInterceptRules(rule({ successField: "ok", stream: true }))).toThrow(/mutually exclusive/);
  });

  it("ne compte comme réussite que le booléen `true`", () => {
    expect(readSuccessField('{"ok":true}', "ok")).toBe(true);
    expect(readSuccessField('{"ok":false,"error":"invalid_auth"}', "ok")).toBe(false);
    /* Ni une chaîne, ni un nombre, ni un champ absent : on n'affirme pas ce que le fournisseur n'a pas dit. */
    expect(readSuccessField('{"ok":"true"}', "ok")).toBe(false);
    expect(readSuccessField('{"ok":1}', "ok")).toBe(false);
    expect(readSuccessField('{"autre":true}', "ok")).toBe(false);
    expect(readSuccessField("pas du json", "ok")).toBe(false);
    expect(readSuccessField('{"result":{"ok":true}}', "result.ok")).toBe(true);
  });

  it("le paquet Slack lit la réussite dans `ok`, sur ses trois règles", () => {
    for (const r of lookupPack("slack")!.rules) expect(r.successField, r.id).toBe("ok");
  });
});
