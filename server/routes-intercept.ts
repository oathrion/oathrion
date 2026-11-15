/**
 * Le proxy d'interception — Oathrion en amont des APIs du client.
 *
 *   POST /api/v1/intercept                       enveloppe explicite
 *   ANY  /api/v1/intercept/:destination/*        transparent : changez l'URL de base
 *
 * ## LES DEUX MODES, ET POURQUOI LES DEUX
 *
 * **Transparent.** L'agent pointe son client HTTP sur Oathrion au lieu de l'API, et rien
 * d'autre ne change : `https://api.stripe.com/v1/refunds` devient
 * `https://placet.acme/api/v1/intercept/stripe-api/v1/refunds`, même méthode, même corps.
 * C'est le mode à préférer — le code de l'agent ne change pas, seule son URL de base.
 *
 * **Enveloppe.** L'agent POSTe un objet décrivant la requête. Utile quand l'agent ne peut
 * pas changer d'URL de base (un SDK qui la code en dur), et pour un client qui veut voir
 * la décision avant de la subir.
 *
 * Les deux traversent EXACTEMENT le même code à partir de la ligne où la requête est
 * normalisée : deux chemins de décision seraient deux chances de divergence.
 *
 * ## L'ORDRE DES OPÉRATIONS EST LA PROPRIÉTÉ DE SÉCURITÉ
 *
 *   1. Authentifier l'agent — par la clé d'API, jamais par un champ du corps.
 *   2. Reconnaître la requête parmi les règles déclarées. AUCUNE correspondance → refus.
 *   3. EXTRAIRE de la requête le verbe, la cible, le montant. L'agent n'annonce rien.
 *   4. Déposer la requête brute en mémoire, sous un jeton.
 *   5. Confier la décision à la passerelle, qui relaie si et seulement si ALLOW.
 *   6. Rendre la réponse du fournisseur, ou le refus, ou l'identifiant d'approbation.
 *
 * L'étape 3 est ce qui sépare un pare-feu d'un journal. Un agent qui déclarerait
 * lui-même « refund de 75 USD » choisirait la règle qui le gouverne.
 *
 * ## CE QUE CE PROXY NE PEUT PAS FAIRE, ET IL FAUT LE LIRE
 *
 * Il ne gouverne que le trafic qui PASSE par lui. Un agent qui peut joindre
 * `api.stripe.com` directement n'est pas intercepté, et aucun logiciel ne peut l'en
 * empêcher depuis l'intérieur de ce processus.
 *
 * Ce qui rend le contournement *impossible* plutôt que déconseillé est une propriété du
 * déploiement : **le credential du fournisseur vit dans le coffre d'Oathrion et nulle part
 * ailleurs.** Un agent qui n'a pas la clé ne peut pas appeler l'API, qu'il connaisse son
 * adresse ou non. C'est pour cela que ce proxy injecte le credential au lieu de le
 * relayer : si l'agent le portait, le proxy ne serait qu'une politesse.
 */

import { DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS, isDatabaseUnavailable } from "./database-unavailable";
import type { CurrencyCode } from "@shared/money";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { OrganizationId } from "@shared/tenancy";

import { requireIdentity } from "./auth";
import { resolveDestination } from "./authority/destinations";
import { serverTimingHeader, timed, timedSync } from "./observability/timing";
import { rawString } from "./intercept/raw-body";
import type { AgentGateway } from "./gateway/agent-gateway";
import type { PendingInterceptionStore } from "./intercept/pending-store";
import {
  awaitStream,
  releaseStream,
  INTERCEPT_REF_KEY,
  putPending,
  responseHeadersFor,
  takePending,
  takeResponse,
  type PendingForward,
} from "./intercept/forward";
import { approvalWindowMs } from "./intercept/pending-store";
import {
  DEFAULT_FORWARD_HEADERS,
  extractAction,
  ExtractionError,
  matchRule,
  type InterceptRule,
  type InterceptedRequest,
} from "./intercept/rules";
import { randomUUID } from "node:crypto";
import { wireHeaderNames, type WireHeader } from "@shared/wire-headers";
import { ERROR_CODES } from "@shared/error-codes";
import { sendApiError } from "./api-error";
import { QuotaExceededError } from "./quotas";
import { increment } from "./observability/metrics";

export interface InterceptRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  fail: (res: Response, status: number, message: string, code?: string) => void;
  requireCapability: (capability: "read" | "execute" | "approve" | "manage") => RequestHandler;
  decisionRateLimit: RequestHandler;
  /** Les règles déclarées, lues une fois au démarrage. */
  rules: readonly InterceptRule[];
  scopeFor: (req: Request) => {
    gateway: AgentGateway;
    pendingStore: PendingInterceptionStore;
    /** La devise de compte du locataire, pour convertir un montant en unité mineure. */
    currency: CurrencyCode;
  };
  /** L'agent qui agit, résolu depuis le credential. `null` quand la réponse est déjà écrite. */
  actingAgent: (req: Request, res: Response, claimed: string | null) => string | null;
}

/**
 * L'enveloppe du mode explicite.
 *
 * `strictObject` : un champ inconnu est refusé. Un client qui enverrait `action` ou
 * `amount` en croyant les choisir doit l'apprendre par un 400 — ces champs sont EXTRAITS
 * de la requête, et les accepter ici rouvrirait la porte que l'extraction ferme.
 */
const envelopeSchema = z.strictObject({
  destination: z.string().min(1).max(64),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(2048),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Optionnel : l'agent, quand la clé d'API n'est pas liée à un agent. */
  agentId: z.string().min(1).optional(),
});

/** Les en-têtes de la requête entrante, réduits aux noms simples et aux valeurs scalaires. */
function incomingHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
    else if (Array.isArray(value)) out[name.toLowerCase()] = value.join(", ");
  }
  return out;
}

function queryOf(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.query)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * Comment le credential du fournisseur est injecté, par destination.
 *
 * Déclaré dans l'environnement et non deviné : `Authorization: Bearer <clé>` couvre
 * beaucoup d'APIs et pas toutes — Stripe veut `Authorization: Bearer`, certaines veulent
 * `X-API-Key: <clé>` nu. Un gabarit explicite évite d'avoir à supposer, et une supposition
 * fausse produit un 401 du fournisseur que l'exploitant lira comme « ma clé est mauvaise ».
 */
function credentialShape(
  destinationId: string,
  env: NodeJS.ProcessEnv,
): { header: string; template: string } {
  const raw = env[`OATHRION_INTERCEPT_AUTH_${destinationId.replace(/-/g, "_").toUpperCase()}`]?.trim();
  if (!raw || !raw.includes(":")) return { header: "authorization", template: "Bearer {secret}" };
  const at = raw.indexOf(":");
  return { header: raw.slice(0, at).trim().toLowerCase(), template: raw.slice(at + 1).trim() };
}

export function registerInterceptRoutes(app: Express, deps: InterceptRouteDeps): void {
  const { handle, fail } = deps;

  /**
   * Le cœur, partagé par les deux modes.
   *
   * Rend la réponse HTTP et rien d'autre : toute la décision appartient à la passerelle.
   */
  async function intercept(
    req: Request,
    res: Response,
    destinationId: string,
    request: InterceptedRequest,
    claimedAgent: string | null,
  ): Promise<unknown> {
    return interceptTimed(req, res, destinationId, request, claimedAgent);
  }

  async function interceptTimed(
    req: Request,
    res: Response,
    destinationId: string,
    request: InterceptedRequest,
    claimedAgent: string | null,
  ): Promise<unknown> {
    const identity = requireIdentity(req);
    const organizationId = identity.organizationId as OrganizationId;

    /* 1. L'agent vient du credential. Un champ du corps ne peut que le répéter. */
    const agentId = deps.actingAgent(req, res, claimedAgent);
    if (agentId === null) return undefined;

    /* 2. Reconnaître — ou refuser. Il n'y a pas de branche « sinon, transmettre ». */
    const rule = timedSync("match", () => matchRule(deps.rules, request));
    if (!rule) {
      /*
       * 403 et non 404 : la requête a été comprise et refusée. Le motif nomme ce qu'il
       * faut déclarer, parce qu'un refus qu'on ne sait pas corriger pousse à désactiver
       * le proxy.
       */
      increment("oathrion_intercept_refusals_total", { reason: "no_rule" });
      return fail(
        res,
        403,
        `No interception rule matches ${request.method} ${request.path}. ` +
          `Oathrion refuses what it cannot judge: nothing was forwarded. Declare this ` +
          `route in OATHRION_INTERCEPTS to make it governable.`,
        "intercept_no_rule",
      );
    }

    if (rule.destination !== destinationId) {
      increment("oathrion_intercept_refusals_total", { reason: "destination_mismatch" });
      return fail(
        res,
        403,
        `Rule "${rule.id}" governs the destination "${rule.destination}", not ` +
          `"${destinationId}". Nothing was forwarded.`,
        "intercept_destination_mismatch",
      );
    }

    /* La destination passe par le registre existant : allowlist et règles d'adresse. */
    let destination;
    try {
      destination = resolveDestination(rule.destination, process.env, organizationId);
    } catch (error) {
      increment("oathrion_intercept_refusals_total", { reason: "destination_unavailable" });
      return fail(
        res,
        403,
        `The destination "${rule.destination}" is not available for this organization: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "intercept_destination_unavailable",
      );
    }

    /* 3. EXTRAIRE. L'agent n'a rien annoncé ; c'est la requête qui parle. */
    let extracted;
    try {
      /*
       * La devise de l'organisation accompagne l'extraction : une règle en unité mineure
       * dont la requête ne nomme pas sa devise (un remboursement Stripe) en a besoin pour
       * savoir s'il faut diviser par 100 ou par 1. La portée est en cache, donc l'appeler
       * ici plutôt qu'à l'étape 5 ne coûte rien.
       */
      const orgCurrency = deps.scopeFor(req).currency;
      extracted = timedSync("extract", () => extractAction(rule, request, { orgCurrency }));
    } catch (error) {
      if (error instanceof ExtractionError) {
        increment("oathrion_intercept_refusals_total", { reason: "unreadable_request" });
        return fail(res, 422, error.message, "intercept_unreadable_request");
      }
      throw error;
    }


    /*
     * LE COFFRE N'EST PAS OUVERT ICI, et c'est une correction apportée par un garde.
     *
     * Cette route l'ouvrait avant la décision : une requête BLOQUÉE faisait donc
     * déchiffrer un secret du fournisseur — jamais envoyé, mais en clair en mémoire sans
     * qu'aucune autorisation ne l'ait justifié. `connector-single-path.test.ts` exige que
     * `vault.open()` n'ait qu'un appelant, dans `Tool.run()`. Il avait raison : le relais
     * ouvre le coffre lui-même, après un ALLOW, et la route n'a plus à connaître de clé.
     */
    const ref = randomUUID();
    const shape = credentialShape(rule.destination, process.env);
    const forward: PendingForward = {
      destination: destination.destination,
      destinationId: rule.destination,
      request,
      credentialHeader: shape.header,
      credentialTemplate: shape.template,
      /*
       * L'allowlist de LA RÈGLE, figée au moment de la décision. Entre le dépôt et la
       * reprise — une approbation humaine dure des minutes — `OATHRION_INTERCEPTS` peut
       * avoir changé : la requête doit partir avec la permission en vigueur quand elle a
       * été jugée, pas avec celle du moment où un humain clique.
       */
      forwardHeaders: rule.forwardHeaders ?? [...DEFAULT_FORWARD_HEADERS],
      /* Où lire la réussite dans la réponse, quand le statut HTTP ne suffit pas (Slack). */
      ...(rule.successField !== undefined ? { successField: rule.successField } : {}),
      /*
       * Le mode de relais voyage avec la requête garée, pour la même raison que
       * l'allowlist : c'est la règle telle qu'elle était au moment de la DÉCISION qui doit
       * s'appliquer.
       *
       * Et c'est la ligne qui manquait : sans elle, `forward.stream` était toujours
       * indéfini et la voie en flux n'était jamais empruntée. Tout passait par le mode
       * tamponné — en rendant un `content-type: text/event-stream` parfaitement crédible,
       * donc sans rien casser de visible. Ce sont la MESURE DE TEMPS et l'absence de
       * `streamed` dans le reçu qui l'ont dit ; aucune assertion sur le contenu ne
       * l'aurait vu, puisque le contenu est le même dans les deux modes.
       */
      ...(rule.stream === true ? { stream: true } : {}),
    };

    try {
      putPending(ref, forward);
    } catch (error) {
      increment("oathrion_intercept_refusals_total", { reason: "overloaded" });
      return fail(res, 503, error instanceof Error ? error.message : String(error), "intercept_overloaded");
    }

    /* 5. La décision, et le relais, appartiennent à la passerelle. */
    const scoped = timedSync("scope", () => deps.scopeFor(req));
    const pending = timed("gateway", () => scoped.gateway.execute({
      agentId,
      action: extracted.action,
      target: extracted.target,
      /*
       * `interceptRule` est persisté avec l'exécution, et c'est voulu : savoir QUELLE
       * règle du pare-feu a jugé une requête est exactement ce qu'un auditeur demande, et
       * c'est aussi ce qui permet à la console de distinguer un appel intercepté d'un
       * appel passé par `/api/execute`. Le jeton de relais y figure aussi — c'est un UUID
       * déjà consommé, sans valeur pour qui le relit.
       *
       * Ce qui N'Y FIGURE PAS : le corps et les en-têtes de la requête. Voir
       * `server/intercept/forward.ts`.
       */
      metadata: { ...extracted.metadata, interceptRule: rule.id, [INTERCEPT_REF_KEY]: ref },
      actor: identity.name,
    }));

    /*
     * ──────────────────── LE RELAIS EN FLUX ────────────────────
     *
     * Pour une règle qui déclare `stream: true`, la réponse du fournisseur est relayée
     * au fil de l'eau. C'est ce qui rend Oathrion utilisable devant une API de modèle :
     * tamponner une réponse `text/event-stream`, c'est supprimer le streaming que
     * l'application de l'utilisateur attend.
     *
     * ## La course, et pourquoi il en faut une
     *
     * `execute()` ne rend qu'à la FIN du transfert — c'est voulu, le reçu doit porter les
     * octets réellement passés. Mais la route doit commencer à relayer bien avant. Elle
     * attend donc le PREMIER des deux : le passage de main (les en-têtes du fournisseur
     * sont arrivés), ou la fin de l'exécution (il n'y aura pas de flux — décision BLOCK,
     * approbation retenue, relais en échec, ou simplement une règle sans `stream`).
     *
     * Rien n'est contourné : le passage de main n'existe que si `run()` a été atteint,
     * donc après un ALLOW et la consommation du grant. La course porte sur l'ordre
     * d'arrivée de deux nouvelles, pas sur l'ordre des contrôles.
     */
    let streamed = false;
    if (rule.stream === true) {
      try {
        const handoff = await Promise.race([
          awaitStream(ref),
          /* Les deux issues de l'exécution valent « pas de flux » ; aucune ne doit rejeter ici. */
          pending.then(
            () => null,
            () => null,
          ),
        ]);

        if (handoff) {
          /*
           * TOUS les en-têtes avant le premier octet : une fois le flux commencé, plus
           * rien ne peut être posé. C'est pour ça que l'identifiant d'exécution et
           * l'injection du credential voyagent dans le passage de main — à cet instant la
           * route n'a pas encore le résultat de la passerelle.
           */
          for (const [name, value] of Object.entries(responseHeadersFor(handoff.headers))) {
            res.setHeader(name, value);
          }
          setWire(res, "decision", "ALLOW");
          setWire(res, "rule", rule.id);
          if (handoff.executionId) setWire(res, "executionId", handoff.executionId);
          setWire(res, "credentialInjected", handoff.credentialInjected ? "true" : "false");
          const timing = serverTimingHeader();
          if (timing !== null) res.setHeader("server-timing", timing);
          /* Le statut du FOURNISSEUR, jamais 200 d'office — même règle qu'en mode tamponné. */
          res.status(handoff.status);
          /*
           * Vidés tout de suite : un client qui attend des événements doit recevoir les
           * en-têtes avant le premier événement, sinon il reste bloqué sur une réponse
           * qu'il croit absente.
           */
          res.flushHeaders();

          streamed = true;
          await new Promise<void>((resolve) => {
            let finished = false;
            const settle = () => {
              if (finished) return;
              finished = true;
              resolve();
            };
            /*
             * `close` sur la réponse couvre le cas qui compte : l'agent raccroche au
             * milieu. Le `PassThrough` est alors détruit, le transport coupe l'amont, et
             * `completion` rend « tronqué » — donc le reçu dira ce qui s'est passé plutôt
             * que de rester ouvert.
             */
            res.on("close", () => {
              if (!handoff.body.destroyed) handoff.body.destroy();
              settle();
            });
            handoff.body.on("error", settle);
            handoff.body.pipe(res).on("finish", settle);
          });
        }
      } finally {
        /*
         * Toujours : si la course a été perdue et qu'un flux a été publié entre-temps,
         * `releaseStream` le détruit. L'abandonner laisserait le fournisseur émettre vers
         * un tampon que personne ne lit.
         */
        releaseStream(ref);
      }
    }

    /*
     * ──────────── POURQUOI CET `await` EST DANS UN `try` ────────────
     *
     * Il ne l'était pas, et c'est la cause du défaut A1 : un passage de charge de 2 451
     * appels relayés a produit UN 500 **sans en-tête de décision**. Le symptôme désignait
     * exactement cette ligne. `gateway.execute()` n'attrape rien en interne — ni
     * `decide()`, qui écrit en base et applique les quotas, ni `dispatch()` — donc un
     * échec de base transitoire, un plafond de quota atteint ou une contention d'écriture
     * remontait jusqu'au gestionnaire générique.
     *
     * LE DÉFAUT N'EST PAS LA CAUSE RACINE, C'EST LA RÉPONSE. Un 500 nu ne dit ni la
     * décision, ni — et c'est le pire — si la requête est PARTIE. Pour un pare-feu de
     * gouvernance, « je ne sais pas si votre remboursement a été envoyé » est la plus
     * mauvaise réponse possible : l'agent ne peut ni réessayer sans risque de doublon, ni
     * renoncer sans risque de perte.
     *
     * Or Oathrion PEUT répondre à cette question. `takeResponse(ref)` ne contient quelque
     * chose que si le relais a effectivement reçu une réponse du fournisseur. On le lit
     * donc, et on dit laquelle des deux situations s'est produite au lieu de laisser
     * deviner. Le `ref` est journalisé pour que l'occurrence suivante soit rattachable à
     * son exécution — c'est ce qui manquait pour diagnostiquer celle-ci.
     */
    let result;
    try {
      result = await pending;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      /*
       * Lu AVANT toute autre chose : la table en mémoire est vidée par la lecture, et
       * c'est la seule preuve disponible de ce qui est réellement parti.
       */
      const reached = takeResponse(ref);
      releaseStream(ref);
      takePending(ref);

      /*
       * Journalisé en entier côté serveur, avec le jeton de relais : c'est ce qui
       * permettra de rattacher la prochaine occurrence à son exécution. Le message
       * RENDU, lui, ne porte pas la cause — elle vient d'une erreur interne et pourrait
       * nommer un détail d'infrastructure.
       */
      console.error(
        `[intercept] the gateway failed for relay ${ref} (rule ${rule.id}, ` +
          `destination ${rule.destination}): ${detail}`,
      );

      if (streamed) {
        /*
         * Les en-têtes et une partie du corps sont déjà partis : on ne peut plus rien
         * annoncer. La connexion est coupée, ce qui est la seule façon de dire à un
         * client en flux que la suite n'arrivera pas — un flux qui s'arrête proprement
         * se lit comme un flux complet.
         */
        res.destroy();
        return undefined;
      }

      /*
       * UN QUOTA ATTEINT N'EST PAS UNE PANNE. `decide()` lève `QuotaExceededError` AVANT
       * tout envoi : rien n'est parti, et la cause est une décision de configuration que
       * le client doit connaître — c'est ce que dit le reste de l'API (429 ou 409,
       * `quota_exceeded`, la limite, le compteur et sa remise à zéro). Le relais rendait
       * ici « 500 : la décision n'a pas pu être enregistrée » : une passe d'endurance de
       * 12 h l'a fait 303 273 fois après le 100 000e appel du mois (journal §5.25). Un
       * client y aurait lu « Oathrion est tombé » et aurait réessayé en boucle.
       */
      if (reached === null && error instanceof QuotaExceededError) {
        if (error.resetAt !== null) {
          res.setHeader("Retry-After", String(Math.max(Math.ceil((Date.parse(error.resetAt) - Date.now()) / 1000), 1)));
        }
        increment("oathrion_intercept_refusals_total", { reason: "quota_exceeded" });
        return sendApiError(res, error.status, error.message, ERROR_CODES.quotaExceeded, {
          forwarded: false,
          counter: error.counter,
          limit: error.limit,
          used: error.used,
          resetAt: error.resetAt,
          interception: { rule: rule.id, destination: rule.destination, ref },
        });
      }

      increment("oathrion_intercept_refusals_total", { reason: "gateway_failed" });
      /*
       * 503 SEULEMENT quand rien n'est parti ET que la cause est une base injoignable :
       * le réessai est alors sûr, et `Retry-After` le dit en langage HTTP (relevé en
       * coupant PostgreSQL sous trafic, docs/STRESS-TEST-LOG.md). Si la requête a atteint
       * le fournisseur, on garde 500 : un 503 inviterait au réessai, donc au doublon.
       */
      const retrySafe = reached === null && isDatabaseUnavailable(error);
      if (retrySafe) res.setHeader("Retry-After", String(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS));
      return res.status(retrySafe ? 503 : 500).json({
        error: "intercept_gateway_failed",
        code: "gateway_failed",
        /*
         * LA SEULE PHRASE QUI COMPTE POUR L'APPELANT : la requête est-elle partie ?
         * `forwarded` est un booléen établi par une observation, pas une supposition.
         */
        forwarded: reached !== null,
        message:
          reached !== null
            ? `The request WAS FORWARDED to the provider (it answered ${String(reached.status)}), ` +
              `but Oathrion could not finish recording the decision. DO NOT RETRY ` +
              `as is: the effect has probably happened. Relay reference ${ref}.`
            : `Oathrion did NOT forward the request: the decision could not be recorded. ` +
              `Nothing reached the provider, retrying is safe. Relay reference ${ref}.`,
        interception: { rule: rule.id, destination: rule.destination, ref },
      });
    }

    /*
     * La réponse est déjà partie, en-têtes et corps. Tout ce qui suit l'écrirait une
     * seconde fois ; le reçu, lui, vient d'être écrit par la passerelle avec les octets
     * réellement passés.
     */
    if (streamed) return undefined;

    const common = {
      interception: {
        rule: rule.id,
        destination: rule.destination,
        method: request.method,
        path: request.path,
        action: extracted.action,
        target: extracted.target,
        /* Ce que la décision a pesé, donc ce qu'un auditeur doit voir. */
        evaluated: extracted.metadata,
      },
      decision: result.decision,
      reason: result.reason,
      policyId: result.policyId,
      policyName: result.policyName,
      risk: result.riskLevel,
      executionId: result.executionId,

    };

    /*
     * LES EN-TÊTES DE GOUVERNANCE SUR TOUTES LES VOIES JUGÉES, et pas seulement sur
     * l'autorisation.
     *
     * `docs/firewall.md` promet « trois en-têtes de gouvernance sur chaque réponse
     * relayée, lisibles sans parser le corps ». C'était faux pour un BLOCK et pour une
     * approbation en attente : seule la voie ALLOW les posait. Un intégrateur qui lit la
     * promesse écrit `if (headers['x-oathrion-decision'] === 'BLOCK')`, et cette condition
     * ne se déclenchait jamais.
     *
     * C'est sur le REFUS que l'en-tête sert le plus. Sans lui, un 403 d'Oathrion et un 403
     * que le fournisseur a lui-même rendu — relayé tel quel sur la voie autorisée — se
     * ressemblent, et l'agent ne peut les distinguer qu'en analysant le corps. Avec lui,
     * le premier porte `BLOCK` et le second `ALLOW` : la question est tranchée par un
     * en-tête.
     *
     * Posés ICI, avant les trois sorties jugées, pour qu'aucune ne puisse les oublier.
     */
    setWire(res, "decision", result.decision);
    setWire(res, "rule", rule.id);
    if (result.executionId) setWire(res, "executionId", result.executionId);

    if (result.decision === "BLOCK") {
      /*
       * 403, et la requête n'est jamais partie. L'entrée en attente expirera : elle
       * n'est pas reprise, parce que `run()` n'a pas été atteint.
       */
      return res.status(403).json({ ...common, forwarded: false, code: "blocked_by_policy" });
    }

    if (result.decision === "APPROVAL_REQUIRED") {
      /*
       * LA REQUÊTE EST GARÉE DANS LE SAS PERSISTÉ, et c'est ici — et seulement ici — que
       * ce produit écrit un corps de requête.
       *
       * La `Map` du processus a un TTL de soixante secondes : mesuré, une approbation
       * rendue après une minute trouvait « la requête n'est plus disponible », et l'appel
       * de l'agent était perdu. Un redémarrage les effaçait toutes, et sur deux
       * instances, approuver sur l'une ne relâchait pas une requête garée sur l'autre.
       *
       * Un ALLOW ne passe pas par là : il est synchrone, la mémoire suffit, et rien n'est
       * écrit. La voie lente n'est payée que quand un humain entre dans la boucle.
       *
       * Si le scellement échoue — pas de `OATHRION_KEK` — on répond 503 plutôt que 202 :
       * annoncer une approbation en attente pour une requête qu'on n'a pas gardée serait
       * la promesse la plus coûteuse de cette route.
       */
      const parked = takePending(ref);
      if (parked) {
        try {
          await scoped.pendingStore.purgeExpired();
          await scoped.pendingStore.put({
            ref,
            executionId: result.executionId ?? "",
            forward: parked,
          });
        } catch (error) {
          return fail(
            res,
            503,
            `The action was held for approval, but the request could NOT be ` +
              `stored: ${error instanceof Error ? error.message : String(error)}. ` +
              `Nothing will be forwarded even after approval. Declare OATHRION_KEK, then ` +
              `ask the agent to retry.`,
            "intercept_park_failed",
          );
        }
      }

      return res.status(202).json({
        ...common,
        forwarded: false,
        code: "approval_required",
        approvalId: result.approvalId,
        /*
         * Le délai réel laissé à l'humain, rendu à l'appelant : un agent qui réessaie
         * peut décider s'il attend ou s'il abandonne, sans deviner.
         */
        approvalWindowMs: approvalWindowMs(),
      });
    }

    const toolResult = (result.toolResult ?? {}) as Record<string, unknown>;

    /*
     * Dit sans détour, et lu DANS LE RÉSULTAT DU RELAIS : si Oathrion n'a pas injecté le
     * credential, c'est que l'agent détient encore la clé, donc qu'il pourrait appeler
     * l'API sans passer ici. L'information ne peut venir que du relais, puisque c'est lui
     * qui ouvre le coffre.
     */
    const credentialInjected = toolResult.credentialInjected === true;

    if (result.succeeded !== true && toolResult.dispatched !== true) {
      /* Autorisé, et pourtant rien n'est parti : le motif du relais, tel quel. */
      return res.status(502).json({
        ...common,
        forwarded: false,
        code: typeof toolResult.reason === "string" ? toolResult.reason : "forward_failed",
        detail: typeof result.toolResult?.summary === "string" ? result.toolResult.summary : undefined,
      });
    }

    /*
     * LA RÉPONSE DU FOURNISSEUR, REPRISE DANS LA TABLE EN MÉMOIRE.
     *
     * Elle ne vient PAS de `toolResult` : ce champ est persisté, et y mettre le corps du
     * fournisseur revenait à écrire en base l'objet client — adresse, nom, fin de numéro
     * de carte. Voir `server/intercept/forward.ts`. Ici elle est reprise une fois, rendue,
     * et oubliée.
     *
     * Le statut est celui du fournisseur, pas 200 : un agent qui reçoit 200 pour un 422
     * de Stripe croirait son remboursement passé. Le corps est rendu brut, parce que le
     * réécrire ferait d'Oathrion un transformateur de contenu qu'il n'est pas.
     */
    const forwarded = takeResponse(ref);
    const status = forwarded?.status ?? (typeof toolResult.status === "number" ? toolResult.status : 200);
    const headers = responseHeadersFor(forwarded?.headers ?? {});
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);

    /*
     * Les trois en-têtes de gouvernance sont DÉJÀ POSÉS plus haut, pour les trois voies
     * jugées. Les réécrire ici serait une seconde écriture au même en-tête — deux
     * endroits à tenir d'accord le jour où la valeur change, et c'est précisément la
     * redondance qu'un mutant a reprochée au `Referrer-Policy` du SSO.
     *
     * Celui-ci, en revanche, n'appartient qu'à la voie autorisée : il n'y a pas de
     * credential à injecter dans une requête qui ne part pas.
     */
    setWire(res, "credentialInjected", credentialInjected ? "true" : "false");
    /*
     * `Server-Timing`, et seulement si l'exploitant l'a demandé. Posé ici, sur la voie
     * AUTORISÉE : c'est celle dont la latence compte, puisque c'est elle qui est sur le
     * chemin critique de la production du client.
     */
    const timing = serverTimingHeader();
    if (timing !== null) res.setHeader("server-timing", timing);
    /*
     * Le corps vient de `forwarded`, jamais de `toolResult` : ce dernier est persisté.
     * Cette ligne lisait `toolResult.responseBody` et a survécu au déplacement — le
     * harnais l'a dit en voyant un corps vide arriver chez l'agent, ce qu'aucun contrôle
     * de discrétion n'aurait signalé.
     */
    return res.status(status).send(forwarded?.body ?? "");
  }

  /** Mode enveloppe. */
  app.post(
    "/api/intercept",
    deps.requireCapability("execute"),
    deps.decisionRateLimit,
    handle(async (req, res) => {
      const parsed = envelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(
          res,
          400,
          parsed.error.issues[0]?.message ?? "Invalid interception envelope.",
          "intercept_envelope_invalid",
        );
      }
      const { destination, method, path, query, headers, body, agentId } = parsed.data;
      if (!path.startsWith("/") || path.includes("..")) {
        return fail(res, 400, '"path" must start with "/" and must not contain "..".', "intercept_bad_path");
      }
      /*
       * Mode enveloppe : le corps est un objet JSON fourni par l'appelant, donc le
       * « brut » est sa sérialisation — il n'y a pas d'octets d'origine à préserver.
       */
      const envelopeBody = body ?? null;
      return intercept(
        req,
        res,
        destination,
        {
          method,
          path,
          query: query ?? {},
          headers: headers ?? {},
          body: envelopeBody,
          ...(envelopeBody === null ? {} : { rawBody: JSON.stringify(envelopeBody) }),
        },
        agentId ?? null,
      );
    }),
  );

  /**
   * Mode transparent. `/api/intercept/<destination>/<le reste>` → `<origine>/<le reste>`.
   *
   * `app.all` et non `app.post` : un proxy doit relayer la méthode que l'agent a choisie.
   * Celles qui ne sont pas dans la liste du schéma n'ont aucune règle possible, donc
   * elles tombent sur le refus « aucune règle » — ce qui est le bon résultat.
   */
  app.all(
    /^\/api\/intercept\/([a-z0-9-]{3,64})(\/.*)?$/,
    deps.requireCapability("execute"),
    deps.decisionRateLimit,
    handle(async (req, res) => {
      const match = /^\/api\/intercept\/([a-z0-9-]{3,64})(\/.*)?$/.exec(req.path);
      if (!match) return fail(res, 404, "Not found", "not_found");
      const destinationId = match[1]!;
      const path = match[2] ?? "/";
      if (path.includes("..")) {
        return fail(res, 400, 'The path cannot contain "..".', "intercept_bad_path");
      }

      /*
       * `Buffer.isBuffer` EST LA LIGNE QUI COMPTE.
       *
       * Depuis que `express.raw` ramasse les corps que ni JSON ni form ne réclament —
       * c'est ce qui rend un téléversement `multipart` relayable — `req.body` peut être un
       * Buffer. Un Buffer est un objet et n'est pas un tableau : sans ce test, il passait
       * pour un corps PARSÉ, et l'extraction allait chercher `body.charge` dans un tampon
       * d'octets. Elle n'y trouvait rien, et refusait en 422 pour « cible absente » — un
       * motif qui ne nomme pas la vraie cause.
       */
      const body =
        typeof req.body === "object" &&
        req.body !== null &&
        !Array.isArray(req.body) &&
        !Buffer.isBuffer(req.body)
          ? (req.body as Record<string, unknown>)
          : null;

      /*
       * LE CORPS BRUT, capturé par le `verify` des parseurs de `server/index.ts`.
       *
       * C'est lui qui part chez le fournisseur. Le corps parsé ne sert qu'à extraire ce
       * sur quoi la politique statue — et pour une API form-encoded comme celle de
       * Stripe, reconstruire le corps depuis l'objet parsé produisait du JSON sous un
       * en-tête `form`, que le fournisseur refuse.
       */
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      return intercept(
        req,
        res,
        destinationId,
        {
          method: req.method,
          path,
          query: queryOf(req),
          headers: incomingHeaders(req),
          body,
          ...(raw && raw.length > 0 ? { rawBody: rawString(raw) } : {}),
        },
        null,
      );
    }),
  );
}

/**
 * Pose un en-tête du contrat sous ses DEUX noms (`shared/wire-headers.ts`) : le courant,
 * `X-Oathrion-…`, et l'hérité, `X-Placet-…`, qu'un client écrit avant le renommage teste
 * encore.
 */
function setWire(res: Response, name: WireHeader, value: string): void {
  for (const header of wireHeaderNames(name)) res.setHeader(header, value);
}
