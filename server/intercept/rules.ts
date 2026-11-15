/**
 * Les règles d'interception — ce qu'Oathrion reconnaît d'une requête HTTP.
 *
 * ## LA DÉCISION DE CONCEPTION QUI COMPTE : LE VERBE NE VIENT PAS DE L'AGENT
 *
 * Un agent qui déclarerait lui-même « cette requête est un `refund` de 75 USD » choisirait
 * la règle qui le gouverne. Il suffirait d'annoncer `amount: 1` et d'envoyer un corps à
 * 100 000 pour passer sous tous les plafonds — et l'audit enregistrerait une autorisation
 * qui ne décrit pas ce qui s'est produit.
 *
 * Ici, le verbe, la cible et le montant sont **extraits de la requête réelle** par une
 * règle que l'exploitant a écrite. L'agent n'annonce rien : il envoie son appel HTTP tel
 * quel, et Oathrion le lit.
 *
 * ## DENY BY DEFAULT, ET C'EST TOUTE LA POSTURE
 *
 * Une requête qu'aucune règle ne reconnaît est **refusée**. Pas transmise « puisqu'on ne
 * sait pas la juger » — refusée, avec le motif et ce qu'il faut déclarer. Un pare-feu qui
 * laisse passer ce qu'il ne comprend pas n'est pas un pare-feu, c'est un journal.
 *
 * C'est la même posture que `shared/policy/posture.ts` applique aux verbes non
 * catalogués, et elle est ici structurelle : il n'y a pas de branche « sinon, transmettre ».
 *
 * ## LA FORME D'UNE RÈGLE
 *
 *   {
 *     "id": "stripe_refunds",
 *     "destination": "stripe-api",
 *     "method": "POST",
 *     "path": "/v1/refunds",
 *     "action": "refund",
 *     "target": "body.payment_intent|body.charge",
 *     "amount": "body.amount",
 *     "amountUnit": "minor"
 *   }
 *
 * Cet exemple a été CORRIGÉ PAR LE VRAI STRIPE. Il portait `"currency": "body.currency"`
 * et `"amountScale": 100`, et `npm run verify:stripe` a montré que les deux étaient faux :
 * Stripe REFUSE `currency` sur `/v1/refunds` (la devise est celle de la charge), et le
 * franc CFA n'a pas de centimes. Le paquet `stripe` (`OATHRION_INTERCEPT_PACKS=stripe`)
 * porte ces règles relues ; écrire la sienne n'est utile que pour une autre API.
 *
 * `destination` est une entrée du registre existant : même allowlist, mêmes règles
 * d'adresse anti-SSRF. Une règle ne peut pas inventer une destination.
 *
 * L'ÉCHELLE DU MONTANT. Les API financières comptent dans la plus petite unité de la
 * devise : Stripe envoie `7500` pour 75 €, mais `100000` pour 100 000 XOF, puisque le franc
 * CFA n'a pas de subdivision. `amountUnit: "minor"` prend l'échelle dans le registre des
 * devises (`shared/money.ts`) ; `amountScale` reste disponible pour une API qui emploie une
 * échelle fixe et sans rapport avec la devise. Sans conversion, un plafond de 100 laisserait
 * passer cent fois trop. C'est une division explicite, déclarée par règle, jamais devinée —
 * et c'est le seul calcul que ce module fait sur une valeur.
 */

/**
 * Une source extractible d'une requête HTTP.
 *
 * La liste est FERMÉE : une source inconnue est refusée au démarrage. `read()` traite
 * tout ce qui n'est pas reconnu comme une descente dans le corps, donc sans ce verrou
 * une faute de frappe (`bodyy.charge`) chercherait un champ dans le corps, ne le
 * trouverait pas, et refuserait chaque requête en 422 pour un motif qui ne nomme pas la
 * vraie cause.
 */
const SOURCE_SHAPE = /^(body|query|header|path)\.[A-Za-z0-9_.-]+$/;

export interface InterceptRule {
  id: string;
  /** L'identifiant d'une entrée de `OATHRION_DESTINATIONS`. */
  destination: string;
  /** La méthode HTTP exacte, en majuscules. */
  method: string;
  /**
   * Le chemin, avec `*` comme joker de segment final.
   * `/v1/refunds` ne matche que lui ; `/v1/charges/*` matche un segment de plus.
   */
  path: string;
  /** Le verbe Oathrion. Doit être au catalogue d'actions, comme tout verbe gouverné. */
  action: string;
  /** D'où lire la cible dans la requête. */
  target: string;
  /** D'où lire le montant, quand l'action en porte un. */
  amount?: string;
  currency?: string;
  /**
   * Diviseur appliqué au montant extrait. `100` pour une API en centimes.
   * Absent = aucune conversion.
   */
  amountScale?: number;
  /**
   * `"minor"` : le montant est exprimé dans la PLUS PETITE UNITÉ de sa devise, et l'échelle
   * se déduit de la devise au lieu d'être écrite en dur.
   *
   * Exclusif avec `amountScale`. Il existe parce qu'une échelle fixe est fausse dès que
   * les devises diffèrent : Stripe compte l'euro en centimes (÷ 100) mais le franc CFA en
   * francs (÷ 1), comme le registre de `shared/money.ts`. Avec `amountScale: 100`, un
   * remboursement de 100 000 XOF était jugé comme 1 000 XOF — cent fois trop petit, dans le
   * sens qui laisse passer.
   *
   * La devise est celle de la requête si la règle la lit, sinon celle de l'organisation.
   * Une devise inconnue du registre est REFUSÉE : Oathrion ne devine pas une unité.
   */
  amountUnit?: "minor";
  /**
   * Le champ du corps de réponse qui dit si le fournisseur a RÉELLEMENT réussi.
   *
   * Pour la plupart des API, le statut HTTP suffit : un 422 de Stripe est un refus, et le
   * reçu porte `failed`. L'API Web de Slack, elle, répond **200 même quand elle refuse**,
   * avec `{"ok": false, "error": "…"}`. Sans ce champ, Oathrion enregistrait un message que
   * Slack avait rejeté comme un message ENVOYÉ — un reçu qui ment, dans un produit dont
   * le reçu est la preuve.
   *
   * Un chemin à points dans le JSON de la réponse (`"ok"`, `"result.ok"`). La réussite
   * exige à la fois un statut 2xx ET la valeur `true` dans ce champ ; un corps illisible
   * ou un champ absent comptent comme un ÉCHEC — on ne présume pas d'une réussite que le
   * fournisseur n'a pas affirmée.
   *
   * Incompatible avec `stream: true` : un flux est relayé avant d'être lu.
   */
  successField?: string;
  /**
   * LES EN-TÊTES QUE L'AGENT PEUT FAIRE RELAYER. Une liste d'AUTORISATION.
   *
   * ## Le trou que ceci ferme
   *
   * Le relais appliquait une liste de REFUS : douze noms interdits, tout le reste
   * transmis. Pour un pare-feu, c'est à l'envers — et ce n'était pas théorique.
   *
   * Sur Stripe Connect, `Stripe-Account: acct_autre` fait agir l'appel **sur un autre
   * compte**. La règle inspecte `body.charge` et le plafond ; ni l'un ni l'autre ne voit
   * le changement de compte. Un agent compromis par injection de prompt remboursait
   * donc sur le compte d'un tiers, dans les limites du plafond, et l'audit enregistrait
   * une action parfaitement conforme. Même classe : `Stripe-Version` change la sémantique
   * de l'API sous la règle, `Idempotency-Key` rend la déduplication à l'agent.
   *
   * La règle « le verbe ne vient pas de l'agent » était contournée par le canal d'à côté.
   *
   * ## Le défaut, et pourquoi il est si court
   *
   * `content-type` et `accept` seulement. Tout le reste doit être nommé par l'exploitant,
   * qui décide alors en connaissance de cause. Un défaut généreux serait le même trou
   * avec une étape de plus.
   *
   * `authorization`, `cookie` et les en-têtes de transport restent refusés même si on les
   * nomme ici : ce sont le credential d'Oathrion et des valeurs que le transport
   * recalcule. Le refus au démarrage le dit.
   */
  forwardHeaders?: string[];
  /**
   * RELAYER LE CORPS DE LA RÉPONSE EN FLUX, au lieu de le tamponner.
   *
   * À déclarer pour une API qui répond en `text/event-stream` — une API de modèle qui
   * émet ses jetons au fil de l'eau. Sans ce drapeau, Oathrion attend la réponse entière
   * puis la rend d'un coup : l'application de l'utilisateur perd le streaming qu'elle
   * attend, et une réponse longue bute sur le plafond et fait échouer l'appel.
   *
   * ## Pourquoi c'est une DÉCLARATION et pas une détection
   *
   * On pourrait regarder le `content-type` de la réponse et basculer tout seul. Ce serait
   * laisser le FOURNISSEUR choisir le mode de relais, donc laisser une réponse décider de
   * la façon dont Oathrion la traite. La même raison qui fait que le verbe ne vient pas de
   * l'agent : ce qui gouverne se déclare.
   *
   * ## Ce que le mode flux ne change PAS
   *
   * La décision est prise avant que quoi que ce soit ne parte — le corps de la REQUÊTE est
   * entier, donc l'extraction, la politique et le mandat travaillent exactement comme
   * avant. Ce qui change est la direction du retour.
   *
   * ## Ce qu'il change, et qu'il faut savoir
   *
   * Le reçu porte les OCTETS et la troncature, pas le contenu — comme en mode tamponné.
   * Mais Oathrion ne peut plus rien dire du corps de la réponse en entier : il ne l'a jamais
   * eu en une fois. Il n'y avait rien d'autre à en dire aujourd'hui, donc rien n'est perdu
   * ici ; une future inspection de réponse serait, elle, impossible sur un flux.
   *
   * Et une requête RETENUE POUR APPROBATION est toujours relayée en mode tamponné, quel
   * que soit ce drapeau : l'agent a reçu un 202 et sa connexion est fermée depuis
   * longtemps, donc il n'y a personne vers qui faire couler quoi que ce soit.
   */
  stream?: boolean;
}

/**
 * Les en-têtes relayés quand une règle n'en nomme aucun.
 *
 * `accept-encoding` en est délibérément absent, et pas par prudence : `sendGuarded` ne
 * décompresse pas. Un agent qui demanderait `gzip` recevrait un corps compressé lu comme
 * de l'UTF-8 — c'est-à-dire des octets abîmés rendus comme une réponse valide.
 */
export const DEFAULT_FORWARD_HEADERS = ["content-type", "accept"] as const;

/**
 * Les en-têtes qu'aucune règle ne peut faire relayer, même en les nommant.
 *
 * `authorization` est la clé Oathrion de l'agent : la transmettre la divulguerait au
 * fournisseur. Les autres sont recalculés par le transport, ou appartiennent à la
 * relation agent↔Oathrion et non à la relation Oathrion↔fournisseur.
 */
export const NEVER_FORWARDED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "expect",
  "accept-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export class InterceptRuleError extends Error {
  /**
   * `source` nomme la VARIABLE à corriger, et ce n'est pas cosmétique.
   *
   * Le message portait toujours `OATHRION_INTERCEPTS`, y compris pour une règle venue d'un
   * paquet. Un exploitant à qui l'on dit « corrigez OATHRION_INTERCEPTS » alors que la
   * règle fautive vient de `OATHRION_INTERCEPT_PACKS` ouvre un fichier où il n'y a rien à
   * corriger — et conclut que le message est faux, ce qui est la pire chose qu'un message
   * d'erreur puisse enseigner.
   */
  constructor(message: string, source = "OATHRION_INTERCEPTS") {
    super(`${source}: ${message}`);
    this.name = "InterceptRuleError";
  }
}

/** La requête telle qu'Oathrion l'a reçue, réduite à ce qui sert à décider. */
export interface InterceptedRequest {
  method: string;
  /** Le chemin visé chez le fournisseur, sans l'origine. Toujours commence par `/`. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Le corps parsé, pour EXTRAIRE le verbe, la cible et le montant. `null` si illisible. */
  body: Record<string, unknown> | null;
  /**
   * Le corps BRUT, tel que l'agent l'a envoyé — c'est lui qui part chez le fournisseur.
   *
   * Deux rôles distincts, et les confondre rendait Stripe inutilisable : le relais
   * re-sérialisait l'objet parsé en JSON sous le `content-type` form de l'agent, que
   * Stripe refuse. Une ré-écriture perd aussi l'ordre des clés et la précision numérique.
   *
   * Absent quand la requête n'avait pas de corps, ou quand un appelant interne construit
   * une requête à la main — le relais retombe alors sur une sérialisation du corps parsé.
   */
  rawBody?: string;
}

import { packRules } from "./packs";
import { exponentOf, parseCurrency, type CurrencyCode } from "@shared/money";

function failWith(message: string, source?: string): never {
  throw new InterceptRuleError(
    `${message}\n` +
      `  Expected shape:\n` +
      `  [{"id":"stripe_refunds","destination":"stripe-api","method":"POST",` +
      `"path":"/v1/refunds","action":"refund","target":"body.payment_intent|body.charge",` +
      `"amount":"body.amount","amountUnit":"minor"}]`,
    source,
  );
}

const ID_SHAPE = /^[a-z][a-z0-9_]{2,47}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function parseInterceptRules(env: NodeJS.ProcessEnv = process.env): InterceptRule[] {
  /*
   * LES PAQUETS D'ABORD, LES RÈGLES ÉCRITES À LA MAIN ENSUITE.
   *
   * `OATHRION_INTERCEPT_PACKS=openai,stripe` développe des règles relues et éprouvées pour
   * des outils courants ; `OATHRION_INTERCEPTS` reste la voie pour tout le reste. Les deux
   * se combinent, parce qu'une équipe emploie presque toujours un outil du catalogue ET
   * une API maison.
   *
   * Le développement a lieu ICI plutôt que dans un chemin parallèle, et c'est tout
   * l'intérêt : les paquets traversent exactement les mêmes contrôles que les règles
   * écrites à la main — identifiant unique, verbe au catalogue, source fermée, cohérence
   * des `{captures}` du chemin, destination existante. Un second chemin d'entrée aurait
   * été un second endroit où une règle peut être fausse.
   *
   * L'ORDRE COMPTE : les paquets sont ajoutés en premier, donc une règle écrite à la main
   * qui porterait le même identifiant déclenche le refus d'identifiant dupliqué au lieu
   * d'écraser silencieusement celle du paquet. Un exploitant qui veut changer une règle
   * de paquet doit désactiver le paquet, pas la recouvrir sans s'en apercevoir.
   */
  const fromPacks = packRules(env);

  const raw = env.OATHRION_INTERCEPTS?.trim();
  let written: unknown[] = [];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      failWith("the value is not valid JSON.");
    }
    if (!Array.isArray(parsed)) failWith("the value must be a JSON array.");
    written = parsed;
  }

  /*
   * UN SEUL VALIDATEUR POUR LES DEUX SOURCES, et cette ligne est une correction.
   *
   * La première version appelait `packRules()` puis concaténait le résultat APRÈS la
   * boucle de validation. Les règles de paquet ne traversaient donc AUCUN contrôle — et
   * le commentaire d'à côté affirmait pourtant qu'elles traversaient « exactement les
   * mêmes contrôles ». Une promesse plus large que ce qui était appliqué, écrite de ma
   * main, dans le fichier même qui existe pour empêcher ce genre d'erreur.
   *
   * Le défaut n'était pas théorique : le paquet Google écrivait `{userId}` en camelCase.
   * `NAMED_SEGMENT` n'accepte que des minuscules, donc ce segment n'était PAS une
   * capture — `path.userId` lisait `undefined`, et chaque envoi de courriel aurait été
   * refusé en 422 avec un message parlant de la requête alors que la faute était dans le
   * paquet. Le contrôle qui l'attrape existait déjà ; il ne s'appliquait simplement pas.
   *
   * Les deux sources sont donc fusionnées AVANT la validation. Un paquet est, du point de
   * vue de ce module, une règle écrite à la main qui vient d'ailleurs.
   */
  const entries = [...fromPacks, ...written];

  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const fromPack = index < fromPacks.length;
    const at = fromPack
      ? `pack "${fromPacks[index]!.destination}"`
      : `entry ${String(index - fromPacks.length)}`;
    /*
     * Une règle de paquet fautive est un défaut de CE DÉPÔT, pas de la configuration de
     * l'exploitant. Le message le dit, pour qu'il ouvre un ticket au lieu de chercher
     * dans son environnement.
     */
    const source = fromPack
      ? `OATHRION_INTERCEPT_PACKS (rule shipped by Oathrion — please report it)`
      : "OATHRION_INTERCEPTS";
    /*
     * L'ANNOTATION SUR LA CONSTANTE, et pas seulement sur le retour.
     *
     * TypeScript n'applique le rétrécissement « ne revient jamais » qu'à une constante
     * explicitement typée `(m: string) => never`. Sans elle, chaque `fail(...)` de la
     * boucle cesse d'être un point de sortie pour l'analyse de flot, et vingt lignes
     * plus bas le compilateur croit qu'une valeur peut encore être `null`.
     */
    const fail: (message: string) => never = (message) => failWith(message, source);
    if (typeof entry !== "object" || entry === null) fail(`${at} is not an object.`);
    const e = entry as Record<string, unknown>;

    const id = typeof e.id === "string" ? e.id : "";
    if (!ID_SHAPE.test(id)) fail(`${at} has an invalid id ${JSON.stringify(e.id)}.`);
    if (seen.has(id)) fail(`${at} repeats the id "${id}".`);
    seen.add(id);

    const destination = typeof e.destination === "string" ? e.destination.trim() : "";
    if (!destination) fail(`rule "${id}" names no destination.`);

    const method = typeof e.method === "string" ? e.method.trim().toUpperCase() : "";
    if (!(METHODS as readonly string[]).includes(method)) {
      fail(`rule "${id}" has an invalid method ${JSON.stringify(e.method)}; expected ${METHODS.join(", ")}.`);
    }

    const path = typeof e.path === "string" ? e.path.trim() : "";
    if (!path.startsWith("/")) fail(`rule "${id}": "path" must start with "/".`);
    if (path.includes("..")) fail(`rule "${id}": "path" cannot contain "..".`);

    /*
     * Les segments nommés du motif. Un nom répété est refusé : `/{id}/x/{id}` laisserait
     * `path.id` désigner deux segments différents, et la cible jugée dépendrait de
     * l'ordre d'itération — donc d'un détail d'implémentation.
     */
    const declaredSegments = new Set<string>();
    for (const segment of path.split("/")) {
      const name = capturedName(segment);
      if (name === null) {
        if (segment.includes("{") || segment.includes("}")) {
          fail(
            `rule "${id}": the segment ${JSON.stringify(segment)} looks like a named segment ` +
              `without being one. A named segment is written exactly "{name}", in ` +
              `lowercase, and fills the whole segment.`,
          );
        }
        continue;
      }
      if (declaredSegments.has(name)) {
        fail(`rule "${id}": the named segment "{${name}}" appears twice in "path".`);
      }
      declaredSegments.add(name);
    }

    /*
     * Une source `path.<nom>` dont le motif ne déclare pas `{nom}` est refusée ICI, au
     * démarrage. À l'exécution elle serait `undefined`, donc « cible absente », donc un
     * 422 à chaque appel — un refus correct au mauvais moment, avec un motif qui parle de
     * la requête alors que la faute est dans la configuration.
     */
    const requirePathSegment = (field: string, source: string): void => {
      if (!source.startsWith("path.")) return;
      const name = source.slice("path.".length);
      if (declaredSegments.has(name)) return;
      fail(
        `rule "${id}": "${field}" reads "${source}", but "path" declares no segment ` +
          `"{${name}}". Write the pattern with the named segment, for example ` +
          `"/v1/charges/{${name}}/capture"` +
          (declaredSegments.size > 0
            ? `. Declared segments: ${[...declaredSegments].map((n) => `{${n}}`).join(", ")}.`
            : `. This pattern declares no named segment.`),
      );
    };

    const action = typeof e.action === "string" ? e.action.trim() : "";
    if (!action) fail(`rule "${id}" names no Oathrion verb.`);

    const target = typeof e.target === "string" ? e.target.trim() : "";
    /*
     * PLUSIEURS SOURCES POSSIBLES, séparées par `|`, lues dans l'ordre.
     *
     * Ajouté parce que le vrai Stripe l'exige : un remboursement désigne son paiement par
     * `payment_intent` OU par `charge`, et c'est la première forme que ses bibliothèques
     * emploient aujourd'hui. Une règle limitée à `body.charge` refusait en 422 tout
     * remboursement écrit avec le SDK actuel.
     *
     * Chaque alternative passe exactement les contrôles d'une source seule. Une liste ne
     * relâche rien : elle dit seulement où chercher, et dans quel ordre.
     */
    const alternatives = target.split("|").map((part) => part.trim());
    if (alternatives.length > 4) {
      fail(`rule "${id}": "target" offers ${String(alternatives.length)} sources; 4 at most.`);
    }
    if (new Set(alternatives).size !== alternatives.length) {
      fail(`rule "${id}": "target" names the same source twice.`);
    }
    for (const source of alternatives) {
      if (!SOURCE_SHAPE.test(source)) {
        fail(
          `rule "${id}": "target" is ${JSON.stringify(e.target)}, and ${JSON.stringify(source)} ` +
            `is not a request source. Expected "body.<field>", "query.<field>", ` +
            `"header.<name>" or "path.<segment>", possibly several separated by "|".`,
        );
      }
      requirePathSegment("target", source);
    }

    for (const field of ["amount", "currency"] as const) {
      const value = e[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !SOURCE_SHAPE.test(value)) {
        fail(`rule "${id}": "${field}" is ${JSON.stringify(value)}, which is not a request source.`);
      }
      requirePathSegment(field, value);
    }

    const scale = e.amountScale;
    if (scale !== undefined) {
      if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
        fail(`rule "${id}": "amountScale" must be a strictly positive number.`);
      }
      if (e.amount === undefined) {
        /*
         * Une échelle sans montant est une configuration morte, et la refuser évite
         * surtout l'inverse : un exploitant qui croit avoir déclaré la conversion et qui
         * a oublié le champ sur lequel elle porte.
         */
        fail(`rule "${id}": "amountScale" without "amount" converts nothing.`);
      }
    }

    const unit = e.amountUnit;
    if (unit !== undefined) {
      if (unit !== "minor") {
        fail(`rule "${id}": "amountUnit" is ${JSON.stringify(unit)}; the only accepted value is "minor".`);
      }
      if (scale !== undefined) {
        /*
         * Les deux à la fois : laquelle s'applique ? Refusé plutôt que tranché. Une règle
         * dont l'échelle dépend de l'ordre d'évaluation est une règle que personne ne relit
         * correctement.
         */
        fail(`rule "${id}": "amountUnit" and "amountScale" are mutually exclusive — choose one.`);
      }
      if (e.amount === undefined) {
        fail(`rule "${id}": "amountUnit" without "amount" converts nothing.`);
      }
    }

    const successField = e.successField;
    if (successField !== undefined) {
      if (typeof successField !== "string" || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$/.test(successField)) {
        fail(
          `rule "${id}": "successField" is ${JSON.stringify(successField)}; expected a path ` +
            `in the response JSON, such as "ok" or "result.ok".`,
        );
      }
      if (e.stream === true) {
        /*
         * Refusé au démarrage plutôt qu'ignoré : en flux, le corps part chez l'agent au
         * fil de l'eau, et il n'existe aucun instant où Oathrion l'a entier pour le lire.
         * Accepter les deux laisserait croire que la réussite est vérifiée alors qu'elle
         * ne peut pas l'être.
         */
        fail(`rule "${id}": "successField" and "stream: true" are mutually exclusive — a stream is not read before it is relayed.`);
      }
    }

    const rawStream = e.stream;
    if (rawStream !== undefined && typeof rawStream !== "boolean") {
      /*
       * Refusé plutôt que rendu vrai par coercition. `"false"` est une chaîne non vide,
       * donc vraie : une règle qui croit avoir désactivé le flux l'activerait.
       */
      fail(`rule "${id}": "stream" must be a boolean, not ${JSON.stringify(rawStream)}.`);
    }

    const rawHeaders = e.forwardHeaders;
    let forwardHeaders: string[] | undefined;
    if (rawHeaders !== undefined) {
      if (!Array.isArray(rawHeaders)) {
        fail(`rule "${id}": "forwardHeaders" must be an array of header names.`);
      }
      forwardHeaders = rawHeaders.map((name) => {
        if (typeof name !== "string" || name.trim() === "") {
          fail(`rule "${id}": "forwardHeaders" contains an entry that is not a header name.`);
        }
        const lower = name.trim().toLowerCase();
        if (NEVER_FORWARDED.has(lower)) {
          /*
           * Refusé au DÉMARRAGE plutôt que filtré en silence. Un exploitant qui écrit
           * `authorization` croit avoir autorisé quelque chose ; le lui retirer sans le
           * dire le laisserait chercher pourquoi son API répond 401.
           */
          fail(
            `rule "${id}": "${lower}" can never be relayed. It is either Oathrion's ` +
              `credential or a header the transport recomputes. Remove it from ` +
              `"forwardHeaders".`,
          );
        }
        return lower;
      });
    }

    return {
      id,
      destination,
      method,
      path,
      action,
      target,
      ...(forwardHeaders ? { forwardHeaders } : {}),
      ...(rawStream === true ? { stream: true } : {}),
      ...(typeof e.amount === "string" ? { amount: e.amount } : {}),
      ...(typeof e.currency === "string" ? { currency: e.currency } : {}),
      ...(typeof scale === "number" ? { amountScale: scale } : {}),
      ...(unit === "minor" ? { amountUnit: "minor" as const } : {}),
      ...(typeof successField === "string" ? { successField } : {}),
    };
  });
}

/** Un segment nommé dans un motif : `{charge}` dans `/v1/charges/{charge}/capture`. */
const NAMED_SEGMENT = /^\{([a-z][a-z0-9_]{0,31})\}$/;

/** Le nom capturé par ce segment de motif, ou `null` s'il n'en capture aucun. */
export function capturedName(segment: string): string | null {
  return NAMED_SEGMENT.exec(segment)?.[1] ?? null;
}

/**
 * Le chemin matche-t-il le motif, et qu'a-t-il capturé ?
 *
 * Comparaison segment par segment. `*` et `{nom}` matchent **un seul** segment. Un joker
 * qui traverserait les `/` ferait de `/v1/charges/*` une règle couvrant
 * `/v1/charges/ch_1/refunds` — c'est-à-dire qu'une règle écrite pour lire une charge
 * autoriserait à la rembourser.
 *
 * ## LE DÉCODAGE EST UNE PROTECTION, PAS UNE COMMODITÉ
 *
 * Un segment capturé est décodé (`%5F` → `_`) avant d'être rendu, parce que c'est lui qui
 * servira de CIBLE à la décision. Sans ça, un agent qui connaît une politique de refus
 * sur `ch_interdit` appellerait `/v1/charges/ch%5Finterdit/capture` : Oathrion comparerait
 * la chaîne encodée, ne reconnaîtrait pas la cible refusée, autoriserait — et le
 * fournisseur, lui, décoderait et agirait sur la charge interdite.
 *
 * Un segment qui ne se décode pas (`%zz`) fait ÉCHOUER l'appariement plutôt que d'être
 * rendu tel quel : une cible dont on n'est pas sûr de la valeur n'est pas une cible.
 *
 * Le chemin RELAYÉ reste inchangé, octet pour octet. Décoder ce qui part changerait la
 * requête du client, ce qui n'est pas le rôle d'un pare-feu ; décoder ce qu'on JUGE est
 * la seule façon de juger la même chose que le fournisseur.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;

  const captured: Record<string, string> = {};
  for (const [index, segment] of want.entries()) {
    const actual = got[index] ?? "";
    const name = capturedName(segment);
    if (name !== null) {
      if (actual === "") return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        return null;
      }
      captured[name] = decoded;
      continue;
    }
    if (segment === "*") {
      if (actual === "") return null;
      continue;
    }
    if (segment !== actual) return null;
  }
  return captured;
}

/** Le même appariement, sans les captures. */
export function pathMatches(pattern: string, path: string): boolean {
  return matchPath(pattern, path) !== null;
}

/** La première règle qui reconnaît cette requête, ou `null`. */
export function matchRule(rules: readonly InterceptRule[], request: InterceptedRequest): InterceptRule | null {
  return (
    rules.find(
      (rule) => rule.method === request.method.toUpperCase() && pathMatches(rule.path, request.path),
    ) ?? null
  );
}

export class ExtractionError extends Error {}

/** Lit `body.a.b`, `query.x`, `header.y` ou `path.nom` dans la requête. */
function read(
  source: string,
  request: InterceptedRequest,
  captured: Record<string, string>,
): unknown {
  const dot = source.indexOf(".");
  const kind = source.slice(0, dot);
  const key = source.slice(dot + 1);

  /*
   * `path.<nom>` lit le segment capturé par `{nom}` dans le motif de la règle, déjà
   * décodé par `matchPath`. Sans cette source, une API REST qui met la ressource dans
   * l'URL — `POST /v1/charges/{charge}/capture`, `POST /repos/{owner}/{repo}/issues` —
   * n'était pas gouvernable du tout : la cible était introuvable et Oathrion refusait en
   * 422. C'était la moitié des APIs REST hors de portée.
   */
  if (kind === "path") return captured[key];
  if (kind === "query") return request.query[key];
  if (kind === "header") return request.headers[key.toLowerCase()];

  // `body`, avec descente par points : `body.metadata.order_id`.
  let cursor: unknown = request.body;
  for (const part of key.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export interface ExtractedAction {
  action: string;
  target: string;
  metadata: Record<string, unknown>;
}

/**
 * Extrait de la requête ce sur quoi la décision portera.
 *
 * Un champ déclaré et absent est une ERREUR, pas un vide. Décider sur un montant
 * `undefined` reviendrait à juger une action dont on ne connaît pas la taille — et le
 * moteur, lui, verrait une action sans montant, donc sans plafond applicable.
 */
/** Ce que l'extraction a besoin de savoir de l'organisation, et qu'une requête ne dit pas. */
export interface ExtractionContext {
  /**
   * La devise de compte de l'organisation : celle qui s'applique quand la requête n'en
   * porte pas. Indispensable pour une règle `amountUnit: "minor"` dont la requête est
   * muette sur la devise — un remboursement Stripe, par exemple, prend celle de la charge
   * d'origine et REFUSE le paramètre `currency`.
   */
  orgCurrency?: CurrencyCode;
}

export function extractAction(
  rule: InterceptRule,
  request: InterceptedRequest,
  context: ExtractionContext = {},
): ExtractedAction {
  /*
   * Les captures sont recalculées ICI depuis le motif de la règle, et non transmises
   * depuis l'appariement : `extractAction` ne doit pas dépendre d'un appelant qui aurait
   * pensé à les passer. Une règle qui n'a pas matché ne devrait pas arriver ici ; si elle
   * arrive, `captured` est vide et la cible est déclarée absente, ce qui refuse.
   */
  const captured = matchPath(rule.path, request.path) ?? {};
  /*
   * La première source non vide gagne. L'ordre est celui de la règle : un remboursement
   * Stripe qui porterait à la fois `payment_intent` et `charge` est jugé sur le premier
   * nommé, et Stripe, lui, refuse une requête qui porte les deux.
   */
  let rawTarget: unknown = undefined;
  for (const source of rule.target.split("|").map((part) => part.trim())) {
    const value = read(source, request, captured);
    if (typeof value === "string" && value.trim() !== "") {
      rawTarget = value;
      break;
    }
  }
  if (typeof rawTarget !== "string" || rawTarget.trim() === "") {
    throw new ExtractionError(
      `Rule "${rule.id}" reads the target from "${rule.target}", which is missing or empty in ` +
        `this request. Nothing was forwarded: Oathrion does not judge an action whose ` +
        `target it does not know.` +
        /*
         * LE CAS MULTIPART, nommé. Un corps `multipart/form-data` est relayé octet pour
         * octet mais n'est PAS parsé : aucune source `body.` n'y trouve quoi que ce soit.
         * Sans cette phrase, un exploitant qui gouverne un téléversement lit « cible
         * absente » et va chercher dans sa requête ce qui est en fait une limite connue.
         */
        (rule.target.startsWith("body.") && request.body === null
          ? ` The body of this request is not a parsed object — a multipart or ` +
            `binary body is relayed as is but never parsed. Read the target from the URL ` +
            `("path.<segment>"), the query string ("query.<field>") or a header ` +
            `("header.<name>").`
          : ""),
    );
  }

  const metadata: Record<string, unknown> = {};

  if (rule.amount !== undefined) {
    const rawAmount = read(rule.amount, request, captured);
    const numeric = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
    if (!Number.isFinite(numeric)) {
      throw new ExtractionError(
        `Rule "${rule.id}" reads the amount from "${rule.amount}", which does not contain a ` +
          `number (${JSON.stringify(rawAmount)}). Nothing was forwarded: a cap does not ` +
          `apply to an unreadable value.`,
      );
    }
    metadata.amount = rule.amountScale === undefined ? numeric : numeric / rule.amountScale;
  }

  if (rule.currency !== undefined) {
    const rawCurrency = read(rule.currency, request, captured);
    if (typeof rawCurrency === "string" && rawCurrency.trim() !== "") {
      metadata.currency = rawCurrency.trim().toUpperCase();
    }
  }

  /*
   * L'UNITÉ MINEURE, CONVERTIE SELON LA DEVISE — et jamais selon une devise devinée.
   *
   * La devise de la requête si elle en porte une, sinon celle de l'organisation. Si
   * aucune des deux n'est connue du registre, la requête est REFUSÉE : diviser par 100
   * « par défaut » est exactement le défaut que cette option corrige, puisque le franc
   * CFA n'a pas de subdivision et que 100 000 XOF seraient jugés comme 1 000.
   */
  if (rule.amountUnit === "minor" && typeof metadata.amount === "number") {
    const declared = typeof metadata.currency === "string" ? metadata.currency : undefined;
    const currency = parseCurrency(declared ?? context.orgCurrency);
    if (currency === null) {
      throw new ExtractionError(
        `Rule "${rule.id}" expresses the amount in minor units, but its currency ` +
          (declared !== undefined
            ? `(${JSON.stringify(declared)}) is not a currency Oathrion knows`
            : `is neither in the request nor known for the organization`) +
          `. Nothing was forwarded: Oathrion does not guess how many decimals a currency has.`,
      );
    }
    metadata.amount = metadata.amount / 10 ** exponentOf(currency);
  }

  return { action: rule.action, target: rawTarget.trim(), metadata };
}
