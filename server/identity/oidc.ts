/**
 * LE FLOT SSO : la configuration, la découverte, le trousseau, et l'état d'une tentative.
 *
 * ## La décision qui structure tout
 *
 * **Le SSO est une nouvelle façon d'OBTENIR une session, pas un nouveau système de
 * sessions.** Le jeton d'identité du fournisseur du client établit QUI se connecte ;
 * ensuite, `auth.openSession()` fait exactement ce qu'elle fait pour un mot de passe —
 * choisir l'organisation, refuser une appartenance suspendue, poser le TTL, lier
 * l'empreinte de credential, signer le jeton de session.
 *
 * Donc la révocation, la liste des sessions, l'expiration et la trace d'audit continuent
 * de marcher sans une ligne de plus. Et il n'y a pas deux implémentations de « qui a le
 * droit d'ouvrir une session et dans quel locataire » — la classe de divergence qui
 * produit un trou d'autorisation qu'on corrige d'un côté et pas de l'autre.
 *
 * ## AUCUN JETON DU FOURNISSEUR N'EST PERSISTÉ
 *
 * Oathrion échange le code contre des jetons, lit le jeton d'IDENTITÉ, ouvre sa session, et
 * jette le reste. Le jeton d'accès et le jeton de rafraîchissement du fournisseur ne
 * servent à rien ici : Oathrion n'appelle aucune API en son nom. Les garder serait stocker
 * un credential dont on n'a aucun usage, c'est-à-dire créer un risque sans bénéfice.
 *
 * ## Le MFA n'est pas implémenté, il est EXIGÉ
 *
 * C'est le fournisseur qui fait l'authentification forte. Oathrion peut en demander la
 * preuve (`acr`/`amr`) et refuser sans elle. Dire « nous avons le MFA » en se contentant
 * d'accepter ce que l'IdP envoie serait un faux statut ; exiger l'attestation est
 * vérifiable.
 */

import { randomBytes, createHash } from "node:crypto";

import { resolveDownstreamDestination } from "../gateway/tools/mcp-destination";
import { sendGuarded } from "../notifications/webhook-transport";
import type { Jwk } from "./oidc-token";

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

export interface OidcConfig {
  /** L'émetteur, tel qu'il apparaîtra dans `iss`. Comparé exactement. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** L'URL de retour, enregistrée chez le fournisseur. */
  redirectUri: string;
  /** Les points d'entrée. Découverts ou déclarés. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Les portées demandées. `openid` est obligatoire ; `email` l'est pour Oathrion. */
  scope: string;
  requiredAcr: string[];
  requiredAmr: string[];
  requireVerifiedEmail: boolean;
  /**
   * Créer l'utilisateur de console à la première connexion.
   *
   * **Faux par défaut, et c'est un refus par défaut.** Avec un provisionnement
   * automatique, toute personne de l'annuaire du client obtient un accès à la console de
   * gouvernance — y compris les comptes de prestataires et de services. L'exploitant qui
   * l'active choisit aussi le rôle accordé, et il ne peut pas être `admin` : voir
   * `jitRole`.
   */
  jitProvisioning: boolean;
  jitRole: "viewer" | "operator" | "approver";
}

const ROLE_SHAPE = new Set(["viewer", "operator", "approver"]);

/**
 * Lit la configuration, ou rend `null` quand il n'y en a pas.
 *
 * Lève sur une configuration PRÉSENTE ET INCOMPLÈTE : un SSO à moitié configuré qui
 * démarre est un bouton « se connecter » qui échoue chez le client, au pire moment.
 */
/**
 * LE CHEMIN DE RETOUR, défini UNE fois.
 *
 * `redirectUri` est validée contre cette constante, et la route est enregistrée avec
 * elle. Deux littéraux identiques dans deux fichiers tiennent jusqu'au jour où l'un des
 * deux change : la configuration validerait alors une adresse que le serveur ne sert
 * plus, et le fournisseur renverrait l'utilisateur sur un 404.
 */
export const SSO_CALLBACK_PATH = "/api/auth/sso/callback";
export const SSO_START_PATH = "/api/auth/sso/start";
/** L'échange du ticket contre un jeton de session. Un POST, voir la route. */
export const SSO_CLAIM_PATH = "/api/auth/sso/claim";
/** « Le SSO est-il configuré ? » — la seule question que l'écran de connexion pose. */
export const SSO_STATUS_PATH = "/api/auth/sso/status";

/* --------------------- l'exception HTTP, et sa borne --------------------- */

/**
 * La boucle locale, et RIEN d'autre.
 *
 * `OATHRION_OIDC_ALLOW_HTTP=1` existe pour un fournisseur d'essai qui tourne sur la machine
 * du développeur. Sa première version levait beaucoup plus que ce que son nom annonce :
 * elle sautait la validation de destination (`resolveDownstreamDestination`) et posait
 * `allowPrivate: true` sur l'échange de code — celui qui transporte le `clientSecret`.
 * Le drapeau disait « autorise HTTP » et accordait « atteins n'importe quelle adresse
 * privée, et envoie-lui le secret du client ».
 *
 * Un `issuer` en `http://10.0.0.5` suffisait alors à faire d'Oathrion un client HTTP
 * pointé sur le réseau interne, porteur d'un secret. La borne est donc ici : l'exception
 * ne s'applique QUE si l'hôte est la boucle locale.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  /* 127.0.0.0/8 en entier : 127.0.0.1 n'est pas la seule adresse de boucle locale. */
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const parts = v4.slice(1).map((n) => Number(n));
  return parts.every((n) => n <= 255) && parts[0] === 127;
}

/** L'exception HTTP est-elle demandée ? (Sa légitimité est jugée au démarrage.) */
export function httpExceptionRequested(env: NodeJS.ProcessEnv): boolean {
  return env.OATHRION_OIDC_ALLOW_HTTP === "1";
}

/**
 * Une URL de configuration, validée — les quatre le sont désormais.
 *
 * La version précédente lisait `redirectUri`, `authorizationEndpoint`, `tokenEndpoint` et
 * `jwksUri` comme de SIMPLES CHAÎNES, sans jamais les analyser. Une faute de frappe ne se
 * voyait qu'à la première connexion d'un utilisateur réel, et un schéma inattendu
 * (`file:`, `data:`, `javascript:`) traversait la configuration sans un mot.
 */
function requireUrl(
  field: string,
  raw: string,
  env: NodeJS.ProcessEnv,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcConfigError(`OATHRION_OIDC: "${field}" is not a URL — ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OidcConfigError(
      `OATHRION_OIDC: "${field}" uses the scheme ${JSON.stringify(url.protocol)}. ` +
        `Only http and https make sense here.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    /*
     * Un identifiant dans l'URL finirait dans les journaux, dans les en-têtes `Referer`
     * et dans les messages d'erreur. Et il contournerait le coffre, qui est le seul
     * endroit où un secret a le droit de vivre.
     */
    throw new OidcConfigError(
      `OATHRION_OIDC: "${field}" carries credentials in the URL. A secret placed there ` +
        `shows up in logs and escapes the vault.`,
    );
  }
  if (url.hash !== "") {
    throw new OidcConfigError(
      `OATHRION_OIDC: "${field}" carries a fragment (#…), which is never sent to the ` +
        `server and therefore cannot mean anything here.`,
    );
  }
  if (url.protocol !== "https:") {
    if (!httpExceptionRequested(env)) {
      throw new OidcConfigError(
        `OATHRION_OIDC: "${field}" must use HTTPS. An identity token carried in ` +
          `cleartext can be captured and replayed. OATHRION_OIDC_ALLOW_HTTP=1 lifts this rule ` +
          `for LOOPBACK only, and never in production.`,
      );
    }
    if (!isLoopbackHost(url.hostname)) {
      /* L'exception est bornée à la machine locale — c'est tout son objet. */
      throw new OidcConfigError(
        `OATHRION_OIDC: "${field}" uses HTTP to ${url.hostname}, which is not ` +
          `loopback. OATHRION_OIDC_ALLOW_HTTP=1 only covers localhost and 127.0.0.0/8: a ` +
          `test provider on the machine. Pointing Oathrion in cleartext at any other ` +
          `address would send the clientSecret across the network.`,
      );
    }
  }
  return url;
}

export function oidcConfigFor(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const raw = env.OATHRION_OIDC?.trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OidcConfigError(
      'OATHRION_OIDC is not valid JSON. Expected at least: {"issuer":"https://…",' +
        '"clientId":"…","clientSecret":"…","redirectUri":"https://…/api/auth/sso/callback"}',
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OidcConfigError("OATHRION_OIDC must be a JSON object.");
  }
  const entry = parsed as Record<string, unknown>;

  const read = (field: string): string => {
    const value = entry[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new OidcConfigError(`OATHRION_OIDC: "${field}" is missing or empty.`);
    }
    return value.trim();
  };
  const optional = (field: string): string | null => {
    const value = entry[field];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const list = (field: string): string[] => {
    const value = entry[field];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new OidcConfigError(`OATHRION_OIDC: "${field}" must be an array of strings.`);
    }
    return (value as string[]).map((v) => v.trim()).filter((v) => v !== "");
  };
  /** Un point d'entrée déclaré est validé ; absent, il reste vide pour la découverte. */
  const endpoint = (field: string): string => {
    const value = optional(field);
    if (value === null) return "";
    requireUrl(field, value, env);
    return value;
  };

  const issuer = read("issuer");
  /*
   * L'émetteur doit être une origine HTTPS. Pas par principe : `iss` est comparé
   * EXACTEMENT au contenu du jeton, et une barre oblique finale de trop fait échouer
   * toute connexion avec un message qui ne la mentionne pas. On la refuse ici, où on peut
   * l'expliquer.
   */
  /*
   * Une seule analyse, par `requireUrl` : elle rend le même message pour une valeur qui
   * n'est pas une URL, et ajoute le schéma, l'identifiant dans l'URL, le fragment et la
   * borne de l'exception HTTP. La double analyse qui vivait ici était un reste de la
   * version où seul HTTPS était vérifié — et `eslint .` l'a signalée, pas `eslint
   * <fichier>`. La leçon est sur le lanceur, pas sur la ligne.
   */
  requireUrl("issuer", issuer, env);
  if (issuer.endsWith("/")) {
    throw new OidcConfigError(
      `OATHRION_OIDC: "issuer" must not end with "/". It is compared exactly with the token's ` +
        `\`iss\` field, and one slash too many refuses every sign-in with a reason ` +
        `that does not name it.`,
    );
  }

  const redirectUri = read("redirectUri");
  /*
   * L'URL DE RETOUR, validée comme les autres — et avec une exigence de plus.
   *
   * C'est l'adresse que le fournisseur appellera avec le code d'autorisation. Le
   * fournisseur la compare à sa propre liste, mais Oathrion ne peut pas s'appuyer sur ce
   * contrôle distant : il doit savoir lui-même où il attend le retour, pour refuser un
   * callback qui n'est pas le sien. Un chemin exact, donc, pas un motif.
   */
  const redirectUrl = requireUrl("redirectUri", redirectUri, env);
  if (redirectUrl.search !== "") {
    throw new OidcConfigError(
      `OATHRION_OIDC: "redirectUri" must not carry query parameters. The ` +
        `provider adds \`code\` and \`state\` to it, and a URL that already carries some is ` +
        `compared character by character by the provider — it refuses the sign-in.`,
    );
  }
  if (redirectUrl.pathname !== SSO_CALLBACK_PATH) {
    throw new OidcConfigError(
      `OATHRION_OIDC: "redirectUri" must end with ${SSO_CALLBACK_PATH} — that is the route ` +
        `Oathrion actually exposes. It is ${JSON.stringify(redirectUrl.pathname)}, so the ` +
        `provider would send the user back to an address Oathrion does not serve.`,
    );
  }
  const jitProvisioning = entry.jitProvisioning === true;
  const jitRoleRaw = optional("jitRole") ?? "viewer";
  if (!ROLE_SHAPE.has(jitRoleRaw)) {
    throw new OidcConfigError(
      `OATHRION_OIDC: "jitRole" is ${JSON.stringify(jitRoleRaw)}. The accepted roles are ` +
        `viewer, operator and approver. **admin is refused**: granting administration to ` +
        `anyone signing in for the first time would turn the customer's directory into the list ` +
        `of Oathrion administrators.`,
    );
  }

  const scope = optional("scope") ?? "openid email profile";
  if (!scope.split(/\s+/).includes("openid")) {
    throw new OidcConfigError('OATHRION_OIDC: "scope" must contain "openid".');
  }
  if (!scope.split(/\s+/).includes("email")) {
    throw new OidcConfigError(
      'OATHRION_OIDC: "scope" must contain "email". Oathrion links a provider identity ' +
        "to a console user by their address; without this scope, no token carries it.",
    );
  }

  return {
    issuer,
    clientId: read("clientId"),
    clientSecret: read("clientSecret"),
    redirectUri,
    /*
     * Les points d'entrée : déclarés, ou dérivés de la convention de découverte. La
     * découverte RÉSEAU, elle, est faite par `discover()` au démarrage — pas ici, qui
     * doit rester synchrone et sans effet.
     */
    /*
     * Chacun est validé S'IL est déclaré. Un point d'entrée absent est légitime — la
     * découverte le trouvera — mais un point d'entrée PRÉSENT et faux doit se voir au
     * démarrage, pas à la première connexion d'un utilisateur.
     */
    authorizationEndpoint: endpoint("authorizationEndpoint"),
    tokenEndpoint: endpoint("tokenEndpoint"),
    jwksUri: endpoint("jwksUri"),
    scope,
    requiredAcr: list("requiredAcr"),
    requiredAmr: list("requiredAmr"),
    requireVerifiedEmail: entry.requireVerifiedEmail !== false,
    jitProvisioning,
    jitRole: jitRoleRaw as OidcConfig["jitRole"],
  };
}

/** Les problèmes de la configuration SSO, nommés au démarrage. */
export function oidcConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const production = env.NODE_ENV?.trim() === "production";
  /*
   * L'EXCEPTION HTTP ET LA PRODUCTION NE COEXISTENT PAS, et le refus est jugé AVANT
   * d'analyser la configuration — sinon un `OATHRION_OIDC` par ailleurs invalide masquerait
   * ce problème-ci derrière le sien.
   *
   * Pourquoi un refus et pas un avertissement : le drapeau est posé une fois sur un banc
   * d'essai, puis l'environnement est copié vers la production. C'est le trajet normal
   * d'une variable d'environnement, et personne ne relit celles qui « marchaient ». Un
   * avertissement dans les journaux du démarrage ne serait lu par personne, et le
   * résultat serait un jeton d'identité transporté en clair sur un vrai réseau.
   *
   * Le refus est posé même sans `OATHRION_OIDC` : le drapeau seul, en production, est déjà
   * la trace d'une configuration copiée depuis un banc d'essai.
   */
  if (production && httpExceptionRequested(env)) {
    return [
      "OATHRION_OIDC_ALLOW_HTTP=1 with NODE_ENV=production is REFUSED. This flag only exists " +
        "for a test identity provider on loopback; in production " +
        "it would carry an identity token in cleartext, hence capturable and replayable. " +
        "Remove OATHRION_OIDC_ALLOW_HTTP from the production environment.",
    ];
  }
  try {
    const config = oidcConfigFor(env);
    if (!config) return [];
    const problems: string[] = [];
    /*
     * Les trois points d'entrée vont ensemble : soit les trois sont déclarés, soit aucun
     * et la découverte les trouve. Deux sur trois est la configuration qui démarre et
     * échoue à la première connexion.
     */
    const declared = [config.authorizationEndpoint, config.tokenEndpoint, config.jwksUri].filter(
      (value) => value !== "",
    ).length;
    if (declared !== 0 && declared !== 3) {
      problems.push(
        "OATHRION_OIDC: declare all THREE endpoints (`authorizationEndpoint`, " +
          "`tokenEndpoint`, `jwksUri`) or none — discovery then finds them through " +
          "`/.well-known/openid-configuration`. Two out of three is a configuration that " +
          "starts and fails on the first sign-in.",
      );
    }
    return problems;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/* ------------------------------ la découverte ------------------------------ */

/**
 * Un appel sortant vers le fournisseur, par le transport gardé.
 *
 * Donc : vérification d'adresse au niveau du socket, aucun suivi de redirection, réponse
 * bornée. Une URL de fournisseur est configurable, et une configuration fausse ou
 * malveillante ferait d'Oathrion un client HTTP pointé où l'on veut.
 */
async function fetchJson(url: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new OidcConfigError(`Invalid URL: ${url}`);
  }
  /*
   * L'exception ne s'applique QU'À la boucle locale, et elle est jugée sur la cible
   * RÉELLE de cet appel — pas sur la seule présence du drapeau.
   *
   * La version précédente écrivait `if (!allowLoopback)` : le drapeau seul suffisait à
   * sauter `resolveDownstreamDestination` pour N'IMPORTE QUELLE adresse. Un `issuer` en
   * `http://10.0.0.5` traversait alors la configuration (l'exception levait aussi
   * l'exigence HTTPS) puis la validation de destination (sautée ici), et Oathrion allait
   * porter le `clientSecret` sur le réseau interne. Les deux portes sont refermées : la
   * configuration refuse un hôte non local, et ce test-ci le refuse une seconde fois.
   */
  const localTarget = httpExceptionRequested(env) && isLoopbackHost(target.hostname);
  if (!localTarget) {
    /*
     * La même validation que toute autre sortie, par le même résolveur : l'allowlist
     * d'origines et les règles d'adresse. Le fournisseur d'identité n'a aucune raison
     * d'en être exempté — c'est au contraire la sortie la plus sensible, puisqu'elle
     * reçoit le `clientSecret`.
     */
    const resolved = resolveDownstreamDestination({
      OATHRION_MCP_DOWNSTREAM_URL: target.origin,
      OATHRION_MCP_ALLOWED_DESTINATIONS: env.OATHRION_MCP_ALLOWED_DESTINATIONS,
    } as NodeJS.ProcessEnv);
    if (!resolved) {
      throw new OidcConfigError(
        `The origin ${target.origin} is not allowed for outbound calls. Declare it in ` +
          `OATHRION_MCP_ALLOWED_DESTINATIONS — the token endpoint and the JWKS are ` +
          `often on a different origin than the issuer.`,
      );
    }
  }

  const reply = await sendGuarded({
    url: target,
    method: "GET",
    headers: { accept: "application/json" },
    body: "",
    timeoutMs: 10_000,
    captureBody: true,
    /* La même règle que l'échange de code : la cible décide, pas le drapeau. */
    allowPrivate: localTarget,
  });
  if (!reply.ok) {
    throw new OidcConfigError(`${target.origin} answered ${String(reply.status)}.`);
  }
  try {
    return JSON.parse(reply.body ?? "");
  } catch {
    throw new OidcConfigError(`${target.origin} did not answer with JSON.`);
  }
}

/**
 * Complète la configuration par la découverte, et vérifie que l'émetteur CONCORDE.
 *
 * Le document de découverte porte son propre `issuer`. S'il diffère de celui qu'on a
 * configuré, on refuse : ou bien la configuration est fausse, ou bien quelqu'un répond à
 * la place du fournisseur. Les deux doivent s'arrêter ici et pas après avoir accepté un
 * jeton.
 */
export async function discover(
  config: OidcConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OidcConfig> {
  if (config.authorizationEndpoint && config.tokenEndpoint && config.jwksUri) return config;

  const document = await fetchJson(`${config.issuer}/.well-known/openid-configuration`, env);
  if (typeof document !== "object" || document === null) {
    throw new OidcConfigError("the discovery document is not an object.");
  }
  const found = document as Record<string, unknown>;
  const pick = (field: string): string => {
    const value = found[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new OidcConfigError(`the discovery document does not contain "${field}".`);
    }
    return value.trim();
  };

  const announced = typeof found.issuer === "string" ? found.issuer.trim() : "";
  if (announced !== config.issuer) {
    throw new OidcConfigError(
      `the discovery document announces the issuer ${JSON.stringify(announced)}, and the ` +
        `configuration says ${JSON.stringify(config.issuer)}. Oathrion refuses: either the ` +
        `configuration is wrong, or someone is answering in place of the provider.`,
    );
  }

  return {
    ...config,
    authorizationEndpoint: pick("authorization_endpoint"),
    tokenEndpoint: pick("token_endpoint"),
    jwksUri: pick("jwks_uri"),
  };
}

/* -------------------------------- le trousseau -------------------------------- */

interface CachedKeys {
  keys: Jwk[];
  at: number;
}
const keyCache = new Map<string, CachedKeys>();
/** Dix minutes. Une rotation de clé est rare ; une refetch forcée existe ci-dessous. */
const KEY_TTL_MS = 600_000;

/** Test-only : oublie les trousseaux. */
export function resetOidcKeys(): void {
  keyCache.clear();
}

/**
 * Les clés publiques du fournisseur.
 *
 * `force` existe pour UNE raison précise : la rotation de clé. Quand un jeton porte un
 * `kid` que le trousseau en cache ne connaît pas, l'explication la plus probable n'est pas
 * une attaque mais une rotation — et refuser sans réessayer ferait tomber toutes les
 * connexions jusqu'à l'expiration du cache.
 *
 * Mais une seule fois : un `kid` inconnu qui déclencherait un appel réseau à CHAQUE
 * tentative donnerait à n'importe qui un moyen de faire marteler le fournisseur depuis
 * Oathrion.
 */
export async function jwksFor(
  config: OidcConfig,
  env: NodeJS.ProcessEnv = process.env,
  force = false,
): Promise<Jwk[]> {
  const cached = keyCache.get(config.jwksUri);
  if (!force && cached && Date.now() - cached.at < KEY_TTL_MS) return cached.keys;

  const document = await fetchJson(config.jwksUri, env);
  const keys =
    typeof document === "object" && document !== null && Array.isArray((document as { keys?: unknown }).keys)
      ? ((document as { keys: unknown[] }).keys.filter(
          (key): key is Jwk => typeof key === "object" && key !== null && typeof (key as Jwk).kty === "string",
        ) as Jwk[])
      : [];
  if (keys.length === 0) throw new OidcConfigError("the provider's JWKS contains no readable key.");

  keyCache.set(config.jwksUri, { keys, at: Date.now() });
  return keys;
}

/* ---------------------------- l'état d'une tentative ---------------------------- */

export interface PendingLogin {
  state: string;
  nonce: string;
  /** Là où renvoyer l'utilisateur après la connexion. Toujours un chemin relatif. */
  returnTo: string;
  createdAt: number;
}

/*
 * Les tentatives en cours, en mémoire et bornées.
 *
 * En mémoire parce qu'une tentative dure une minute ou deux : la persister coûterait une
 * écriture par clic sur « se connecter », et un redémarrage au milieu d'une connexion
 * demande simplement de recommencer.
 *
 * Conséquence à connaître, et elle est documentée : derrière DEUX INSTANCES sans affinité
 * de session, le retour du fournisseur peut atterrir sur l'instance qui n'a pas émis
 * l'état, et la connexion est refusée. C'est le sens sûr — un état inconnu ne doit jamais
 * être accepté — mais c'est une contrainte de déploiement, pas un détail.
 */
const pending = new Map<string, PendingLogin>();
const PENDING_TTL_MS = 600_000;
const PENDING_MAX = 500;

/** Un identifiant imprévisible. 32 octets : pas un compteur, pas un horodatage. */
const opaque = (): string => randomBytes(32).toString("base64url");

/**
 * Ouvre une tentative et rend son `state` et son `nonce`.
 *
 * Les deux sont distincts et servent à des choses différentes, ce qui est la raison pour
 * laquelle il y en a deux : le `state` revient dans l'URL et protège du CSRF — il prouve
 * que ce retour répond à une demande d'Oathrion ; le `nonce` va dans le JETON et protège du
 * rejeu — il prouve que ce jeton a été émis pour cette demande-là. Réutiliser le même
 * pour les deux rôles mettrait dans l'URL une valeur qui doit rester dans le jeton.
 */
export function startLogin(returnTo: string): PendingLogin {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (now - value.createdAt > PENDING_TTL_MS) pending.delete(key);
  }
  if (pending.size >= PENDING_MAX) {
    /*
     * La plus ancienne est évincée plutôt que de refuser la nouvelle : perdre une
     * tentative abandonnée ne coûte rien, refuser la tentative en cours empêcherait
     * quelqu'un de se connecter.
     */
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }

  const entry: PendingLogin = {
    state: opaque(),
    nonce: opaque(),
    /*
     * Un CHEMIN RELATIF, et jamais une URL. Accepter `returnTo=https://ailleurs` ferait
     * de la page de connexion d'Oathrion une redirection ouverte — le tremplin classique
     * d'un hameçonnage crédible, parce que le lien part bien du domaine du client.
     */
    returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/",
    createdAt: now,
  };
  pending.set(entry.state, entry);
  return entry;
}

/** Reprend une tentative, UNE SEULE FOIS. */
export function takeLogin(state: string, now = Date.now()): PendingLogin | null {
  const entry = pending.get(state);
  if (!entry) return null;
  /*
   * Supprimée à la reprise : un `state` est à usage unique. Sans ça, un retour capturé —
   * dans un journal de serveur mandataire, dans l'historique — serait rejouable tant que
   * le jeton du fournisseur reste valide.
   */
  pending.delete(state);
  if (now - entry.createdAt > PENDING_TTL_MS) return null;
  return entry;
}

/** Test-only : combien de tentatives attendent. */
export function pendingLoginCount(): number {
  return pending.size;
}

/* ------------------------------ l'échange du code ------------------------------ */

export interface TokenExchange {
  idToken: string;
}

/**
 * Échange le code contre des jetons, et NE GARDE QUE LE JETON D'IDENTITÉ.
 *
 * Le jeton d'accès et le jeton de rafraîchissement du fournisseur sont ignorés. Oathrion
 * n'appelle aucune API en son nom : il a besoin d'une preuve d'identité, une fois. Les
 * garder serait stocker un credential sans usage, donc un risque sans bénéfice.
 */
export async function exchangeCode(
  config: OidcConfig,
  code: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TokenExchange> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let target: URL;
  try {
    target = new URL(config.tokenEndpoint);
  } catch {
    throw new OidcConfigError(`the token endpoint is not a URL — ${config.tokenEndpoint}`);
  }

  const reply = await sendGuarded({
    url: target,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
    timeoutMs: 15_000,
    captureBody: true,
    /*
     * `allowPrivate` suit la CIBLE, pas le drapeau. Cet appel-ci transporte le
     * `clientSecret` : lui accorder le réseau privé parce qu'un drapeau est posé
     * quelque part serait l'exfiltration la moins coûteuse à provoquer.
     */
    allowPrivate: httpExceptionRequested(env) && isLoopbackHost(target.hostname),
  });

  if (!reply.ok) {
    /*
     * Le STATUT, jamais le corps : une réponse d'erreur OAuth peut renvoyer la requête en
     * écho, donc le `client_secret`.
     */
    throw new OidcConfigError(`the token endpoint answered ${String(reply.status)}.`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(reply.body ?? "");
  } catch {
    throw new OidcConfigError("the token endpoint did not answer with JSON.");
  }
  const body = payload as Record<string, unknown>;
  const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
  if (idToken === "") {
    throw new OidcConfigError(
      "the token endpoint response contains no `id_token`. Oathrion only uses " +
        "that one — check that the `openid` scope is requested.",
    );
  }
  return { idToken };
}

/** L'URL vers laquelle envoyer le navigateur. */
export function authorizationUrl(config: OidcConfig, login: PendingLogin): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", login.state);
  url.searchParams.set("nonce", login.nonce);
  /*
   * `acr_values` DEMANDE au fournisseur l'authentification forte. C'est une demande, pas
   * une garantie : ce qui garantit est la vérification de l'attestation dans le jeton au
   * retour. Les deux ensemble — demander et vérifier — sont la bonne forme ; vérifier
   * sans demander ferait échouer des connexions que le fournisseur aurait pu réussir.
   */
  if (config.requiredAcr.length > 0) url.searchParams.set("acr_values", config.requiredAcr.join(" "));
  return url.toString();
}

/** L'empreinte d'un `state`, pour les journaux : jamais la valeur. */
export function stateFingerprint(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex").slice(0, 8);
}
