/**
 * LA VÉRIFICATION D'UN JETON D'IDENTITÉ — l'endroit où une faute donne une session
 * d'administrateur à n'importe qui.
 *
 * ## Pourquoi ce fichier est écrit si prudemment
 *
 * Un jeton d'identité OIDC est une chaîne que le NAVIGATEUR apporte. Tout ce qui la rend
 * digne de confiance est dans cette vérification. Les fautes classiques ne sont pas
 * théoriques, elles ont toutes un exploit publié :
 *
 *   · **`alg: none`** — le jeton se déclare non signé, et un vérificateur naïf le croit.
 *     Quiconque peut alors forger `{"email":"admin@acme.com"}` et obtenir une session.
 *   · **La confusion d'algorithme** — le jeton se déclare `HS256`, et un vérificateur qui
 *     choisit l'algorithme D'APRÈS L'EN-TÊTE utilise la clé PUBLIQUE du fournisseur comme
 *     secret HMAC. Cette clé est publique : l'attaquant signe lui-même.
 *   · **`iss` non vérifié** — n'importe quel fournisseur OIDC du monde, y compris celui
 *     que l'attaquant vient de créer, devient acceptable.
 *   · **`aud` non vérifié** — un jeton émis pour une AUTRE application du même
 *     fournisseur est accepté ici. Sur un IdP d'entreprise, c'est une escalade entre
 *     applications.
 *   · **`nonce` absent ou rejouable** — un jeton capturé une fois sert indéfiniment.
 *   · **`kid` ignoré** — l'attaquant choisit quelle clé du JWKS valide son jeton, ou
 *     fournit la sienne.
 *
 * Chacune de ces fautes est un test de `server/test/oidc-token.test.ts`, et chaque test
 * vérifie que le jeton est REFUSÉ.
 *
 * ## Ce que ce module NE fait pas
 *
 * Il ne parle pas au réseau. La récupération du JWKS et la découverte vivent dans
 * `oidc.ts`, qui passe par le transport gardé — ce fichier-ci reçoit des clés déjà
 * obtenues et ne fait que des mathématiques et des comparaisons. C'est ce qui le rend
 * éprouvable exhaustivement : un test peut fabriquer n'importe quel jeton tordu sans
 * serveur.
 *
 * ## Et pas de bibliothèque
 *
 * `node:crypto` importe une JWK et vérifie une signature RSA ou ECDSA depuis la
 * bibliothèque standard. Une dépendance de plus sur le chemin d'authentification est une
 * dépendance de plus à auditer, et ce dépôt compte les siennes.
 */

import {
  constants,
  createPublicKey,
  createVerify,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

/**
 * Les algorithmes acceptés, et RIEN d'autre.
 *
 * Une LISTE D'AUTORISATION, et asymétrique uniquement. Un algorithme symétrique (`HS*`)
 * est absent par construction, pas par oubli : la clé de vérification vient d'un JWKS
 * public, et accepter un HMAC permettrait de signer avec cette clé publique. C'est la
 * confusion d'algorithme, et la seule défense robuste est de ne jamais laisser l'en-tête
 * du jeton choisir la famille.
 */
/*
 * LA LISTE EST EXPORTÉE, et ce n'est pas pour la commodité des tests — c'est le garde
 * qui manquait. La version précédente annonçait neuf algorithmes et n'en éprouvait que
 * deux ; trois des sept autres (PS256/384/512) refusaient en réalité toute signature
 * valide, et rien ne le disait. Un test qui ITÈRE sur cette liste transforme l'ajout
 * d'un algorithme non éprouvé en échec de suite, au lieu d'une promesse non tenue.
 */
export const ACCEPTED_ALGORITHMS = [
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
] as const;

const ALLOWED_ALGORITHMS = new Set<string>(ACCEPTED_ALGORITHMS);

/** La tolérance d'horloge entre Oathrion et le fournisseur. */
export const OIDC_CLOCK_SKEW_MS = 120_000;

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  /** La partie qui a DEMANDÉ le jeton — exigée dès que `aud` est multiple. */
  azp?: string;
  exp: number;
  iat: number;
  /** « Pas avant » : optionnel, mais honoré s'il est présent. */
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  acr?: string;
  amr?: string[];
  [claim: string]: unknown;
}

export type TokenRefusal =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_authorized_party"
  | "not_yet_valid"
  | "expired"
  | "issued_in_future"
  | "nonce_mismatch"
  | "subject_missing"
  | "email_missing"
  | "email_unverified"
  | "mfa_not_attested";

export type TokenVerdict =
  | { ok: true; claims: IdTokenClaims; email: string }
  | { ok: false; refusal: TokenRefusal; detail: string };

/** base64url → Buffer, sans tolérance : un caractère hors alphabet refuse. */
function fromBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

interface Decoded {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  claims: IdTokenClaims;
  signingInput: string;
  signature: Buffer;
}

/**
 * Découpe et décode, SANS rien vérifier.
 *
 * Séparé de la vérification pour que la lecture du `kid` — nécessaire pour choisir la clé
 * — ne puisse pas être confondue avec une validation. Un appelant qui n'utiliserait que
 * cette fonction n'aurait rien vérifié du tout, et son nom le dit.
 */
export function decodeIdToken(token: string): Decoded | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const headerBytes = fromBase64Url(rawHeader);
  const payloadBytes = fromBase64Url(rawPayload);
  const signature = fromBase64Url(rawSignature);
  if (!headerBytes || !payloadBytes || !signature) return null;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(headerBytes.toString("utf8")) as Record<string, unknown>;
    claims = JSON.parse(payloadBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;

  return {
    header: header as Decoded["header"],
    claims: claims as unknown as IdTokenClaims,
    signingInput: `${rawHeader}.${rawPayload}`,
    signature,
  };
}

/** La correspondance entre un algorithme JWS et ce que `node:crypto` attend. */
function digestFor(algorithm: string): { hash: string; scheme: "rsa" | "pss" | "ec" } | null {
  const bits = algorithm.slice(2);
  const hash = bits === "256" ? "sha256" : bits === "384" ? "sha384" : bits === "512" ? "sha512" : null;
  if (hash === null) return null;
  if (algorithm.startsWith("RS")) return { hash, scheme: "rsa" };
  if (algorithm.startsWith("PS")) return { hash, scheme: "pss" };
  if (algorithm.startsWith("ES")) return { hash, scheme: "ec" };
  return null;
}

/**
 * Vérifie la signature d'un jeton avec une JWK.
 *
 * L'algorithme vient de l'EN-TÊTE DU JETON **après** avoir été confronté à la liste
 * d'autorisation ET au type de la clé : une clé RSA ne vérifie jamais un `ES*`, et une
 * clé EC ne vérifie jamais un `RS*`. Sans ce second contrôle, un attaquant pourrait
 * annoncer un algorithme dont l'implémentation interprète la clé autrement.
 */
function signatureIsValid(decoded: Decoded, jwk: Jwk, algorithm: string): boolean {
  const spec = digestFor(algorithm);
  if (!spec) return false;
  if (spec.scheme === "ec" && jwk.kty !== "EC") return false;
  if ((spec.scheme === "rsa" || spec.scheme === "pss") && jwk.kty !== "RSA") return false;

  let key;
  try {
    key = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
  } catch {
    return false;
  }

  const data = Buffer.from(decoded.signingInput, "utf8");
  try {
    if (spec.scheme === "pss") {
      /*
       * LES CONSTANTES NOMMÉES, ET PAS DES LITTÉRAUX — et ce n'est pas une préférence de
       * style, c'est la correction d'un défaut mesuré.
       *
       * La première version écrivait `padding: 6` et `saltLength: 0`, avec un commentaire
       * qui annonçait `RSA_PSS_SALTLEN_DIGEST`. Le commentaire disait l'inverse du code :
       * `RSA_PSS_SALTLEN_DIGEST` vaut **-1**, et `0` demande un sel de LONGUEUR NULLE.
       *
       * Conséquence mesurée : PS256, PS384 et PS512 REFUSAIENT TOUTE SIGNATURE VALIDE.
       * La RFC 7518 §3.5 fixe la longueur de sel à celle du condensat, donc aucun jeton
       * d'un vrai fournisseur ne pouvait passer — alors que les trois algorithmes étaient
       * ANNONCÉS dans la liste d'autorisation. Un client dont l'IdP signe en PS256 aurait
       * vu toutes ses connexions refusées pour « bad_signature », ce qui désigne la
       * mauvaise cause : il aurait cherché une clé fausse ou un JWKS périmé.
       *
       * Et aucun test ne l'attrapait, parce que les tests couvraient RS256 et ES256 — les
       * deux seuls algorithmes réellement exercés sur six annoncés. Un algorithme non
       * éprouvé n'a rien à faire dans une liste d'autorisation.
       */
      return cryptoVerify(
        spec.hash,
        data,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        decoded.signature,
      );
    }
    if (spec.scheme === "ec") {
      /*
       * `dsaEncoding: "ieee-p1363"` : un JWS porte la signature ECDSA en r||s brut, pas
       * en DER. Sans cette option, Node attend du DER et toute signature ES256 valide
       * serait refusée — une panne franche, mais une panne.
       */
      return cryptoVerify(spec.hash, data, { key, dsaEncoding: "ieee-p1363" }, decoded.signature);
    }
    const verifier = createVerify(spec.hash);
    verifier.update(data);
    verifier.end();
    return verifier.verify(key, decoded.signature);
  } catch {
    return false;
  }
}

/** Comparaison à temps constant de deux chaînes, longueurs vérifiées d'abord. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface VerifyOptions {
  /** L'émetteur ATTENDU, comparé exactement. */
  issuer: string;
  /** L'identifiant client de cette application. */
  audience: string;
  /** Le `nonce` qu'Oathrion a émis pour CETTE tentative de connexion. */
  nonce: string;
  /** Les clés publiques du fournisseur. */
  keys: readonly Jwk[];
  /**
   * Les valeurs d'`acr` acceptées, ou les méthodes `amr` exigées.
   *
   * Vide = aucune exigence. Non vide = **le jeton doit attester** d'une authentification
   * forte, et un fournisseur qui n'en atteste pas fait refuser l'accès. C'est la seule
   * façon honnête pour Oathrion de « faire du MFA » : il ne l'exécute pas, il en exige la
   * preuve.
   */
  requiredAcr?: readonly string[];
  requiredAmr?: readonly string[];
  /** Exiger `email_verified`. Par défaut oui : une adresse non vérifiée est revendiquée, pas prouvée. */
  requireVerifiedEmail?: boolean;
  now?: number;
}

/**
 * Vérifie un jeton d'identité de bout en bout.
 *
 * L'ORDRE DES CONTRÔLES est délibéré : la signature AVANT les revendications. Lire `iss`
 * ou `email` d'un jeton non vérifié pour décider quoi que ce soit — même un message
 * d'erreur — c'est faire confiance à une chaîne fournie par l'attaquant. Seul le `kid`
 * est lu avant, parce qu'il faut bien choisir une clé, et un `kid` inconnu refuse.
 */
export function verifyIdToken(token: string, options: VerifyOptions): TokenVerdict {
  const decoded = decodeIdToken(token);
  if (!decoded) {
    return { ok: false, refusal: "malformed", detail: "the token does not have three readable base64url segments" };
  }

  const algorithm = typeof decoded.header.alg === "string" ? decoded.header.alg : "";
  if (!ALLOWED_ALGORITHMS.has(algorithm)) {
    /*
     * `alg: none` et `HS256` finissent ICI, avant toute autre considération. C'est le
     * refus le plus important du fichier : il ferme à la fois le jeton non signé et la
     * confusion d'algorithme, et il le fait par une liste d'autorisation — donc un
     * algorithme futur inconnu est refusé lui aussi, plutôt que toléré.
     */
    return {
      ok: false,
      refusal: "unsupported_algorithm",
      detail: `the algorithm ${JSON.stringify(algorithm)} is not accepted. Only asymmetric signatures are`,
    };
  }

  const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : null;
  /*
   * Les clés candidates. Avec un `kid`, exactement celle-là : laisser essayer toutes les
   * clés rendrait le `kid` décoratif, et un attaquant pourrait faire valider son jeton
   * par n'importe quelle clé du trousseau. Sans `kid` — certains fournisseurs n'en
   * mettent pas quand ils n'ont qu'une clé — on accepte l'unique clé compatible.
   */
  const candidates = kid === null
    ? options.keys.filter((key) => key.kty === (algorithm.startsWith("ES") ? "EC" : "RSA"))
    : options.keys.filter((key) => key.kid === kid);
  if (candidates.length === 0) {
    return {
      ok: false,
      refusal: "unknown_key",
      detail: kid === null ? "no compatible key in the key set" : `no key in the key set has the kid ${JSON.stringify(kid)}`,
    };
  }

  const signed = candidates.some((key) => signatureIsValid(decoded, key, algorithm));
  if (!signed) {
    return { ok: false, refusal: "bad_signature", detail: "the signature does not match the provider's key" };
  }

  /* ─── À partir d'ici, et seulement ici, les revendications sont dignes de lecture. ─── */
  const claims = decoded.claims;
  const now = options.now ?? Date.now();

  if (typeof claims.iss !== "string" || !constantTimeEquals(claims.iss, options.issuer)) {
    return {
      ok: false,
      refusal: "wrong_issuer",
      detail: "the token issuer is not the configured one",
    };
  }

  /*
   * `aud` est une chaîne OU un tableau, selon le fournisseur. Les deux formes sont
   * acceptées et l'appartenance est exigée : un jeton émis pour une AUTRE application du
   * même fournisseur ne doit pas ouvrir de session ici.
   */
  const audiences = Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === "string" ? [claims.aud] : [];
  if (!audiences.some((value) => typeof value === "string" && constantTimeEquals(value, options.audience))) {
    return {
      ok: false,
      refusal: "wrong_audience",
      detail: "the token was issued for another application",
    };
  }

  /*
   * `azp` — LA PARTIE AUTORISÉE, quand le jeton porte plusieurs audiences.
   *
   * OpenID Connect Core §3.1.3.7 règle 3 : si `aud` contient plusieurs valeurs, le client
   * doit vérifier qu'`azp` est présent et qu'il le désigne. La raison est précise, et le
   * contrôle d'appartenance ci-dessus ne la couvre PAS.
   *
   * Un fournisseur peut émettre un jeton dont `aud` vaut `["autre-application",
   * "placet-console"]` : l'autre application l'a demandé, Oathrion y figure comme
   * destinataire secondaire. L'appartenance est donc satisfaite — `placet-console` est
   * bien dans la liste — alors que le jeton a été émis À LA DEMANDE d'une autre
   * application. Si cette autre application est compromise, ou simplement moins
   * regardante, son jeton ouvre une session de console ici. `azp` dit QUI a demandé le
   * jeton, et c'est la seule revendication qui le dise.
   *
   * Quand `aud` est unique, `azp` reste optionnel (la spécification ne l'exige pas) —
   * mais s'il est présent, il est vérifié : un `azp` qui désigne quelqu'un d'autre est
   * une contradiction, et une contradiction dans un jeton se refuse.
   */
  const azp = claims.azp;
  if (azp !== undefined && azp !== null) {
    if (typeof azp !== "string" || !constantTimeEquals(azp, options.audience)) {
      return {
        ok: false,
        refusal: "wrong_authorized_party",
        detail: "the token was requested by an application other than this one",
      };
    }
  } else if (audiences.length > 1) {
    return {
      ok: false,
      refusal: "wrong_authorized_party",
      detail:
        "the token carries several audiences without `azp`. There is no way to know which " +
        "application requested it, so no way to assert it was issued for this one",
    };
  }

  if (typeof claims.exp !== "number" || claims.exp * 1000 + OIDC_CLOCK_SKEW_MS < now) {
    return { ok: false, refusal: "expired", detail: "the token has expired" };
  }
  /*
   * `nbf` — PAS AVANT. Optionnel dans un jeton d'identité, donc absent chez la plupart
   * des fournisseurs ; mais présent, il doit être honoré. Un jeton pré-émis pour plus
   * tard est exactement ce qu'un attaquant veut d'une fuite de journaux : il attend que
   * la fenêtre s'ouvre. Ignorer `nbf` rendrait cette attente inutile.
   *
   * La tolérance d'horloge joue dans l'autre sens qu'`exp` : on accepte un jeton dont le
   * `nbf` est à peine dans le futur, parce que c'est l'horloge du fournisseur qui avance.
   */
  if (claims.nbf !== undefined && claims.nbf !== null) {
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) {
      return { ok: false, refusal: "malformed", detail: "`nbf` is not a number" };
    }
    if (claims.nbf * 1000 - OIDC_CLOCK_SKEW_MS > now) {
      return {
        ok: false,
        refusal: "not_yet_valid",
        detail: "the token is not valid yet",
      };
    }
  }
  if (typeof claims.iat !== "number" || claims.iat * 1000 - OIDC_CLOCK_SKEW_MS > now) {
    /*
     * Un jeton daté du futur est aussi suspect qu'un jeton périmé : il resterait valable
     * bien au-delà de la fenêtre que son `exp` suggère.
     */
    return { ok: false, refusal: "issued_in_future", detail: "the token is dated in the future" };
  }

  if (typeof claims.nonce !== "string" || !constantTimeEquals(claims.nonce, options.nonce)) {
    /*
     * Le `nonce` lie ce jeton à CETTE tentative de connexion, celle qu'Oathrion a
     * déclenchée. Sans lui, un jeton valide capturé ailleurs — dans un journal de proxy,
     * dans l'historique d'un navigateur partagé — ouvrirait une session ici.
     */
    return { ok: false, refusal: "nonce_mismatch", detail: "the token does not answer this sign-in attempt" };
  }

  if (typeof claims.sub !== "string" || claims.sub.trim() === "") {
    return { ok: false, refusal: "subject_missing", detail: "the token has no subject" };
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (email === "" || !email.includes("@")) {
    return {
      ok: false,
      refusal: "email_missing",
      detail:
        "the token has no email address. Oathrion links a provider identity to a " +
        "console user by their address: ask your provider for the `email` scope",
    };
  }
  if (options.requireVerifiedEmail !== false && claims.email_verified !== true) {
    /*
     * Une adresse non vérifiée est REVENDIQUÉE, pas prouvée. Sur un fournisseur qui
     * autorise l'auto-inscription, quelqu'un peut déclarer l'adresse d'un administrateur
     * sans la posséder — et la correspondance d'Oathrion se fait sur l'adresse.
     */
    return {
      ok: false,
      refusal: "email_unverified",
      detail: "the token's address is not marked as verified by the provider",
    };
  }

  /* ─── L'attestation d'authentification forte, quand elle est exigée. ─── */
  const requiredAcr = options.requiredAcr ?? [];
  const requiredAmr = options.requiredAmr ?? [];
  if (requiredAcr.length > 0 || requiredAmr.length > 0) {
    const acr = typeof claims.acr === "string" ? claims.acr : null;
    const amr = Array.isArray(claims.amr) ? claims.amr.filter((v): v is string => typeof v === "string") : [];
    const acrOk = requiredAcr.length === 0 ? false : acr !== null && requiredAcr.includes(acr);
    const amrOk = requiredAmr.length === 0 ? false : requiredAmr.some((needed) => amr.includes(needed));
    if (!acrOk && !amrOk) {
      /*
       * Oathrion n'exécute pas l'authentification forte — c'est le fournisseur qui la fait.
       * Ce qu'il peut faire, c'est en EXIGER LA PREUVE. Un fournisseur qui n'atteste de
       * rien fait donc refuser l'accès, plutôt que de laisser croire à une protection que
       * personne ne vérifie.
       */
      return {
        ok: false,
        refusal: "mfa_not_attested",
        detail:
          "this deployment requires a strong authentication claim, and the token carries " +
          "none. Configure your provider to issue `acr` or `amr`, or remove " +
          "the requirement — Oathrion does not fake it",
      };
    }
  }

  return { ok: true, claims, email };
}
