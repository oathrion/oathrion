/**
 * Les jetons d'accès à durée courte, et comment Oathrion les tient à jour.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Le pare-feu injectait **un en-tête statique** :
 *
 *     headers[header] = template.replace("{secret}", credential)
 *
 * Donc il ne savait travailler qu'avec une clé de longue durée — Stripe, OpenAI, Jira,
 * un jeton GitHub. Et il ne savait PAS travailler avec Google Workspace, Microsoft 365
 * ni Salesforce, qui délivrent un jeton d'accès valable une heure et un jeton de
 * rafraîchissement qu'on échange contre un nouveau. Un jeton collé dans l'environnement
 * y expirait en soixante minutes, puis chaque appel d'agent recevait un 401 du
 * fournisseur — un symptôme qui ressemble à une clé fausse et qui est en fait une clé
 * périmée.
 *
 * C'était le manque qui fermait la plus grande part du marché : ces trois fournisseurs
 * couvrent la messagerie, l'agenda, les documents et le CRM d'une entreprise.
 *
 * ## LE PARTAGE ENTRE DÉPLOIEMENT ET LOCATAIRE, ET POURQUOI IL EST LÀ
 *
 * Un flot OAuth a deux moitiés, et elles n'appartiennent pas au même acteur :
 *
 *   · **L'application** — `tokenUrl`, `clientId`, `clientSecret`. C'est l'enregistrement
 *     que l'exploitant a fait chez le fournisseur ; il vaut pour tout le déploiement et
 *     vit dans `OATHRION_OAUTH_<DESTINATION>`.
 *   · **Le compte** — le jeton de rafraîchissement. Il désigne l'organisation cliente et
 *     son consentement ; il vit dans le COFFRE, chiffré, par locataire, révocable.
 *
 * C'est le même partage que le reste du produit : la configuration du déploiement dans
 * l'environnement, le secret du locataire dans le coffre. Mettre le jeton de
 * rafraîchissement dans l'environnement ferait partager un consentement entre clients ;
 * mettre le `clientSecret` dans le coffre obligerait chaque locataire à enregistrer sa
 * propre application chez le fournisseur.
 *
 * ## LE JETON D'ACCÈS N'EST JAMAIS PERSISTÉ
 *
 * Il vit en mémoire, avec son échéance, le temps de sa validité. Trois raisons, dans cet
 * ordre : c'est un credential, et ce dépôt ne persiste pas un credential qu'il peut
 * reconstituer ; il est périmé en une heure, donc une base en garderait surtout des
 * valeurs mortes ; et un redémarrage ne coûte qu'un échange de plus, pas une
 * reconfiguration.
 *
 * ## L'ÉCHEC D'UN RAFRAÎCHISSEMENT REFUSE L'APPEL
 *
 * Il ne laisse pas passer une requête sans credential. Un relais sans credential est un
 * relais que l'agent pourrait contourner — il devrait alors porter sa propre clé — et un
 * 401 du fournisseur ferait chercher l'erreur du mauvais côté. Un jeton de
 * rafraîchissement révoqué est un problème d'exploitant, et le motif le dit.
 */

import { createHash } from "node:crypto";

import { resolveDownstreamDestination } from "../gateway/tools/mcp-destination";
import { sendGuarded } from "../notifications/webhook-transport";

/** La configuration d'application d'une destination, lue dans l'environnement. */
export interface OAuthApp {
  tokenUrl: URL;
  clientId: string;
  clientSecret: string;
  /**
   * Les portées redemandées à chaque échange, si le fournisseur l'exige.
   *
   * Optionnelles : la plupart des fournisseurs rendent les portées déjà consenties et
   * en redemander d'autres serait de toute façon refusé. Elles existent parce que
   * Salesforce et quelques autres veulent la liste à chaque fois.
   */
  scopes?: string;
}

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

/** `local-fixture` → `OATHRION_OAUTH_LOCAL_FIXTURE`. Même règle que les autres par destination. */
export function oauthVariableFor(destinationId: string): string {
  return `OATHRION_OAUTH_${destinationId.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * La configuration d'application de cette destination, ou `null` s'il n'y en a pas.
 *
 * Lève sur une configuration PRÉSENTE ET FAUSSE. La distinction est la même que partout
 * ailleurs dans ce dépôt : absente veut dire « cette destination s'authentifie par une
 * clé statique », tandis que mal formée veut dire « l'exploitant a cru configurer OAuth »
 * — et le laisser retomber en silence sur l'injection statique enverrait un jeton de
 * rafraîchissement dans l'en-tête d'autorisation, où il serait refusé sans qu'on sache
 * pourquoi.
 */
export function oauthAppFor(destinationId: string, env: NodeJS.ProcessEnv = process.env): OAuthApp | null {
  const variable = oauthVariableFor(destinationId);
  const raw = env[variable]?.trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthConfigError(
      `${variable} is not valid JSON. Expected: ` +
        `{"tokenUrl":"https://…","clientId":"…","clientSecret":"…"}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OAuthConfigError(`${variable} must be a JSON object.`);
  }
  const entry = parsed as Record<string, unknown>;

  const read = (field: string): string => {
    const value = entry[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new OAuthConfigError(`${variable}: "${field}" is missing or empty.`);
    }
    return value.trim();
  };

  const tokenUrlRaw = read("tokenUrl");
  /*
   * LE POINT D'ÉCHANGE PASSE PAR LE MÊME RÉSOLVEUR QUE TOUTE SORTIE.
   *
   * Donc : l'allowlist `OATHRION_MCP_ALLOWED_DESTINATIONS` et les règles d'adresse
   * anti-SSRF. Ce n'est pas du zèle — un point d'échange de jetons est une URL
   * configurable vers laquelle Oathrion envoie un `clientSecret`, c'est-à-dire exactement
   * la cible qu'une erreur de configuration rend précieuse.
   *
   * Conséquence à connaître : le point d'échange est souvent sur un AUTRE origine que
   * l'API (`oauth2.googleapis.com` contre `www.googleapis.com`), donc les DEUX doivent
   * être déclarées dans l'allowlist. Le message le dit, parce qu'un refus qu'on ne sait
   * pas corriger pousse à désactiver la protection.
   */
  /*
   * L'UNE OU L'AUTRE, JAMAIS LES DEUX. `resolveDownstreamDestination` refuse
   * explicitement de voir `OATHRION_LOCAL_MCP_URL` et `OATHRION_MCP_DOWNSTREAM_URL` ensemble
   * — « they are different things » — et la première version de ce fichier les posait
   * toutes deux à la même valeur, ce qui refusait toute configuration, y compris
   * correcte. Le refus avait raison ; c'est l'appel qui était faux.
   */
  const loopbackAllowed = env.OATHRION_OAUTH_ALLOW_LOOPBACK === "1";

  /*
   * L'ORIGINE est validée, le CHEMIN est conservé.
   *
   * Le résolveur de destinations prend une origine sans chemin — c'est son contrat, et
   * c'est cohérent : une allowlist porte sur « à qui Oathrion parle », pas sur « quelle
   * route ». Or un point d'échange EST une origine plus un chemin
   * (`https://oauth2.googleapis.com/token`). La première version passait l'URL entière
   * et se faisait refuser pour `path "/token"` : le résolveur avait raison, l'appel était
   * faux. On valide donc l'origine et on garde l'URL complète pour l'échange.
   */
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tokenUrlRaw);
  } catch {
    throw new OAuthConfigError(`${variable}: "tokenUrl" is not a valid URL — ${tokenUrlRaw}`);
  }

  let destination;
  try {
    destination = resolveDownstreamDestination(
      (loopbackAllowed
        ? { OATHRION_LOCAL_MCP_URL: parsedUrl.origin }
        : {
            OATHRION_MCP_DOWNSTREAM_URL: parsedUrl.origin,
            OATHRION_MCP_ALLOWED_DESTINATIONS: env.OATHRION_MCP_ALLOWED_DESTINATIONS,
          }) as NodeJS.ProcessEnv,
    );
  } catch (error) {
    throw new OAuthConfigError(
      `${variable}: "tokenUrl" is refused — ${error instanceof Error ? error.message : String(error)} ` +
        `The token endpoint is often on a different origin than the API: declare both ` +
        `in OATHRION_MCP_ALLOWED_DESTINATIONS.`,
    );
  }
  if (!destination) {
    throw new OAuthConfigError(`${variable}: "tokenUrl" does not resolve to an allowed destination.`);
  }

  const app: OAuthApp = {
    tokenUrl: parsedUrl,
    clientId: read("clientId"),
    clientSecret: read("clientSecret"),
  };
  const scopes = entry.scopes;
  if (typeof scopes === "string" && scopes.trim() !== "") app.scopes = scopes.trim();
  return app;
}

/** Les problèmes de toutes les configurations OAuth, pour le contrôle de démarrage. */
export function oauthConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("OATHRION_OAUTH_")) continue;
    if (name === "OATHRION_OAUTH_ALLOW_LOOPBACK") continue;
    /*
     * La destination est redérivée du nom de la variable, et c'est approximatif : un
     * identifiant avec un tiret devient un souligné, donc `OATHRION_OAUTH_MON_API` peut
     * venir de `mon-api` comme de `mon_api`. On ne s'en sert QUE pour relire la même
     * variable, donc l'approximation ne décide de rien.
     */
    const suffix = name.slice("OATHRION_OAUTH_".length);
    try {
      oauthAppFor(suffix.toLowerCase().replace(/_/g, "-"), env);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

/* --------------------------- le cache en mémoire --------------------------- */

interface CachedToken {
  accessToken: string;
  /** Millisecondes epoch. */
  expiresAt: number;
}

/**
 * Combien de temps avant l'échéance on rafraîchit.
 *
 * Soixante secondes : le temps qu'une requête en vol atteigne le fournisseur, plus la
 * dérive d'horloge entre deux machines. Sans cette marge, un jeton obtenu « valide » par
 * Oathrion pouvait être refusé par le fournisseur, et le symptôme — un 401 intermittent sur
 * un déploiement sain — est parmi les plus coûteux à diagnostiquer.
 */
const REFRESH_MARGIN_MS = 60_000;

/**
 * La durée retenue quand le fournisseur n'annonce pas d'`expires_in`.
 *
 * Cinq minutes, et volontairement court : supposer long ferait garder un jeton mort ;
 * supposer court ne coûte qu'un échange de plus.
 */
const ASSUMED_LIFETIME_MS = 300_000;

const tokens = new Map<string, CachedToken>();
/** Les échanges en cours, pour qu'un pic de trafic n'en déclenche pas vingt. */
const inFlight = new Map<string, Promise<string>>();

/**
 * La clé du cache.
 *
 * Elle porte le locataire, la destination ET une empreinte du jeton de rafraîchissement.
 * L'empreinte n'est pas décorative : si un exploitant remplace le jeton de
 * rafraîchissement — après une révocation, par exemple — la clé change, donc l'ancien
 * jeton d'accès n'est plus servi. Sans elle, Oathrion continuerait à injecter pendant une
 * heure un jeton obtenu avec un consentement retiré.
 */
function cacheKey(org: string, destinationId: string, refreshToken: string): string {
  const print = createHash("sha256").update(refreshToken, "utf8").digest("hex").slice(0, 12);
  return `${org}:${destinationId}:${print}`;
}

/** Test-only : oublie tous les jetons d'accès. */
export function resetOAuthTokens(): void {
  tokens.clear();
  inFlight.clear();
}

/** Test-only : combien de jetons d'accès sont en cache. */
export function oauthTokenCount(): number {
  return tokens.size;
}

export class OAuthRefreshError extends Error {
  constructor(
    readonly destinationId: string,
    detail: string,
  ) {
    super(
      `Refreshing the token for "${destinationId}" failed: ${detail} ` +
        `Nothing was forwarded. The refresh token may have been revoked, or ` +
        `the application of ${oauthVariableFor(destinationId)} is no longer authorized.`,
    );
    this.name = "OAuthRefreshError";
  }
}

/**
 * Le jeton d'accès à injecter, échangé si besoin.
 *
 * ## L'ÉCHANGE EST UN SEUL VOL
 *
 * Deux appels d'agent concurrents sur la même destination ne doivent pas déclencher deux
 * échanges : certains fournisseurs invalident le jeton de rafraîchissement à chaque
 * usage (rotation), et deux échanges simultanés en invalideraient un mutuellement. La
 * promesse en cours est donc partagée.
 *
 * ## CE QUI NE SORT PAS D'ICI
 *
 * Le jeton de rafraîchissement n'est jamais rendu, jamais journalisé, et n'apparaît pas
 * dans les messages d'erreur — seule son EMPREINTE sert de clé de cache. Le corps de la
 * réponse du point d'échange n'est pas journalisé non plus : il contient le jeton
 * d'accès.
 */
export async function accessTokenFor(params: {
  /*
   * Une chaîne et non l'`OrganizationId` marqué : ici le locataire ne sert QUE de
   * préfixe de clé de cache, et la marque de type garantit une provenance que cette
   * fonction ne vérifie pas. L'exiger obligerait l'appelant à une conversion — c'est-à-dire
   * à un endroit où la marque est posée sans être prouvée, ce qui l'affaiblit partout.
   */
  organizationId: string;
  destinationId: string;
  refreshToken: string;
  app: OAuthApp;
  now?: number;
}): Promise<string> {
  const { organizationId, destinationId, refreshToken, app } = params;
  const now = params.now ?? Date.now();
  const key = cacheKey(organizationId, destinationId, refreshToken);

  const cached = tokens.get(key);
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) return cached.accessToken;

  const running = inFlight.get(key);
  if (running) return running;

  const exchange = (async (): Promise<string> => {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    if (app.scopes) form.set("scope", app.scopes);

    let reply;
    try {
      reply = await sendGuarded({
        url: app.tokenUrl,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
        timeoutMs: 15_000,
        captureBody: true,
        /*
         * Le point d'échange d'une fixture locale. La même variable qui a autorisé la
         * boucle locale à la configuration l'autorise ici : deux décisions différentes
         * sur la même adresse seraient une incohérence exploitable.
         */
        allowPrivate: process.env.OATHRION_OAUTH_ALLOW_LOOPBACK === "1",
      });
    } catch (error) {
      /* Le message de transport, jamais le corps de la requête — il porte le secret. */
      throw new OAuthRefreshError(destinationId, error instanceof Error ? error.message : String(error));
    }

    if (!reply.ok) {
      /*
       * Le STATUT du point d'échange, et rien de son corps : une réponse d'erreur OAuth
       * peut renvoyer la requête en écho, donc le `client_secret`.
       */
      throw new OAuthRefreshError(destinationId, `the token endpoint answered ${String(reply.status)}.`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(reply.body ?? "");
    } catch {
      throw new OAuthRefreshError(destinationId, "the token endpoint response is not JSON.");
    }
    if (typeof payload !== "object" || payload === null) {
      throw new OAuthRefreshError(destinationId, "the token endpoint response is not an object.");
    }
    const body = payload as Record<string, unknown>;
    const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (accessToken === "") {
      throw new OAuthRefreshError(destinationId, "the response contains no `access_token`.");
    }

    const lifetime =
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
        ? body.expires_in * 1000
        : ASSUMED_LIFETIME_MS;

    tokens.set(key, { accessToken, expiresAt: Date.now() + lifetime });
    return accessToken;
  })();

  inFlight.set(key, exchange);
  try {
    return await exchange;
  } finally {
    inFlight.delete(key);
  }
}
