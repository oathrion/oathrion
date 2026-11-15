/**
 * AWS Signature Version 4 : signer la requête au lieu d'injecter un en-tête.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Oathrion injectait un en-tête statique, et sait maintenant échanger un jeton court
 * (`oauth.ts`). Les deux supposent la même chose : que le credential est une VALEUR qu'on
 * pose dans un en-tête. AWS ne marche pas comme ça — il faut **signer la requête**, et la
 * signature dépend de la méthode, du chemin, de la chaîne de requête, des en-têtes et du
 * HACHAGE DU CORPS. Aucun en-tête statique ne peut la produire.
 *
 * Conséquence, jusqu'ici : toute API AWS était hors de portée du pare-feu. S3, Bedrock,
 * Lambda, SQS, DynamoDB — et Bedrock est l'API de modèle d'un client qui est déjà chez
 * AWS, donc exactement le cas d'usage que `stream: true` vient d'ouvrir ailleurs.
 *
 * ## CE QUE SIGNER CHANGE POUR LA GARANTIE DE OATHRION
 *
 * C'est un RENFORCEMENT, et il vaut la peine d'être dit. Avec un en-tête statique, la
 * garantie est « l'agent n'a pas la clé ». Avec une signature, la garantie devient « la
 * requête elle-même est scellée » : un agent ne peut pas faire signer une requête puis en
 * envoyer une autre, puisque le chemin, la méthode, les en-têtes signés et le hachage du
 * corps sont dans la signature. Modifier un octet invalide tout.
 *
 * ## CE QUI EST VÉRIFIÉ, ET CE QUI NE L'EST PAS
 *
 * L'implémentation suit la spécification d'AWS — « Create a signed AWS API request » —
 * dont les quatre étapes sont reprises telles quelles ci-dessous, y compris les règles
 * d'encodage d'URI et l'ordre de dérivation de la clé.
 *
 * Elle est éprouvée contre une SECONDE IMPLÉMENTATION écrite dans le test depuis ce même
 * texte, et contre les propriétés que la spécification fixe. Elle n'est PAS éprouvée
 * contre les vecteurs du banc d'essai publié par AWS — ils n'étaient pas accessibles — ni
 * contre un vrai point d'entrée AWS : ce dépôt n'a pas de credential AWS et n'en
 * fabriquera pas. **Un pilote doit faire un appel réel avant de s'y fier**, et c'est écrit
 * dans `docs/firewall.md`.
 */

import { createHash, createHmac } from "node:crypto";

export const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigV4Config {
  region: string;
  service: string;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Pour des credentials temporaires (STS, rôle IAM). */
  sessionToken?: string;
}

export class SigV4ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigV4ConfigError";
  }
}

/** `aws-bedrock` → `OATHRION_SIGV4_AWS_BEDROCK`. Même règle que les autres par destination. */
export function sigv4VariableFor(destinationId: string): string {
  return `OATHRION_SIGV4_${destinationId.replace(/-/g, "_").toUpperCase()}`;
}

/*
 * La région et le service ne sont pas devinés depuis l'hôte.
 *
 * On POURRAIT lire `bedrock-runtime.eu-west-3.amazonaws.com` et en extraire les deux.
 * Trois raisons de ne pas le faire : les points d'entrée globaux n'ont pas de région dans
 * leur nom (`iam.amazonaws.com` est `us-east-1`), certains services en ont un nom
 * différent de leur sous-domaine, et une déduction fausse produit une signature invalide
 * dont le message d'AWS ne dira pas qu'elle vient d'une mauvaise région. L'exploitant les
 * déclare.
 */
const REGION_SHAPE = /^[a-z0-9-]{3,32}$/;
const SERVICE_SHAPE = /^[a-z0-9-]{2,32}$/;

export function sigv4ConfigFor(
  destinationId: string,
  env: NodeJS.ProcessEnv = process.env,
): SigV4Config | null {
  const variable = sigv4VariableFor(destinationId);
  const raw = env[variable]?.trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SigV4ConfigError(
      `${variable} is not valid JSON. Expected: {"region":"eu-west-3","service":"bedrock"}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SigV4ConfigError(`${variable} must be a JSON object.`);
  }
  const entry = parsed as Record<string, unknown>;
  const region = typeof entry.region === "string" ? entry.region.trim() : "";
  const service = typeof entry.service === "string" ? entry.service.trim() : "";

  if (!REGION_SHAPE.test(region)) {
    throw new SigV4ConfigError(
      `${variable}: "region" is ${JSON.stringify(entry.region)}, which is not a region ` +
        `code (lowercase letters, digits and dashes). AWS does not infer the region from the host, and ` +
        `neither does Oathrion: a wrong region produces an invalid signature whose AWS message ` +
        `will not tell the cause.`,
    );
  }
  if (!SERVICE_SHAPE.test(service)) {
    throw new SigV4ConfigError(
      `${variable}: "service" is ${JSON.stringify(entry.service)}, which is not a service ` +
        `code (for example "s3", "bedrock", "execute-api").`,
    );
  }
  return { region, service };
}

/** Les problèmes de toutes les configurations SigV4, pour le contrôle de démarrage. */
export function sigv4ConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("OATHRION_SIGV4_")) continue;
    try {
      sigv4ConfigFor(name.slice("OATHRION_SIGV4_".length).toLowerCase().replace(/_/g, "-"), env);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

/**
 * Les credentials, lus depuis le coffre.
 *
 * Deux formes acceptées, et c'est délibéré : le JSON est le seul qui porte un jeton de
 * session, et la forme courte `AKIA…:secret` est celle qu'un exploitant tape le plus
 * naturellement. Refuser la seconde l'obligerait à écrire du JSON dans un champ de
 * formulaire, ce qui produit surtout des erreurs de guillemets.
 */
export function parseSigV4Credentials(secret: string): SigV4Credentials {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new SigV4ConfigError(
        "The credential for this destination starts with \"{\" but is not valid JSON. " +
          'Expected: {"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"} or ' +
          "the short form AKIA…:secret.",
      );
    }
    const entry = parsed as Record<string, unknown>;
    const accessKeyId = typeof entry.accessKeyId === "string" ? entry.accessKeyId.trim() : "";
    const secretAccessKey = typeof entry.secretAccessKey === "string" ? entry.secretAccessKey.trim() : "";
    if (accessKeyId === "" || secretAccessKey === "") {
      throw new SigV4ConfigError(
        "The JSON credential for this destination must carry `accessKeyId` and `secretAccessKey`.",
      );
    }
    const out: SigV4Credentials = { accessKeyId, secretAccessKey };
    const sessionToken = entry.sessionToken;
    if (typeof sessionToken === "string" && sessionToken.trim() !== "") {
      out.sessionToken = sessionToken.trim();
    }
    return out;
  }

  /*
   * `indexOf` et non `split` : une clé secrète AWS peut contenir des « : » — l'alphabet
   * base64 ne les produit pas, mais rien ne garantit que la valeur n'a pas été collée avec
   * un préfixe. Couper au PREMIER séparateur laisse le reste intact.
   */
  const at = trimmed.indexOf(":");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new SigV4ConfigError(
      "The credential for this destination must be \"<accessKeyId>:<secretAccessKey>\" or " +
        "a JSON object. No signature was computed.",
    );
  }
  return {
    accessKeyId: trimmed.slice(0, at),
    secretAccessKey: trimmed.slice(at + 1),
  };
}

/* ----------------------------- les primitives ----------------------------- */

const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/**
 * L'encodage d'URI d'AWS, qui n'est PAS `encodeURIComponent`.
 *
 * La spécification est explicite et la différence est réelle : `encodeURIComponent`
 * laisse passer `!`, `'`, `(`, `)` et `*`, qu'AWS exige encodés. Un seul de ces
 * caractères dans un nom de paramètre suffit à produire une signature que le service
 * refuse — et le message d'AWS parle alors de « signature mismatch », sans dire quel
 * octet diverge.
 *
 * AWS recommande d'ailleurs explicitement d'écrire sa propre fonction plutôt que
 * d'employer celle de la plateforme.
 */
export function awsUriEncode(value: string, encodeSlash: boolean): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)) {
      out += char;
    } else if (char === "-" || char === "." || char === "_" || char === "~") {
      out += char;
    } else if (char === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      /* Majuscules exigées par la spécification : « %1A », pas « %1a ». */
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** `20130524T000000Z` et `20130524`. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").split(".")[0]!}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignedRequest {
  /** Les en-têtes à AJOUTER à la requête, déjà prêts. */
  headers: Record<string, string>;
  /** Exposés pour les tests et le diagnostic : jamais journalisés. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Signe une requête sortante.
 *
 * ## L'ORDRE DES QUATRE ÉTAPES EST LA SPÉCIFICATION
 *
 *   1. la requête canonique — méthode, URI encodée, chaîne de requête triée APRÈS
 *      encodage, en-têtes canoniques triés, liste des en-têtes signés, hachage du corps ;
 *   2. son hachage ;
 *   3. la chaîne à signer — algorithme, horodatage, portée, hachage de l'étape 2 ;
 *   4. la clé dérivée, par quatre HMAC successifs : date, région, service, `aws4_request`.
 *
 * ## CE QUI EST SIGNÉ, ET POURQUOI PAS PLUS
 *
 * `host` et `x-amz-date` sont obligatoires. `x-amz-content-sha256` est exigé par S3 et
 * inoffensif ailleurs. `content-type` est signé QUAND IL EST PRÉSENT, parce qu'il change
 * la façon dont le service interprète le corps. `x-amz-security-token` est signé quand il
 * existe — certains services l'exigent dans la requête canonique.
 *
 * Rien d'autre. La spécification met en garde contre la signature des en-têtes « sautés »
 * — `connection`, `transfer-encoding`, `keep-alive`, `user-agent` — qu'un répartiteur ou
 * un proxy réécrit en transit : les signer fait échouer la requête quelque part entre
 * Oathrion et AWS, de façon intermittente et sans cause lisible. `content-length`, que le
 * transport ajoute APRÈS la signature, est hors signature pour la même raison.
 */
export function signSigV4(params: {
  method: string;
  url: URL;
  /** Les en-têtes déjà prêts à partir. Seuls ceux nommés ci-dessus sont signés. */
  headers: Record<string, string>;
  /** Le corps BRUT, octet pour octet — c'est lui qui est haché. */
  body: string;
  /**
   * L'encodage du corps. Doit être CELUI DU TRANSPORT, sinon la signature couvre d'autres
   * octets que ceux qui partent — et AWS répond « signature mismatch » sur une requête
   * parfaitement formée.
   */
  bodyEncoding?: "utf8" | "latin1";
  config: SigV4Config;
  credentials: SigV4Credentials;
  now?: Date;
}): SignedRequest {
  const { url, config, credentials } = params;
  const method = params.method.toUpperCase();
  const { amzDate, dateStamp } = amzDates(params.now ?? new Date());

  /*
   * Le hachage du CORPS BRUT. Le même corps que le relais envoie, octet pour octet : un
   * corps re-sérialisé donnerait un hachage différent, donc une signature invalide. C'est
   * la deuxième fois que la distinction « corps brut / corps parsé » décide de quelque
   * chose dans ce dépôt.
   */
  const payloadHash = sha256Hex(Buffer.from(params.body, params.bodyEncoding ?? "utf8"));

  /*
   * LE CHEMIN CANONIQUE. Chaque segment est encodé, mais PAS les « / » qui les séparent —
   * la spécification le dit, et encoder les séparateurs ferait d'un chemin une clé d'objet.
   */
  const canonicalUri =
    url.pathname === ""
      ? "/"
      : url.pathname
          .split("/")
          .map((segment) => awsUriEncode(decodeURIComponent(segment), true))
          .join("/");

  /*
   * LA CHAÎNE DE REQUÊTE, triée APRÈS encodage — l'ordre porte sur les octets encodés et
   * non sur les noms d'origine, et les deux diffèrent dès qu'un nom contient un caractère
   * à encoder.
   */
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    pairs.push([awsUriEncode(name, true), awsUriEncode(value, true)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = pairs.map(([name, value]) => `${name}=${value}`).join("&");

  /* Les en-têtes à signer, construits ici et pas pris de l'appelant. */
  const toSign: Record<string, string> = {
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  const contentType = params.headers["content-type"] ?? params.headers["Content-Type"];
  if (contentType !== undefined && contentType !== "") toSign["content-type"] = contentType;
  if (credentials.sessionToken) toSign["x-amz-security-token"] = credentials.sessionToken;

  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names
    .map((name) => {
      /*
       * `Trim()` de la spécification : espaces de bord retirés, et suites d'espaces
       * internes réduites à un seul. Omettre la seconde partie est l'erreur classique —
       * elle ne se voit que sur un en-tête qui en contient, donc rarement, donc tard.
       */
      const value = toSign[name]!.trim().replace(/\s+/g, " ");
      return `${name}:${value}\n`;
    })
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  const stringToSign = [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  /* La dérivation, dans cet ordre exact : date, région, service, terminaison. */
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const dateRegionKey = hmac(dateKey, config.region);
  const dateRegionServiceKey = hmac(dateRegionKey, config.service);
  const signingKey = hmac(dateRegionServiceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const headers: Record<string, string> = {
    /*
     * Pas de virgule entre l'algorithme et `Credential`, et des virgules entre les trois
     * autres : la spécification l'écrit ainsi, et un service refuse l'autre forme.
     */
    authorization:
      `${SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  return { headers, canonicalRequest, stringToSign, signature };
}
