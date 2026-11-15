/**
 * Le relais — ce qui part réellement vers l'API du client, et ce qui n'en part pas.
 *
 * ## POURQUOI C'EST UN `Tool` ET PAS UNE ROUTE QUI APPELLE `fetch`
 *
 * Écrire la transmission dans la route serait plus court et ferait d'Oathrion un second
 * chemin vers l'effet, à côté de la passerelle : la politique, le mandat, la file
 * d'approbation, la revendication atomique de l'exécution et la chaîne d'audit
 * s'appliqueraient aux appelants de `/api/execute` et pas à ceux du proxy.
 *
 * Ici le relais est un `Tool`. Son unique entrée publique est `execute()`, atteignable
 * seulement depuis `AgentGateway.dispatch()`, qui ne l'appelle qu'après un ALLOW. Le
 * proxy hérite donc de tout le chemin gouverné sans en recopier une ligne.
 *
 * ## LE CORPS NE TRAVERSE PAS LA BASE DE DONNÉES
 *
 * La requête brute — en-têtes, corps — est déposée dans une table en mémoire, sortie
 * exactement une fois par ce relais, et jamais écrite nulle part. Seuls les champs
 * EXTRAITS (verbe, cible, montant, devise) deviennent des métadonnées d'exécution, parce
 * que ce sont eux que la décision a pesés et qu'un auditeur doit pouvoir relire.
 *
 * Un corps d'API financière contient des noms, des adresses et parfois un numéro de
 * carte. Le mettre dans `metadata` le mettrait dans la trace d'audit, c'est-à-dire dans
 * la table que ce produit promet de pouvoir montrer à un auditeur.
 *
 * ## LES EN-TÊTES QUI NE SONT PAS TRANSMIS, ET POURQUOI CHACUN
 *
 * `authorization` : c'est la clé Oathrion de l'agent. La transmettre à Stripe la
 *   divulguerait à un tiers, et Stripe la refuserait de toute façon. Le credential du
 *   fournisseur vient du coffre, pas de l'agent — c'est ce qui rend le contournement
 *   impossible : un agent qui ne détient pas la clé ne peut pas appeler l'API sans Oathrion.
 * `host`, `content-length`, `connection`, `transfer-encoding` : recalculés par le
 *   transport. Les relayer produirait une requête incohérente.
 * `x-forwarded-*`, `cookie` : appartiennent à la relation agent↔Oathrion, pas à la relation
 *   Oathrion↔fournisseur.
 */

import type { ConnectorVault } from "../connectors/vault";
import type { PendingInterceptionStore } from "./pending-store";
import type { McpDestination } from "../gateway/tools/mcp-destination";
import type { Readable } from "node:stream";

import { sendGuarded, streamGuarded } from "../notifications/webhook-transport";
import { accessTokenFor, oauthAppFor, OAuthConfigError, OAuthRefreshError } from "../connectors/oauth";
import { parseSigV4Credentials, SigV4ConfigError, sigv4ConfigFor, signSigV4 } from "../connectors/sigv4";
import { RAW_BODY_ENCODING } from "./raw-body";
import { CountingTool, type ToolContext, type ToolResult } from "../gateway/tools/types";
import { DEFAULT_FORWARD_HEADERS, NEVER_FORWARDED, type InterceptedRequest } from "./rules";
import { timed, timedSync } from "../observability/timing";

export const INTERCEPT_TOOL_ID = "intercept_proxy";

/**
 * Les en-têtes relayés : une liste d'AUTORISATION, par règle.
 *
 * ## Le trou que ce changement ferme
 *
 * C'était une liste de REFUS — douze noms interdits, tout le reste transmis. Sur Stripe
 * Connect, `Stripe-Account: acct_autre` fait agir l'appel **sur un autre compte**, et la
 * règle n'inspecte que `body.charge` et le plafond. Un agent compromis remboursait sur le
 * compte d'un tiers, dans les limites autorisées, et l'audit enregistrait une action
 * conforme. La règle « le verbe ne vient pas de l'agent » était contournée par le canal
 * d'à côté.
 *
 * Pour un pare-feu, une liste de refus est à l'envers : elle protège de ce qu'on a pensé
 * à interdire.
 */
function forwardableHeaders(
  incoming: Record<string, string>,
  allowed: readonly string[],
): Record<string, string> {
  const permitted = new Set(allowed.map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    /*
     * La double barrière est volontaire. `NEVER_FORWARDED` est un plancher que même une
     * règle ne peut pas descendre, et le refus au démarrage le dit déjà — mais une
     * déclaration chargée par un autre chemin, ou un défaut modifié par mégarde, ne doit
     * pas pouvoir faire sortir le credential d'Oathrion.
     */
    if (NEVER_FORWARDED.has(lower)) continue;
    if (!permitted.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

/**
 * Ce que le relais doit transmettre, déposé par la route et retiré par le `Tool`.
 *
 * Une table en mémoire plutôt qu'un champ de `metadata` : voir l'en-tête. La clé est
 * l'identifiant d'exécution, que la passerelle crée — donc la route dépose AVANT de
 * connaître la clé, et c'est pourquoi elle dépose sous un jeton qu'elle a tiré elle-même.
 */
export interface PendingForward {
  destination: McpDestination;
  destinationId: string;
  request: InterceptedRequest;
  /**
   * Le nom d'en-tête dans lequel injecter le credential, et son gabarit.
   *
   * LE CREDENTIAL LUI-MÊME N'EST PAS ICI, et c'est une correction apportée par un garde.
   * La route l'ouvrait avant la décision, donc une requête BLOQUÉE faisait déchiffrer un
   * secret du fournisseur — jamais envoyé, mais présent en clair en mémoire sans qu'aucune
   * autorisation ne l'ait justifié. `server/test/connector-single-path.test.ts` exige que
   * `vault.open()` n'ait qu'un appelant, à l'intérieur de `Tool.run()` : il avait raison.
   *
   * Le déchiffrement a donc lieu dans `run()`, après un ALLOW, et la fenêtre pendant
   * laquelle le secret existe en clair est bornée aux actions autorisées.
   */
  credentialHeader: string;
  credentialTemplate: string;
  /**
   * Les en-têtes que LA RÈGLE autorise à relayer. Porté ici et non relu depuis la règle :
   * entre le dépôt et la reprise — une approbation humaine dure des minutes —
   * `OATHRION_INTERCEPTS` peut avoir changé, et la requête doit partir avec la permission
   * qui était en vigueur quand elle a été jugée.
   */
  forwardHeaders: readonly string[];
  /**
   * Le champ de la réponse qui dit si le fournisseur a réussi — voir `InterceptRule`.
   * Il voyage avec la requête, et il est GARÉ avec elle : une requête approuvée par un
   * humain des minutes plus tard doit être jugée par la règle en vigueur à la décision.
   */
  successField?: string;
  /**
   * La règle demande un relais EN FLUX de la réponse.
   *
   * Absent de ce qui est PERSISTÉ dans le sas d'approbation, et c'est voulu plutôt
   * qu'oublié : une requête retenue pour approbation a reçu un 202, la connexion de
   * l'agent est fermée, et il n'y a personne vers qui faire couler une réponse. Une
   * reprise après approbation est donc toujours tamponnée, et la colonne qui manquerait
   * pour porter ce drapeau n'aurait servi qu'à décrire un mode impossible.
   */
  stream?: boolean;
}

/* ---------------------------- LE PASSAGE DE FLUX ---------------------------- */

/**
 * Ce que l'outil publie dès que les en-têtes du fournisseur arrivent.
 *
 * ## Pourquoi un passage de main et pas une valeur de retour
 *
 * Un `ToolResult` est rendu quand `run()` se termine. Pour un flux, `run()` ne peut pas
 * se terminer avant la fin du transfert — sinon la passerelle écrirait le reçu au milieu,
 * avec un nombre d'octets qui ne veut rien dire. Mais la route, elle, doit commencer à
 * relayer AVANT la fin.
 *
 * Les deux besoins sont inconciliables par la valeur de retour, et conciliables par un
 * passage de main : l'outil publie ici dès les en-têtes, la route pipe, l'outil attend la
 * fin du flux, et le reçu est écrit après — avec les octets réels et la troncature.
 *
 * L'ordre de gouvernance est intact : ce passage n'existe que si `run()` a été atteint,
 * donc après une décision ALLOW et la consommation du grant.
 */
export interface StreamHandoff {
  status: number;
  headers: Record<string, string>;
  body: Readable;
  /*
   * L'exécution et l'injection du credential voyagent AVEC le flux, parce que la route
   * doit poser ses en-têtes de gouvernance avant le premier octet — et qu'à ce moment-là
   * elle n'a pas encore le résultat de la passerelle, qui n'arrivera qu'à la fin du
   * transfert. Les omettre ferait d'une réponse en flux la seule réponse du pare-feu sans
   * identifiant d'exécution, donc la seule qu'un auditeur ne peut pas relier à son reçu.
   */
  executionId: string;
  credentialInjected: boolean;
}

/*
 * Les flux publiés, et les routes qui les attendent.
 *
 * Deux tables parce que les deux ordres d'arrivée existent : la route attend souvent
 * avant que l'outil ne publie (le cas normal), et l'inverse est possible si le relais est
 * plus rapide que le retour de la boucle d'événements.
 *
 * Pas de plafond ici, contrairement à `pending` et `responses`, et il faut dire pourquoi :
 * une entrée ne survit pas à la requête HTTP qui l'a créée. La route annule son attente
 * dans un `finally`, et un flux publié que personne ne reprend est fermé par
 * `releaseStream`. Rien ne s'accumule au-delà des requêtes en vol, qui sont déjà bornées
 * par `pending`.
 */
const streams = new Map<string, StreamHandoff>();
const streamWaiters = new Map<string, (handoff: StreamHandoff) => void>();

/** L'outil publie. Si une route attend déjà, elle est servie directement. */
export function putStream(ref: string, handoff: StreamHandoff): void {
  const waiter = streamWaiters.get(ref);
  if (waiter) {
    streamWaiters.delete(ref);
    waiter(handoff);
    return;
  }
  streams.set(ref, handoff);
}

/**
 * La route attend le flux de cette exécution.
 *
 * Rend une promesse qui ne rejette jamais : si l'exécution se termine sans flux — BLOCK,
 * approbation, échec de relais, ou simplement une règle sans `stream` — la route gagne la
 * course avec son propre résultat et annule celle-ci.
 */
export function awaitStream(ref: string): Promise<StreamHandoff> {
  const published = streams.get(ref);
  if (published) {
    streams.delete(ref);
    return Promise.resolve(published);
  }
  return new Promise<StreamHandoff>((resolve) => {
    streamWaiters.set(ref, resolve);
  });
}

/**
 * La route n'attend plus. Appelé dans un `finally`, toujours.
 *
 * Si un flux a été publié entre-temps et que personne ne le reprendra, il est DÉTRUIT :
 * l'abandonner laisserait le fournisseur émettre vers un tampon que rien ne lit, et
 * l'exécution ouverte jusqu'au plafond de durée.
 */
export function releaseStream(ref: string): void {
  streamWaiters.delete(ref);
  const orphan = streams.get(ref);
  if (orphan) {
    streams.delete(ref);
    orphan.body.destroy();
  }
}

/** Test-only : combien de flux publiés attendent d'être reprised. */
export function streamCount(): number {
  return streams.size + streamWaiters.size;
}

/*
 * La table des requêtes en attente de relais.
 *
 * Bornée et à usage unique : `take` supprime l'entrée. Une entrée qui n'est jamais
 * reprise — parce que la décision a été BLOCK, ou parce qu'une approbation est en
 * attente — est écartée par l'âge. Sans cette expiration, un déploiement sous une pluie
 * de requêtes bloquées garderait leurs corps en mémoire indéfiniment.
 */
const pending = new Map<string, { at: number; forward: PendingForward }>();
const PENDING_TTL_MS = 60_000;
const PENDING_MAX = 2_000;
/** Le même ordre de grandeur que `PENDING_MAX` : voir `putResponse`. */
const RESPONSE_MAX = 2_000;

export function putPending(ref: string, forward: PendingForward, now = Date.now()): void {
  for (const [key, entry] of pending) {
    if (now - entry.at > PENDING_TTL_MS) pending.delete(key);
  }
  if (pending.size >= PENDING_MAX) {
    /*
     * Plein : on refuse d'ajouter plutôt que d'évincer au hasard. Évincer rendrait un
     * relais légitime impossible sans rien dire ; refuser ici fait échouer la requête
     * en cours, qui est celle dont l'appelant attend une réponse.
     */
    throw new Error(
      `Too many requests waiting to be relayed (${String(pending.size)}). Oathrion refuses to ` +
        `accept one more rather than drop one that is already waiting.`,
    );
  }
  pending.set(ref, { at: now, forward });
}

export function takePending(ref: string): PendingForward | null {
  const entry = pending.get(ref);
  if (!entry) return null;
  pending.delete(ref);
  return entry.forward;
}

/** Test-only. */
export function pendingCount(): number {
  return pending.size;
}

/** Test-only : combien de réponses attendent d'être lues. */
export function responseCount(): number {
  return responses.size;
}
export function resetPending(): void {
  pending.clear();
  responses.clear();
}

/** La clé sous laquelle la route dépose, portée par les métadonnées de l'action. */
export const INTERCEPT_REF_KEY = "__placetInterceptRef";

/* ------------------------- la réponse du fournisseur ---------------------- */

export interface ForwardedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/*
 * LA RÉPONSE DU FOURNISSEUR NE PASSE PAS PAR `ToolResult`, ET C'ÉTAIT UNE FUITE.
 *
 * `AgentGateway` écrit `result.data` dans la colonne `toolResult` de l'exécution — donc
 * EN BASE. Le relais y plaçait `responseBody` et `responseHeaders`, c'est-à-dire la
 * réponse complète du fournisseur : pour un remboursement, l'objet client avec son
 * adresse e-mail, son nom et les quatre derniers chiffres de sa carte.
 *
 * Le contrôle voisin — « le corps de la REQUÊTE n'entre pas dans les métadonnées » — ne
 * l'attrapait pas : il regardait l'autre direction. Deux directions, un seul contrôle.
 *
 * La réponse passe donc par cette table, à usage unique, reprise par la route pour être
 * rendue à l'agent, et écrite nulle part. Même motif que la requête entrante, et pour la
 * même raison.
 */
const responses = new Map<string, { at: number; response: ForwardedResponse }>();

export function putResponse(ref: string, response: ForwardedResponse, now = Date.now()): void {
  for (const [key, entry] of responses) {
    if (now - entry.at > PENDING_TTL_MS) responses.delete(key);
  }
  /*
   * UN PLAFOND, comme `pending` en a un — son absence ici était une voie de déni de
   * service par la mémoire.
   *
   * Une entrée n'est reprise que si l'appelant lit la réponse. Un client qui coupe la
   * connexion laisse la sienne jusqu'au balayage par l'âge : avec du débit et des réponses
   * volumineuses, la consommation n'était bornée par rien dans la fenêtre d'une minute.
   * Un attaquant qui le sait fait tomber le processus — donc arrête TOUS les agents
   * gouvernés, ce qui est la pire issue disponible pour un plan de contrôle.
   *
   * La plus ancienne est évincée plutôt que de refuser la nouvelle : contrairement à une
   * requête en attente, perdre une réponse ne perd aucun effet — l'appel a déjà eu lieu,
   * et l'appelant recevra un corps vide avec le statut du fournisseur. Refuser
   * l'enregistrement, lui, perdrait la réponse de la requête en cours.
   */
  if (responses.size >= RESPONSE_MAX) {
    const oldest = responses.keys().next();
    if (!oldest.done) responses.delete(oldest.value);
  }
  responses.set(ref, { at: now, response });
}

/** À usage unique : une réponse reprise disparaît. */
export function takeResponse(ref: string): ForwardedResponse | null {
  const entry = responses.get(ref);
  if (!entry) return null;
  responses.delete(ref);
  return entry.response;
}

export interface ForwardOutcome {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class InterceptTool extends CountingTool {
  readonly id = INTERCEPT_TOOL_ID;
  readonly name = "Relais d'interception";
  readonly description =
    "Forwards an authorized HTTP request to the declared API and returns its response unchanged.";

  /**
   * Le coffre du locataire, et l'environnement pour le repli.
   *
   * Reçus à la construction — la portée du locataire en construit un par organisation,
   * exactement comme pour un connecteur — et non par requête : un relais partagé entre
   * deux organisations porterait le coffre de l'une.
   */
  constructor(
    private readonly vault: ConnectorVault,
    /**
     * Le sas des requêtes garées en attendant un humain.
     *
     * `null` est accepté pour les tests qui n'exercent que la voie synchrone. En
     * production la portée du locataire en fournit toujours un : sans lui, une
     * approbation rendue après un redémarrage ne retrouverait rien.
     */
    private readonly pendingStore: PendingInterceptionStore | null = null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
  }

  /**
   * Le credential du fournisseur, ouvert APRÈS l'autorisation.
   *
   * Le coffre d'abord — chiffré, par locataire, révocable. Puis l'environnement, qui est
   * en clair et vaut pour tout le déploiement : un repli assumé, parce que sans lui le
   * proxy ne pourrait injecter aucune clé pour une destination qui n'est pas un
   * connecteur du catalogue, et l'agent devrait porter la sienne — ce qui rend le
   * contournement possible au lieu d'impossible.
   */
  private async credentialFor(destinationId: string, organizationId: string): Promise<string | null> {
    let secret: string | null = null;
    try {
      secret = (await timed("vault", () => this.vault.open(destinationId)))?.secretEnvelope ?? null;
    } catch {
      /* Coffre indisponible : on n'injecte pas, et le résultat le DIT. */
    }
    if (secret === null) {
      const name = `OATHRION_INTERCEPT_KEY_${destinationId.replace(/-/g, "_").toUpperCase()}`;
      secret = this.env[name]?.trim() || null;
    }
    if (secret === null) return null;

    /*
     * ────────────── LE JETON COURT, ÉCHANGÉ SI LA DESTINATION EN A UN ──────────────
     *
     * Quand `OATHRION_OAUTH_<DESTINATION>` existe, le secret du coffre n'est PAS ce qui
     * part : c'est un jeton de RAFRAÎCHISSEMENT, et ce qui part est le jeton d'accès
     * qu'il permet d'obtenir. C'est ce qui rend Google Workspace, Microsoft 365 et
     * Salesforce atteignables — ils ne délivrent que des jetons d'une heure, et un jeton
     * collé dans l'environnement y expirait en silence.
     *
     * La configuration est lue à CHAQUE appel plutôt que mise en cache : elle est
     * minuscule, et un exploitant qui corrige son `clientSecret` doit voir l'effet au
     * prochain appel, pas au prochain redémarrage.
     *
     * Une configuration présente et FAUSSE lève — elle ne retombe pas sur l'injection
     * statique. Retomber enverrait le jeton de rafraîchissement dans l'en-tête
     * d'autorisation, où le fournisseur le refuserait avec un 401 qui ferait chercher
     * l'erreur du mauvais côté.
     */
    const app = oauthAppFor(destinationId, this.env);
    if (!app) return secret;

    return timed("oauth", () =>
      accessTokenFor({
        organizationId,
        destinationId,
        refreshToken: secret,
        app,
      }),
    );
  }

  /**
   * `simulated` est `false` : atteindre ce relais signifie qu'une requête part réellement
   * sur le réseau. Il n'a pas de mode simulé, et en avoir un serait exactement le
   * mensonge que l'inventaire existe pour empêcher.
   */
  override get simulated(): boolean {
    return false;
  }

  protected async run(context: ToolContext): Promise<ToolResult> {
    const ref = context.metadata[INTERCEPT_REF_KEY];
    if (typeof ref !== "string" || ref === "") {
      /*
       * Ce verbe a été appelé par `/api/execute` et non par le proxy : il n'y a aucune
       * requête à relayer. Un refus nommé, et surtout pas une requête inventée.
       */
      return {
        ok: false,
        summary:
          "This verb is served by the interception relay and can only be called by " +
          "the proxy (`POST /api/v1/intercept`). Nothing was forwarded.",
        data: { dispatched: false, reason: "no_intercepted_request" },
      };
    }

    /*
     * LA MÉMOIRE D'ABORD, LE SAS ENSUITE, et l'ordre n'est pas indifférent.
     *
     * Un ALLOW est synchrone : la requête est encore dans la `Map` du processus, et rien
     * n'a été écrit. C'est la voie rapide, et elle ne coûte aucune entrée-sortie.
     *
     * Une approbation arrive plus tard — parfois après un redémarrage, parfois sur une
     * autre instance. La requête est alors dans le sas persisté, chiffrée. C'est la voie
     * lente, et elle n'est empruntée que quand un humain est intervenu.
     *
     * Les deux sont à usage unique. Lire la mémoire en premier évite une requête SQL sur
     * le chemin chaud ; lire le sas en second est ce qui rend l'approbation humaine
     * utilisable au-delà de soixante secondes.
     */
    let forward = takePending(ref);
    if (!forward && this.pendingStore) {
      forward = await this.pendingStore.take(ref);
    }
    if (!forward) {
      /*
       * Expirée, déjà relayée, ou sa destination n'est plus permise à ce locataire. Les
       * trois sont des refus, et le deuxième est ce qui empêche une approbation rejouée
       * de transmettre deux fois : la reprise est une suppression conditionnelle, en plus
       * du grant à usage unique.
       */
      return {
        ok: false,
        summary:
          "The intercepted request is no longer available: it expired, it was already " +
          "relayed, or its destination is no longer allowed for this organization. Nothing " +
          "was forwarded.",
        data: { dispatched: false, reason: "intercepted_request_gone" },
      };
    }

    const { request, destination } = forward;
    const headers = forwardableHeaders(
      request.headers,
      forward.forwardHeaders.length > 0 ? forward.forwardHeaders : DEFAULT_FORWARD_HEADERS,
    );

    /*
     * LE CREDENTIAL VIENT DE OATHRION, et c'est ce qui rend le contournement impossible
     * plutôt que déconseillé. Un agent qui ne détient pas la clé du fournisseur ne peut
     * pas appeler son API sans passer ici.
     *
     * Ouvert ICI et non dans la route : atteindre cette ligne signifie qu'un ALLOW a été
     * rendu. Une requête bloquée ne fait donc déchiffrer aucun secret.
     */
    /*
     * UN ÉCHEC D'ÉCHANGE EST UN REFUS NOMMÉ, PAS UNE EXCEPTION.
     *
     * Laisser lever ferait écrire le reçu par le chemin d'erreur générique de la
     * passerelle, et l'agent recevrait un 500 : l'exploitant chercherait une panne de
     * Oathrion alors que son jeton de rafraîchissement est révoqué. Ici le motif est
     * `oauth_unavailable`, la route rend un 502 avec ce code, et le reçu le porte —
     * comme tous les autres refus de ce fichier.
     *
     * Rien n'est transmis dans les deux cas. C'est la seule issue acceptable : relayer
     * sans credential enverrait l'agent chez le fournisseur avec sa propre clé, donc
     * rendrait le contournement possible.
     */
    let credential: string | null;
    try {
      credential = await this.credentialFor(forward.destinationId, context.organizationId);
    } catch (error) {
      if (error instanceof OAuthRefreshError || error instanceof OAuthConfigError) {
        return {
          ok: false,
          summary: error.message,
          data: {
            dispatched: false,
            reason: "oauth_unavailable",
            destination: forward.destinationId,
            method: request.method,
            path: request.path,
            credentialInjected: false,
          },
        };
      }
      throw error;
    }
    const query = new URLSearchParams(request.query).toString();
    const url = new URL(`${destination.origin}${request.path}${query ? `?${query}` : ""}`);

    /*
     * LE CORPS BRUT, RELAYÉ TEL QUEL — ET C'ÉTAIT LE DÉFAUT QUI RENDAIT STRIPE
     * INUTILISABLE.
     *
     * Le relais re-sérialisait l'objet parsé en JSON, puis conservait le `content-type`
     * de l'agent. Pour une API form-encoded — et celle de Stripe l'est — cela envoyait un
     * corps JSON sous un en-tête `application/x-www-form-urlencoded`, que le fournisseur
     * refuse. L'exemple vedette de `docs/firewall.md` ne pouvait pas fonctionner.
     *
     * Le corps parsé sert à EXTRAIRE (le verbe, la cible, le montant) ; le corps BRUT est
     * ce qui part. Les deux rôles sont distincts, et les confondre faisait d'Oathrion un
     * transformateur de contenu qu'il n'est pas — avec, en prime, la perte d'ordre des
     * clés et de précision numérique que toute ré-écriture entraîne.
     */
    const body = request.rawBody ?? (request.body === null ? "" : JSON.stringify(request.body));
    if (body !== "" && headers["content-type"] === undefined) {
      /*
       * Posé seulement si la règle a autorisé `content-type` ET que l'agent n'en a pas
       * envoyé. Deviner `application/json` pour un corps brut d'un autre type serait
       * exactement la faute qu'on vient de corriger, d'où la lecture de ce que l'agent a
       * réellement déclaré.
       */
      const declared = request.headers["content-type"];
      if (declared !== undefined) headers["content-type"] = declared;
    }

    /*
     * ──────────── SIGNER, OU INJECTER — ET JAMAIS LES DEUX ────────────
     *
     * Une destination AWS ne s'authentifie pas par une valeur posée dans un en-tête : la
     * signature couvre la méthode, le chemin, la chaîne de requête, les en-têtes signés et
     * le HACHAGE DU CORPS. Y ajouter en plus un `authorization` statique produirait deux
     * autorisations contradictoires, et AWS lirait la mauvaise.
     *
     * C'est un RENFORCEMENT de la garantie, pas un simple autre format : avec une
     * signature, un agent ne peut pas faire signer une requête puis en envoyer une autre.
     * Modifier un octet du corps invalide tout.
     *
     * La signature est calculée ICI, après que les en-têtes et le corps BRUT sont
     * définitifs — plus tôt, elle porterait sur une requête qui n'est pas celle qui part.
     * C'est pour cette raison que ce bloc est APRÈS le corps et le `content-type`, et non
     * à côté de l'ouverture du coffre où il aurait été plus lisible.
     */
    let signing: ReturnType<typeof sigv4ConfigFor>;
    try {
      signing = sigv4ConfigFor(forward.destinationId, this.env);
    } catch (error) {
      /*
       * Une configuration de signature PRÉSENTE ET FAUSSE refuse l'appel. Retomber sur
       * l'injection statique enverrait un `accessKeyId:secret` dans un en-tête
       * `authorization`, qu'AWS refuserait — et l'exploitant chercherait une clé invalide
       * au lieu d'une région mal écrite.
       */
      return {
        ok: false,
        summary: error instanceof SigV4ConfigError ? error.message : String(error),
        data: {
          dispatched: false,
          reason: "sigv4_unavailable",
          destination: forward.destinationId,
          method: request.method,
          path: request.path,
          credentialInjected: false,
        },
      };
    }

    if (credential && signing) {
      try {
        const signed = timedSync("sigv4", () =>
          signSigV4({
            method: request.method,
            url,
            headers,
            body,
            bodyEncoding: RAW_BODY_ENCODING,
            config: signing,
            credentials: parseSigV4Credentials(credential),
          }),
        );
        Object.assign(headers, signed.headers);
      } catch (error) {
        /*
         * Un credential illisible refuse aussi, et surtout : il ne laisse PAS partir une
         * requête non signée. Une requête non signée vers AWS est refusée côté AWS, mais
         * le motif rendu à l'agent parlerait du fournisseur alors que la faute est dans
         * le coffre.
         */
        if (error instanceof SigV4ConfigError) {
          return {
            ok: false,
            summary: error.message,
            data: {
              dispatched: false,
              reason: "sigv4_credential_invalid",
              destination: forward.destinationId,
              method: request.method,
              path: request.path,
              credentialInjected: false,
            },
          };
        }
        throw error;
      }
    } else if (credential) {
      headers[forward.credentialHeader] = forward.credentialTemplate.replace("{secret}", credential);
    }

    /*
     * ────────────────────── LA VOIE EN FLUX ──────────────────────
     *
     * Déclarée par la règle (`stream: true`), jamais devinée depuis le `content-type` de
     * la réponse : laisser le fournisseur choisir le mode de relais serait laisser une
     * réponse décider de la façon dont Oathrion la traite.
     *
     * La décision est DÉJÀ prise quand on arrive ici — `run()` n'est atteignable qu'après
     * un ALLOW et la consommation du grant. Ce qui change est uniquement la direction du
     * retour : les en-têtes sont publiés dès qu'ils arrivent, la route pipe, et `run()`
     * attend la FIN du transfert avant de rendre son résultat.
     *
     * Cet ordre est la propriété : le reçu est écrit par la passerelle quand `run()` rend,
     * donc après la fin du flux, donc avec les octets réellement passés et la troncature
     * réellement subie. Rendre plus tôt écrirait un reçu au milieu d'un transfert, avec un
     * compte qui ne veut rien dire.
     */
    if (forward.stream === true) {
      const opened = await timed("upstream", () =>
        streamGuarded({
          url,
          method: request.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          headers,
          body,
          timeoutMs: 30_000,
          bodyEncoding: RAW_BODY_ENCODING,
          allowPrivate: destination.kind === "LOCAL_FIXTURE",
        }),
      );

      /*
       * Publié AVANT d'attendre. L'inverse serait un interblocage : la route attend le
       * passage de main, l'outil attend la fin du flux, et personne ne pipe.
       */
      putStream(String(ref), {
        status: opened.status,
        headers: opened.headers,
        body: opened.body,
        executionId: context.executionId,
        credentialInjected: credential !== null,
      });

      const outcome = await opened.completion;

      return {
        /*
         * `ok` suit le statut DU FOURNISSEUR, comme en mode tamponné — et un flux tronqué
         * n'est pas un succès : l'agent a reçu une réponse incomplète, et un reçu qui
         * dirait « réussi » décrirait autre chose que ce qui s'est passé.
         */
        ok: opened.ok && !outcome.truncated,
        summary:
          `${request.method} ${request.path} STREAMED to ${forward.destinationId} — ` +
          `the provider answered ${String(opened.status)}, ` +
          `${String(outcome.bytes)} bytes` +
          (outcome.truncated ? ` — TRUNCATED: ${outcome.reason ?? "unknown cause"}.` : "."),
        data: {
          dispatched: true,
          destination: forward.destinationId,
          method: request.method,
          path: request.path,
          status: opened.status,
          /* Les octets réellement passés, comptés par le transport pendant le transfert. */
          responseBytes: outcome.bytes,
          streamed: true,
          /*
           * La troncature est un FAIT DE GOUVERNANCE et elle est persistée : un auditeur
           * qui voit une réponse coupée sait que l'agent a agi sur une réponse partielle,
           * alors que l'effet chez le fournisseur, lui, a bien eu lieu en entier.
           */
          truncated: outcome.truncated,
          ...(outcome.reason === null ? {} : { truncationReason: outcome.reason }),
          credentialInjected: credential !== null,
        },
      };
    }

    const reply = await timed("upstream", () =>
      sendGuarded({
      url,
      method: request.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      headers,
      body,
      timeoutMs: 30_000,
      captureBody: true,
      /* Le corps brut voyage en latin1 : voir `intercept/raw-body.ts`. */
      bodyEncoding: RAW_BODY_ENCODING,
      allowPrivate: destination.kind === "LOCAL_FIXTURE",
      }),
    );

    /*
     * `ok` suit le statut du FOURNISSEUR. Un 422 de Stripe est un refus métier : le reçu
     * doit porter `failed`, le grant reste consommé, et Oathrion ne réessaie pas. C'est la
     * même règle que le relais MCP applique à `isError`.
     */
    /*
     * La réponse part dans la table en mémoire, PAS dans `data` : `data` est persisté.
     * Voir le commentaire de `responses` plus haut — c'est la fuite que ce détour ferme.
     */
    const payload = reply.body ?? "";
    /*
     * LA RÉUSSITE DÉCLARÉE PAR LE FOURNISSEUR, quand le statut HTTP ne suffit pas.
     *
     * Slack répond 200 à un message qu'il refuse, avec `"ok": false`. Sans cette lecture,
     * le reçu disait « envoyé » pour un message que personne n'a reçu. Un corps illisible
     * ou un champ absent comptent comme un échec : on n'affirme pas une réussite que le
     * fournisseur n'a pas affirmée.
     */
    const providerOk = forward.successField === undefined ? undefined : readSuccessField(payload, forward.successField);
    const succeeded = reply.ok && providerOk !== false;
    putResponse(String(ref), {
      status: reply.status,
      headers: reply.headers ?? {},
      body: payload,
    });

    return {
      ok: succeeded,
      summary:
        `${request.method} ${request.path} relayed to ${forward.destinationId} — ` +
        `the provider answered ${String(reply.status)}` +
        (providerOk === false ? `, but reports a FAILURE in "${String(forward.successField)}".` : "."),
      /*
       * CE QUI EST PERSISTÉ, ET RIEN DE PLUS. Des faits de gouvernance : où, comment,
       * avec quel statut, et si Oathrion a injecté le credential. Aucune donnée métier.
       *
       * `responseBytes` plutôt que le corps : un auditeur qui cherche une réponse
       * anormalement grosse peut la repérer sans qu'on en ait gardé le contenu.
       */
      data: {
        dispatched: true,
        destination: forward.destinationId,
        method: request.method,
        path: request.path,
        status: reply.status,
        responseBytes: Buffer.byteLength(payload),
        /*
         * Dit sans détour, et lu par la route. `false` signifie que l'agent porte encore
         * la clé de l'API, donc qu'il pourrait l'appeler sans passer par Oathrion.
         */
        credentialInjected: credential !== null,
        /*
         * Présent seulement quand la règle déclare où lire la réussite. Un booléen, jamais
         * le corps : c'est un fait de gouvernance (« le fournisseur a dit non »), pas une
         * donnée métier.
         */
        ...(providerOk === undefined ? {} : { providerOk }),
      },
    };
  }
}

/**
 * Lit le champ de réussite dans le JSON de la réponse. `true` seulement si la valeur est
 * exactement le booléen `true` : la chaîne `"true"`, `1` ou un objet ne sont pas une
 * affirmation de réussite.
 */
export function readSuccessField(payload: string, field: string): boolean {
  let cursor: unknown;
  try {
    cursor = JSON.parse(payload);
  } catch {
    return false;
  }
  for (const part of field.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor === true;
}

/** Les en-têtes de réponse qu'on rend à l'agent. Les autres appartiennent au transport. */
const RESPONSE_PASSTHROUGH = new Set([
  "content-type",
  "x-request-id",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
  /*
   * Ajouté pour le mode flux. Une réponse `text/event-stream` que l'on mettrait en cache
   * en chemin serait rejouée au lieu d'être suivie ; `content-length` reste exclu, puisque
   * la longueur d'un flux n'est pas connue quand les en-têtes partent.
   */
  "cache-control",
]);

export function responseHeadersFor(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (RESPONSE_PASSTHROUGH.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  }
  return out;
}
