/**
 * LA VÉRIFICATION D'UN JETON D'IDENTITÉ : chaque faute classique, et son refus.
 *
 * ## Ce que ce fichier protège
 *
 * Un jeton d'identité est une chaîne que le NAVIGATEUR apporte. Si la vérification cède,
 * n'importe qui se fabrique une session d'administrateur. Les six fautes ci-dessous ont
 * toutes un exploit publié, et chacune a son test :
 *
 *   `alg: none` · la confusion d'algorithme (HS256 avec la clé publique) · `iss` non
 *   vérifié · `aud` non vérifié · `nonce` rejouable · `kid` ignoré
 *
 * ## Ce que ce fichier emploie
 *
 * De VRAIES clés : une paire RSA et une paire EC générées à l'exécution, et les jetons
 * sont signés avec `node:crypto`. Pas de jeton figé dans le fichier — un jeton figé
 * expire, et sa date devient un test qui tombe un jour sans raison.
 *
 * Le signataire du test est écrit ICI, à la main, et n'appelle rien du code de
 * production : c'est ce qui permet de fabriquer des jetons que le code de production
 * refuserait d'écrire — un `alg: none`, un `kid` inconnu, une signature d'une autre clé.
 */

import {
  constants,
  createHmac,
  createSign,
  generateKeyPairSync,
  type KeyObject,
  sign as cryptoSign,
} from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ACCEPTED_ALGORITHMS,
  decodeIdToken,
  OIDC_CLOCK_SKEW_MS,
  verifyIdToken,
  type Jwk,
  type VerifyOptions,
} from "../identity/oidc-token";

const ISSUER = "https://idp.acme.example.com";
const AUDIENCE = "placet-console";
const NONCE = "nonce-de-cette-tentative-precise";
const EMAIL = "directrice@acme.example.com";

let rsaPrivate: KeyObject;
let rsaJwk: Jwk;
let otherRsaPrivate: KeyObject;
let ecPrivate: KeyObject;
let ecJwk: Jwk;

const b64 = (value: Buffer | string): string =>
  Buffer.from(value).toString("base64url");

/** Le signataire du test : à la main, et sans toucher au code de production. */
function makeToken(params: {
  claims?: Record<string, unknown>;
  alg?: string;
  kid?: string | null;
  key?: KeyObject;
  /** Signer en HMAC avec un secret arbitraire — la confusion d'algorithme. */
  hmacSecret?: string;
  /** Remplacer la signature par n'importe quoi. */
  rawSignature?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const alg = params.alg ?? "RS256";
  const header: Record<string, unknown> = { alg, typ: "JWT" };
  if (params.kid !== null) header.kid = params.kid ?? "cle-2026";

  const claims = {
    iss: ISSUER,
    sub: "idp-user-7781",
    aud: AUDIENCE,
    exp: now + 300,
    iat: now,
    nonce: NONCE,
    email: EMAIL,
    email_verified: true,
    name: "Directrice Acme",
    ...params.claims,
  };

  const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;

  if (params.rawSignature !== undefined) return `${signingInput}.${params.rawSignature}`;
  if (alg === "none") return `${signingInput}.`;
  if (params.hmacSecret !== undefined) {
    const mac = createHmac("sha256", params.hmacSecret).update(signingInput, "utf8").digest();
    return `${signingInput}.${b64(mac)}`;
  }
  if (alg.startsWith("ES")) {
    const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
      key: params.key ?? ecPrivate,
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${b64(signature)}`;
  }
  const signer = createSign("sha256");
  signer.update(signingInput, "utf8");
  signer.end();
  return `${signingInput}.${b64(signer.sign(params.key ?? rsaPrivate))}`;
}

function options(extra: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    nonce: NONCE,
    keys: [rsaJwk, ecJwk],
    ...extra,
  };
}

beforeAll(() => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  rsaPrivate = rsa.privateKey;
  rsaJwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Jwk), kid: "cle-2026", alg: "RS256", use: "sig" };

  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  otherRsaPrivate = other.privateKey;

  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  ecPrivate = ec.privateKey;
  ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as Jwk), kid: "cle-ec", alg: "ES256", use: "sig" };
});

describe("un jeton valide est accepté", () => {
  it("RS256, signé par la bonne clé", () => {
    const verdict = verifyIdToken(makeToken({}), options());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.email).toBe(EMAIL);
      expect(verdict.claims.sub).toBe("idp-user-7781");
    }
  });

  it("ES256 aussi — la signature d'un JWS est en r||s, pas en DER", () => {
    /*
     * Sans `dsaEncoding: "ieee-p1363"`, Node attend du DER et TOUTE signature ES256
     * valide serait refusée. Une panne franche, mais une panne — et sur un fournisseur
     * qui n'émet que de l'EC, personne ne pourrait se connecter.
     */
    const verdict = verifyIdToken(makeToken({ alg: "ES256", kid: "cle-ec" }), options());
    expect(verdict.ok).toBe(true);
  });

  it("une adresse en majuscules est normalisée", () => {
    const verdict = verifyIdToken(
      makeToken({ claims: { email: "  DIRECTRICE@Acme.Example.Com  " } }),
      options(),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.email).toBe(EMAIL);
  });

  it("`aud` en tableau est accepté quand il nous contient ET qu'`azp` nous désigne", () => {
    /*
     * ATTENTION — CE TEST A CHANGÉ DE SENS, et il faut dire lequel.
     *
     * Il affirmait : `aud: ["une-autre-app", AUDIENCE]` SANS `azp` → accepté. C'est
     * exactement le cas qu'OpenID Connect Core §3.1.3.7 règle 3 demande de refuser, et le
     * test figeait donc le comportement le plus faible des deux.
     *
     * Ce n'est pas une protection relâchée pour verdir une suite : le code est devenu
     * PLUS strict, et l'assertion qui décrivait l'ancien comportement a été réénoncée.
     * Le refus correspondant est le test suivant, pour que les deux moitiés de la règle
     * soient lisibles côte à côte.
     */
    const verdict = verifyIdToken(
      makeToken({ claims: { aud: ["une-autre-app", AUDIENCE], azp: AUDIENCE } }),
      options(),
    );
    expect(verdict.ok ? null : verdict.refusal).toBeNull();
  });

  it("`aud` en tableau SANS `azp` est refusé", () => {
    /*
     * Pourquoi l'appartenance ne suffit pas : un jeton dont `aud` vaut
     * `["autre-app", "placet-console"]` a été émis À LA DEMANDE de l'autre application.
     * Oathrion n'y figure que comme destinataire secondaire. Si cette autre application est
     * compromise — ou simplement moins regardante sur ce qu'elle demande — son jeton
     * ouvrirait une session de console ici. `azp` est la seule revendication qui dise qui
     * a demandé le jeton.
     */
    const verdict = verifyIdToken(
      makeToken({ claims: { aud: ["une-autre-app", AUDIENCE] } }),
      options(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? null : verdict.refusal).toBe("wrong_authorized_party");
  });

  it("`aud` unique sans `azp` reste accepté", () => {
    /* La spécification n'exige `azp` que pour une audience multiple. */
    const verdict = verifyIdToken(makeToken({ claims: { aud: AUDIENCE } }), options());
    expect(verdict.ok ? null : verdict.refusal).toBeNull();
  });

  it("refuse un `azp` qui désigne une autre application, même avec `aud` unique", () => {
    /*
     * Une contradiction interne : le jeton dit « émis pour toi » et « demandé pour
     * quelqu'un d'autre ». Une contradiction dans un jeton se refuse, sans chercher
     * laquelle des deux revendications croire.
     */
    const verdict = verifyIdToken(
      makeToken({ claims: { aud: AUDIENCE, azp: "une-autre-app" } }),
      options(),
    );
    expect(verdict.ok ? null : verdict.refusal).toBe("wrong_authorized_party");
  });
});

describe("`nbf` — pas avant", () => {
  it("accepte un jeton dont le `nbf` est passé", () => {
    const now = Math.floor(Date.now() / 1000);
    const verdict = verifyIdToken(makeToken({ claims: { nbf: now - 60 } }), options());
    expect(verdict.ok ? null : verdict.refusal).toBeNull();
  });

  it("refuse un jeton qui n'est pas encore valable", () => {
    /*
     * Un jeton pré-émis pour plus tard est ce qu'un attaquant veut d'une fuite de
     * journaux : il attend que la fenêtre s'ouvre. Ignorer `nbf` rendrait cette attente
     * inutile — le jeton marcherait tout de suite.
     */
    const now = Math.floor(Date.now() / 1000);
    const verdict = verifyIdToken(makeToken({ claims: { nbf: now + 3600 } }), options());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? null : verdict.refusal).toBe("not_yet_valid");
  });

  it("tolère un `nbf` à peine futur, comme pour `iat`", () => {
    /* C'est l'horloge du fournisseur qui avance, pas une attaque. */
    const now = Math.floor(Date.now() / 1000);
    const verdict = verifyIdToken(
      makeToken({ claims: { nbf: now + OIDC_CLOCK_SKEW_MS / 1000 - 10 } }),
      options(),
    );
    expect(verdict.ok ? null : verdict.refusal).toBeNull();
  });

  it("refuse un `nbf` qui n'est pas un nombre", () => {
    const verdict = verifyIdToken(makeToken({ claims: { nbf: "bientot" } }), options());
    expect(verdict.ok).toBe(false);
  });

  it("un `nbf` absent ne gêne pas — il est optionnel", () => {
    const verdict = verifyIdToken(makeToken({}), options());
    expect(verdict.ok ? null : verdict.refusal).toBeNull();
  });
});

describe("LES SIX FAUTES CLASSIQUES, chacune refusée", () => {
  it("1. `alg: none` — le jeton se déclare non signé", () => {
    /*
     * La faute la plus connue et la plus fatale : un vérificateur qui lit l'algorithme
     * dans l'en-tête et le croit accepte un jeton que N'IMPORTE QUI peut écrire. Il
     * suffirait de forger `{"email":"admin@acme.com"}`.
     */
    const verdict = verifyIdToken(makeToken({ alg: "none" }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("unsupported_algorithm");
  });

  it("2. LA CONFUSION D'ALGORITHME — HS256 signé avec la clé PUBLIQUE", () => {
    /*
     * L'attaque : le jeton se déclare `HS256`, et un vérificateur qui choisit
     * l'algorithme d'après l'en-tête utilise la clé publique du fournisseur comme secret
     * HMAC. Cette clé est PUBLIQUE — elle est servie par le JWKS — donc l'attaquant
     * signe lui-même un jeton parfaitement valide.
     *
     * La défense n'est pas de vérifier mieux : c'est de ne jamais laisser l'en-tête
     * choisir la famille. La liste d'autorisation est asymétrique uniquement.
     */
    const publicKeyAsSecret = JSON.stringify(rsaJwk);
    const verdict = verifyIdToken(
      makeToken({ alg: "HS256", hmacSecret: publicKeyAsSecret }),
      options(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("unsupported_algorithm");
  });

  it("3. UN AUTRE ÉMETTEUR — y compris celui que l'attaquant vient de créer", () => {
    const verdict = verifyIdToken(
      makeToken({ claims: { iss: "https://idp-de-lattaquant.example" } }),
      options(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("wrong_issuer");
  });

  it("4. UNE AUTRE AUDIENCE — un jeton émis pour une autre application du MÊME IdP", () => {
    /*
     * Sur un IdP d'entreprise, des dizaines d'applications partagent le fournisseur. Un
     * jeton émis pour l'une d'elles est signé par la bonne clé, porte le bon émetteur, et
     * ne doit pourtant pas ouvrir de session ici : c'est une escalade entre applications.
     */
    const verdict = verifyIdToken(makeToken({ claims: { aud: "une-autre-app" } }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("wrong_audience");
  });

  it("5. UN `nonce` QUI N'EST PAS LE NÔTRE — le rejeu", () => {
    /*
     * Le `nonce` lie le jeton à CETTE tentative de connexion. Sans lui, un jeton valide
     * capturé ailleurs — journal de proxy, historique d'un navigateur partagé — ouvre une
     * session ici.
     */
    const verdict = verifyIdToken(makeToken({ claims: { nonce: "celui-dune-autre-connexion" } }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("nonce_mismatch");
  });

  it("5bis. un `nonce` absent est refusé comme un faux", () => {
    const verdict = verifyIdToken(makeToken({ claims: { nonce: undefined } }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("nonce_mismatch");
  });

  it("6. UN `kid` INCONNU — l'attaquant ne choisit pas la clé", () => {
    /*
     * Si le `kid` était décoratif, un attaquant pourrait faire valider son jeton par
     * n'importe quelle clé du trousseau. On n'essaie QUE la clé nommée.
     */
    const verdict = verifyIdToken(makeToken({ kid: "une-cle-qui-nexiste-pas" }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("unknown_key");
  });
});

describe("la signature elle-même", () => {
  it("une signature d'UNE AUTRE clé RSA est refusée", () => {
    const verdict = verifyIdToken(makeToken({ key: otherRsaPrivate }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("bad_signature");
  });

  it("une signature inventée est refusée", () => {
    const verdict = verifyIdToken(makeToken({ rawSignature: b64("pas une signature") }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("bad_signature");
  });

  it("UN CORPS MODIFIÉ APRÈS SIGNATURE est refusé", () => {
    /*
     * L'attaque la plus naturelle : prendre un jeton valide et changer l'adresse. La
     * signature porte sur l'en-tête ET le corps, donc elle tombe.
     */
    const valid = makeToken({});
    const [header, , signature] = valid.split(".") as [string, string, string];
    const forged = {
      iss: ISSUER, sub: "x", aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
      nonce: NONCE, email: "admin@acme.example.com", email_verified: true,
    };
    const tampered = `${header}.${b64(JSON.stringify(forged))}.${signature}`;
    const verdict = verifyIdToken(tampered, options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("bad_signature");
  });

  it("une clé EC ne vérifie pas un `RS256`, et l'inverse non plus", () => {
    /*
     * Le type de la clé est confronté à la famille de l'algorithme. Sans ce contrôle, un
     * attaquant pourrait annoncer un algorithme dont l'implémentation interprète la clé
     * autrement que prévu.
     */
    expect(verifyIdToken(makeToken({ kid: "cle-ec" }), options({ keys: [ecJwk] })).ok).toBe(false);
    expect(
      verifyIdToken(makeToken({ alg: "ES256", kid: "cle-2026" }), options({ keys: [rsaJwk] })).ok,
    ).toBe(false);
  });
});

describe("le temps", () => {
  it("un jeton expiré est refusé", () => {
    const verdict = verifyIdToken(
      makeToken({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }),
      options(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("expired");
  });

  it("un jeton daté du FUTUR est refusé aussi", () => {
    /*
     * Il resterait valable bien au-delà de la fenêtre que son `exp` suggère. N'en
     * vérifier qu'un côté laisse une porte ouverte.
     */
    const verdict = verifyIdToken(
      makeToken({ claims: { iat: Math.floor(Date.now() / 1000) + 3600 } }),
      options(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("issued_in_future");
  });

  it("la tolérance d'horloge est appliquée des deux côtés", () => {
    const skewSeconds = Math.floor(OIDC_CLOCK_SKEW_MS / 1000) - 10;
    /* Juste expiré, mais dans la tolérance : accepté. */
    expect(
      verifyIdToken(makeToken({ claims: { exp: Math.floor(Date.now() / 1000) - skewSeconds } }), options()).ok,
    ).toBe(true);
    /* Juste émis dans le futur, mais dans la tolérance : accepté. */
    expect(
      verifyIdToken(makeToken({ claims: { iat: Math.floor(Date.now() / 1000) + skewSeconds } }), options()).ok,
    ).toBe(true);
  });

  it("un `exp` ou un `iat` absent est refusé, pas supposé", () => {
    expect(verifyIdToken(makeToken({ claims: { exp: undefined } }), options()).ok).toBe(false);
    expect(verifyIdToken(makeToken({ claims: { iat: undefined } }), options()).ok).toBe(false);
  });
});

describe("l'identité portée par le jeton", () => {
  it("un sujet absent est refusé", () => {
    const verdict = verifyIdToken(makeToken({ claims: { sub: "" } }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("subject_missing");
  });

  it("une adresse absente est refusée, avec le motif qui dit quoi configurer", () => {
    const verdict = verifyIdToken(makeToken({ claims: { email: undefined } }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.refusal).toBe("email_missing");
      expect(verdict.detail).toContain("email");
    }
  });

  it("UNE ADRESSE NON VÉRIFIÉE est refusée par défaut", () => {
    /*
     * Une adresse non vérifiée est REVENDIQUÉE, pas prouvée. Sur un fournisseur qui
     * autorise l'auto-inscription, quelqu'un peut déclarer l'adresse d'un administrateur
     * sans la posséder — et la correspondance d'Oathrion se fait sur l'adresse.
     */
    const verdict = verifyIdToken(makeToken({ claims: { email_verified: false } }), options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("email_unverified");
  });

  it("l'exigence de vérification peut être levée EXPLICITEMENT", () => {
    /* Certains fournisseurs internes n'émettent pas la revendication. C'est un choix. */
    const verdict = verifyIdToken(
      makeToken({ claims: { email_verified: undefined } }),
      options({ requireVerifiedEmail: false }),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("L'ATTESTATION D'AUTHENTIFICATION FORTE", () => {
  it("sans exigence, un jeton sans `acr` ni `amr` passe", () => {
    expect(verifyIdToken(makeToken({}), options()).ok).toBe(true);
  });

  it("avec exigence, UN JETON QUI N'ATTESTE DE RIEN EST REFUSÉ", () => {
    /*
     * C'est la seule façon honnête pour Oathrion de « faire du MFA » : il ne l'exécute pas,
     * c'est le fournisseur. Ce qu'il peut faire, c'est en exiger la PREUVE. Accepter un
     * jeton muet tout en affichant « MFA requis » serait le faux statut que ce dépôt
     * refuse partout ailleurs.
     */
    const verdict = verifyIdToken(makeToken({}), options({ requiredAmr: ["mfa"] }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.refusal).toBe("mfa_not_attested");
      expect(verdict.detail).toContain("does not fake it");
    }
  });

  it("un `amr` qui contient la méthode exigée passe", () => {
    expect(
      verifyIdToken(makeToken({ claims: { amr: ["pwd", "mfa", "hwk"] } }), options({ requiredAmr: ["mfa"] })).ok,
    ).toBe(true);
  });

  it("un `amr` qui ne la contient pas est refusé", () => {
    expect(
      verifyIdToken(makeToken({ claims: { amr: ["pwd"] } }), options({ requiredAmr: ["mfa"] })).ok,
    ).toBe(false);
  });

  it("un `acr` dans la liste attendue passe", () => {
    expect(
      verifyIdToken(
        makeToken({ claims: { acr: "urn:acme:loa:strong" } }),
        options({ requiredAcr: ["urn:acme:loa:strong"] }),
      ).ok,
    ).toBe(true);
  });

  it("l'une OU l'autre suffit quand les deux sont déclarées", () => {
    /* Les fournisseurs n'émettent pas les mêmes revendications ; exiger les deux
     * rendrait l'exigence inapplicable chez la moitié d'entre eux. */
    const both = options({ requiredAcr: ["urn:acme:loa:strong"], requiredAmr: ["mfa"] });
    expect(verifyIdToken(makeToken({ claims: { amr: ["mfa"] } }), both).ok).toBe(true);
    expect(verifyIdToken(makeToken({ claims: { acr: "urn:acme:loa:strong" } }), both).ok).toBe(true);
    expect(verifyIdToken(makeToken({ claims: { acr: "urn:acme:loa:weak" } }), both).ok).toBe(false);
  });
});

describe("le décodage, qui ne vérifie rien et le dit", () => {
  it("refuse ce qui n'a pas trois segments", () => {
    expect(decodeIdToken("a.b")).toBeNull();
    expect(decodeIdToken("a.b.c.d")).toBeNull();
    expect(decodeIdToken("")).toBeNull();
  });

  it("refuse un segment hors de l'alphabet base64url", () => {
    /* Pas de tolérance : `+` et `/` appartiennent au base64 standard, pas au base64url. */
    expect(decodeIdToken("a+b.c.d")).toBeNull();
  });

  it("refuse un corps qui n'est pas un objet JSON", () => {
    const token = `${b64('{"alg":"RS256"}')}.${b64('["pas","un","objet"]')}.x`;
    expect(decodeIdToken(token)).toBeNull();
  });

  it("un jeton illisible est refusé par la vérification, pas accepté par défaut", () => {
    const verdict = verifyIdToken("n'importe quoi", options());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe("malformed");
  });
});

/**
 * CHAQUE ALGORITHME ANNONCÉ, ÉPROUVÉ AVEC UNE VRAIE CLÉ.
 *
 * Ce bloc existe à cause d'un défaut précis. La liste d'autorisation annonçait neuf
 * algorithmes ; les tests en exerçaient deux. Trois des sept non exercés — PS256, PS384,
 * PS512 — REFUSAIENT TOUTE SIGNATURE VALIDE, parce que la vérification passait
 * `saltLength: 0` (un sel de longueur nulle) là où la RFC 7518 §3.5 fixe la longueur de
 * sel à celle du condensat. Le commentaire du code annonçait pourtant
 * `RSA_PSS_SALTLEN_DIGEST`, qui vaut -1 : le commentaire disait l'inverse du code.
 *
 * Un client dont le fournisseur signe en PS256 aurait vu CHAQUE connexion refusée pour
 * « bad_signature » — un message qui désigne la mauvaise cause et envoie l'exploitant
 * chercher une clé fausse ou un JWKS périmé.
 *
 * Le test itère donc sur `ACCEPTED_ALGORITHMS` plutôt que sur une liste recopiée :
 * ajouter un algorithme à la liste de production sans pouvoir le signer ici fait tomber
 * la suite. C'est la seule forme qui empêche la faute de revenir.
 *
 * Et chaque algorithme est éprouvé QUATRE fois : signature valide acceptée, signature
 * d'une AUTRE clé refusée, un bit retourné refusé, et un en-tête qui annonce un autre
 * algorithme que celui réellement employé refusé.
 */
describe("tous les algorithmes annoncés, et aucun autre", () => {
  /* La courbe et la taille de clé que chaque algorithme impose. */
  const shape: Record<string, { kind: "rsa" | "pss" | "ec"; hash: string; curve?: string }> = {
    RS256: { kind: "rsa", hash: "sha256" },
    RS384: { kind: "rsa", hash: "sha384" },
    RS512: { kind: "rsa", hash: "sha512" },
    PS256: { kind: "pss", hash: "sha256" },
    PS384: { kind: "pss", hash: "sha384" },
    PS512: { kind: "pss", hash: "sha512" },
    ES256: { kind: "ec", hash: "sha256", curve: "P-256" },
    ES384: { kind: "ec", hash: "sha384", curve: "P-384" },
    ES512: { kind: "ec", hash: "sha512", curve: "P-521" },
  };

  /** Une paire neuve par cas, et un signataire conforme à la RFC pour cet algorithme. */
  function keyFor(alg: string) {
    const form = shape[alg];
    const pair =
      form.kind === "ec"
        ? generateKeyPairSync("ec", { namedCurve: form.curve! })
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk: Jwk = {
      ...(pair.publicKey.export({ format: "jwk" }) as Jwk),
      kid: `cle-${alg}`,
      alg,
      use: "sig",
    };
    const signer = (input: string, key: KeyObject = pair.privateKey): string => {
      if (form.kind === "pss") {
        return b64(
          cryptoSign(form.hash, Buffer.from(input, "utf8"), {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          }),
        );
      }
      if (form.kind === "ec") {
        return b64(
          cryptoSign(form.hash, Buffer.from(input, "utf8"), { key, dsaEncoding: "ieee-p1363" }),
        );
      }
      return b64(cryptoSign(form.hash, Buffer.from(input, "utf8"), { key }));
    };
    return { private: pair.privateKey, jwk, sign: signer };
  }

  function signingInput(alg: string, kid: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg, typ: "JWT", kid };
    const claims = {
      iss: ISSUER, sub: "idp-user-7781", aud: AUDIENCE,
      exp: now + 300, iat: now, nonce: NONCE,
      email: EMAIL, email_verified: true,
    };
    return `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  }

  /* Neuf cas, engendrés depuis la liste de production elle-même. */
  for (const alg of ACCEPTED_ALGORITHMS) {
    describe(alg, () => {
      it("accepte une signature produite par la bonne clé", () => {
        const k = keyFor(alg);
        const input = signingInput(alg, k.jwk.kid!);
        const verdict = verifyIdToken(`${input}.${k.sign(input)}`, options({ keys: [k.jwk] }));
        /*
         * L'assertion porte sur `refusal` AVANT `ok` : si ce test tombe un jour, le
         * message dira POURQUOI le jeton a été refusé, au lieu de « true attendu,
         * false reçu » — ce qui est exactement l'information qui manquait quand les
         * algorithmes PSS étaient cassés.
         */
        expect(verdict.ok ? null : verdict.refusal).toBeNull();
        expect(verdict.ok && verdict.claims.email).toBe(EMAIL);
      });

      it("refuse la signature d'une autre clé du même type", () => {
        const k = keyFor(alg);
        const intruse = keyFor(alg);
        const input = signingInput(alg, k.jwk.kid!);
        /* Signé par l'intruse, présenté sous le `kid` de la bonne clé. */
        const verdict = verifyIdToken(
          `${input}.${k.sign(input, intruse.private)}`,
          options({ keys: [k.jwk] }),
        );
        expect(verdict.ok).toBe(false);
        expect(verdict.ok ? null : verdict.refusal).toBe("bad_signature");
      });

      it("refuse une signature dont un octet a changé", () => {
        const k = keyFor(alg);
        const input = signingInput(alg, k.jwk.kid!);
        const raw = Buffer.from(k.sign(input), "base64url");
        raw[raw.length - 1] ^= 0x01;
        const verdict = verifyIdToken(
          `${input}.${raw.toString("base64url")}`,
          options({ keys: [k.jwk] }),
        );
        expect(verdict.ok).toBe(false);
        expect(verdict.ok ? null : verdict.refusal).toBe("bad_signature");
      });

      it("refuse un en-tête qui annonce un autre algorithme que celui employé", () => {
        const k = keyFor(alg);
        /*
         * La substitution la plus utile : garder la vraie signature et changer le seul
         * `alg` de l'en-tête. Une famille voisine (RS256 ↔ PS256, ES256 ↔ ES384) est le
         * cas où une vérification trop permissive céderait.
         */
        const menteur = alg.startsWith("ES")
          ? (alg === "ES256" ? "ES384" : "ES256")
          : alg.startsWith("PS")
            ? `RS${alg.slice(2)}`
            : `PS${alg.slice(2)}`;
        const input = signingInput(menteur, k.jwk.kid!);
        /* Signé selon le VRAI algorithme de la clé, mais l'en-tête en annonce un autre. */
        const verdict = verifyIdToken(`${input}.${k.sign(input)}`, options({ keys: [k.jwk] }));
        expect(verdict.ok).toBe(false);
      });
    });
  }

  it("n'accepte aucun algorithme symétrique ni aucun algorithme inconnu", () => {
    /*
     * Le pendant de l'itération ci-dessus : la liste est fermée. Si quelqu'un y ajoute
     * un algorithme symétrique, ce test tombe — et il tombe avec le nom de l'intrus.
     */
    const symetriques = ACCEPTED_ALGORITHMS.filter((a) => a.startsWith("HS"));
    expect(symetriques).toEqual([]);
    expect(ACCEPTED_ALGORITHMS).toHaveLength(9);
    for (const alg of ACCEPTED_ALGORITHMS) {
      expect(shape[alg], `${alg} est annoncé mais aucun test ne sait le signer`).toBeDefined();
    }
  });
});
