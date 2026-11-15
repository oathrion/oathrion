/**
 * AWS SIGNATURE V4 : signer la requête, et le prouver sans vecteur officiel.
 *
 * ## Le problème de méthode, dit d'abord
 *
 * Les vecteurs du banc d'essai publié par AWS n'étaient pas accessibles depuis cet
 * environnement, et **je refuse d'écrire une signature attendue de mémoire** : si elle est
 * fausse, le test échoue, et la tentation est alors d'ajuster l'implémentation pour qu'elle
 * corresponde à un vecteur inventé. Ce serait pire que pas de test du tout.
 *
 * Ce fichier fait donc deux choses à la place :
 *
 *  1. **UNE SECONDE IMPLÉMENTATION**, écrite ici depuis le texte de la spécification
 *     d'AWS (« Create a signed AWS API request »), et non en appelant le code de
 *     production. Les quatre étapes y sont réécrites à la main : requête canonique,
 *     hachage, chaîne à signer, dérivation en quatre HMAC. Deux implémentations
 *     indépendantes qui tombent sur la même signature, sur des entrées variées, ne se
 *     trompent pas de la même façon par hasard.
 *
 *  2. **LES PROPRIÉTÉS QUE LA SPÉCIFICATION FIXE**, chacune vérifiable seule : l'ordre des
 *     en-têtes, le `Trim()` des valeurs, l'encodage d'URI qui n'est pas celui de
 *     JavaScript, le tri de la chaîne de requête APRÈS encodage, le hachage du corps BRUT,
 *     la présence obligatoire de `host`, et la forme exacte de l'en-tête `Authorization`.
 *
 * ## CE QUE ÇA NE PROUVE PAS, ET IL FAUT LE LIRE AVANT DE VENDRE
 *
 * Qu'AWS accepte la signature. Aucun appel réel n'a eu lieu : ce dépôt n'a pas de
 * credential AWS et n'en fabriquera pas. Un pilote doit faire **un** appel réel avant de
 * s'y fier, et `docs/firewall.md` le dit.
 */

import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  amzDates,
  awsUriEncode,
  parseSigV4Credentials,
  SIGV4_ALGORITHM,
  SigV4ConfigError,
  sigv4ConfigFor,
  sigv4ConfigProblems,
  signSigV4,
} from "../connectors/sigv4";

const CREDENTIALS = {
  /* Les valeurs d'exemple de la documentation d'AWS : elles n'ouvrent rien. */
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const CONFIG = { region: "us-east-1", service: "service" };
const AT = new Date("2015-08-30T12:36:00.000Z");

/* ──────────────────────── LA SECONDE IMPLÉMENTATION ────────────────────────
 *
 * Écrite depuis le texte de la spécification, délibérément dans un autre style que celle
 * de production : boucles plutôt que `map`, concaténation plutôt que `join`, ordre des
 * opérations réécrit. Le but est qu'une faute de frappe ou un contresens ne se reproduise
 * pas identiquement des deux côtés.
 *
 * Elle NE partage rien avec le code de production — pas même `awsUriEncode`, qui est
 * réécrit ci-dessous.
 */

function hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** `UriEncode()` de la spécification, réécrit. */
function encodeTwice(value: string, slashToo: boolean): string {
  const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = Buffer.from(value, "utf8");
  let result = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const character = String.fromCharCode(bytes[i]!);
    if (unreserved.includes(character)) {
      result = result + character;
    } else if (character === "/" && !slashToo) {
      result = result + "/";
    } else {
      let piece = bytes[i]!.toString(16).toUpperCase();
      if (piece.length === 1) piece = `0${piece}`;
      result = result + "%" + piece;
    }
  }
  return result;
}

function signTwice(input: {
  method: string;
  url: URL;
  contentType?: string;
  sessionToken?: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  at: Date;
}): string {
  const stamp = `${input.at.toISOString().replace(/[-:]/g, "").split(".")[0]!}Z`;
  const day = stamp.substring(0, 8);
  const payload = hex(Buffer.from(input.body, "utf8"));

  /* 1. la requête canonique */
  let canonicalUri = "";
  const segments = input.url.pathname === "" ? ["", ""] : input.url.pathname.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) canonicalUri = canonicalUri + "/";
    canonicalUri = canonicalUri + encodeTwice(decodeURIComponent(segments[i]!), true);
  }

  const encodedPairs: string[] = [];
  input.url.searchParams.forEach((value, name) => {
    encodedPairs.push(`${encodeTwice(name, true)}=${encodeTwice(value, true)}`);
  });
  encodedPairs.sort();
  const canonicalQuery = encodedPairs.join("&");

  const headerMap = new Map<string, string>();
  headerMap.set("host", input.url.host);
  headerMap.set("x-amz-date", stamp);
  headerMap.set("x-amz-content-sha256", payload);
  if (input.contentType !== undefined) headerMap.set("content-type", input.contentType);
  if (input.sessionToken !== undefined) headerMap.set("x-amz-security-token", input.sessionToken);

  const sortedNames = [...headerMap.keys()].sort();
  let canonicalHeaders = "";
  for (const name of sortedNames) {
    const raw = headerMap.get(name)!;
    const trimmed = raw.replace(/^\s+|\s+$/g, "").replace(/ {2,}/g, " ");
    canonicalHeaders = `${canonicalHeaders}${name}:${trimmed}\n`;
  }
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest =
    `${input.method.toUpperCase()}\n` +
    `${canonicalUri}\n` +
    `${canonicalQuery}\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${payload}`;

  /* 2 et 3. le hachage, puis la chaîne à signer */
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hex(canonicalRequest)}`;

  /* 4. la dérivation, quatre HMAC */
  const k1 = createHmac("sha256", `AWS4${input.secretAccessKey}`).update(day, "utf8").digest();
  const k2 = createHmac("sha256", k1).update(input.region, "utf8").digest();
  const k3 = createHmac("sha256", k2).update(input.service, "utf8").digest();
  const k4 = createHmac("sha256", k3).update("aws4_request", "utf8").digest();
  return createHmac("sha256", k4).update(stringToSign, "utf8").digest("hex");
}

/* ───────────────────────────────── les tests ───────────────────────────────── */

describe("deux implémentations indépendantes, la même signature", () => {
  const cases: {
    label: string;
    method: string;
    url: string;
    body: string;
    contentType?: string;
    sessionToken?: string;
  }[] = [
    { label: "GET nu", method: "GET", url: "https://example.amazonaws.com/", body: "" },
    {
      label: "POST avec corps JSON",
      method: "POST",
      url: "https://bedrock-runtime.eu-west-3.amazonaws.com/model/anthropic.claude/invoke",
      body: '{"prompt":"bonjour","max_tokens":128}',
      contentType: "application/json",
    },
    {
      label: "chaîne de requête à trier",
      method: "GET",
      url: "https://example.amazonaws.com/?zeta=1&alpha=2&Beta=3",
      body: "",
    },
    {
      label: "paramètres à encoder — le tri porte sur les octets ENCODÉS",
      method: "GET",
      url: "https://example.amazonaws.com/?a%20b=c%20d&a!b=x",
      body: "",
    },
    {
      label: "chemin avec espaces et accents",
      method: "PUT",
      url: "https://s3.eu-west-3.amazonaws.com/seau/dossier%20des%20re%C3%A7us/pi%C3%A8ce.pdf",
      body: "contenu",
      contentType: "application/pdf",
    },
    {
      label: "credentials temporaires — le jeton de session est SIGNÉ",
      method: "POST",
      url: "https://sqs.us-east-1.amazonaws.com/",
      body: "Action=SendMessage",
      contentType: "application/x-www-form-urlencoded",
      sessionToken: "FQoGZXIvYXdzEBYaD-un-jeton-de-session-temporaire",
    },
    {
      label: "corps vide sur un POST",
      method: "POST",
      url: "https://example.amazonaws.com/action",
      body: "",
    },
  ];

  for (const scenario of cases) {
    it(scenario.label, () => {
      const url = new URL(scenario.url);
      const headers: Record<string, string> = {};
      if (scenario.contentType) headers["content-type"] = scenario.contentType;

      const mine = signSigV4({
        method: scenario.method,
        url,
        headers,
        body: scenario.body,
        config: CONFIG,
        credentials: scenario.sessionToken
          ? { ...CREDENTIALS, sessionToken: scenario.sessionToken }
          : CREDENTIALS,
        now: AT,
      });

      const theirs = signTwice({
        method: scenario.method,
        url,
        body: scenario.body,
        region: CONFIG.region,
        service: CONFIG.service,
        accessKeyId: CREDENTIALS.accessKeyId,
        secretAccessKey: CREDENTIALS.secretAccessKey,
        at: AT,
        ...(scenario.contentType === undefined ? {} : { contentType: scenario.contentType }),
        ...(scenario.sessionToken === undefined ? {} : { sessionToken: scenario.sessionToken }),
      });

      expect(mine.signature).toBe(theirs);
      /* Et la signature est bien un condensat hexadécimal en minuscules. */
      expect(mine.signature).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("UN SEUL OCTET DE CORPS CHANGÉ CHANGE LA SIGNATURE", () => {
    /*
     * C'est la propriété qui fait de la signature un RENFORCEMENT de la garantie de
     * Oathrion : un agent ne peut pas faire signer une requête puis en envoyer une autre.
     */
    const url = new URL("https://example.amazonaws.com/action");
    const base = signSigV4({
      method: "POST", url, headers: {}, body: '{"amount":10}',
      config: CONFIG, credentials: CREDENTIALS, now: AT,
    });
    const altered = signSigV4({
      method: "POST", url, headers: {}, body: '{"amount":11}',
      config: CONFIG, credentials: CREDENTIALS, now: AT,
    });
    expect(altered.signature).not.toBe(base.signature);
  });

  it("le chemin, la méthode et la région changent aussi la signature", () => {
    const common = { headers: {}, body: "", credentials: CREDENTIALS, now: AT } as const;
    const reference = signSigV4({
      method: "GET", url: new URL("https://example.amazonaws.com/a"), config: CONFIG, ...common,
    }).signature;

    expect(
      signSigV4({ method: "GET", url: new URL("https://example.amazonaws.com/b"), config: CONFIG, ...common }).signature,
    ).not.toBe(reference);
    expect(
      signSigV4({ method: "POST", url: new URL("https://example.amazonaws.com/a"), config: CONFIG, ...common }).signature,
    ).not.toBe(reference);
    expect(
      signSigV4({
        method: "GET", url: new URL("https://example.amazonaws.com/a"),
        config: { region: "eu-west-3", service: "service" }, ...common,
      }).signature,
    ).not.toBe(reference);
  });
});

describe("les règles de la spécification, une par une", () => {
  it("`UriEncode` encode ce que `encodeURIComponent` laisse passer", () => {
    /*
     * La différence est réelle et coûteuse : `encodeURIComponent` laisse `!`, `'`, `(`,
     * `)` et `*`, qu'AWS exige encodés. Un seul de ces caractères dans un nom de
     * paramètre produit une signature refusée, et le message d'AWS ne dit pas lequel.
     */
    for (const character of ["!", "'", "(", ")", "*"]) {
      expect(encodeURIComponent(character)).toBe(character);
      expect(awsUriEncode(character, true)).toMatch(/^%[0-9A-F]{2}$/);
    }
  });

  it("l'espace devient `%20` et jamais `+`", () => {
    expect(awsUriEncode("a b", true)).toBe("a%20b");
  });

  it("les caractères non réservés passent tels quels", () => {
    expect(awsUriEncode("aZ09-._~", true)).toBe("aZ09-._~");
  });

  it("les lettres hexadécimales sont en MAJUSCULES", () => {
    /* « Letters in the hexadecimal value must be uppercase, for example "%1A". » */
    expect(awsUriEncode("", true)).toBe("%1A");
    expect(awsUriEncode("é", true)).toBe("%C3%A9");
  });

  it("la barre oblique est encodée ou non selon le contexte", () => {
    expect(awsUriEncode("a/b", false)).toBe("a/b");
    expect(awsUriEncode("a/b", true)).toBe("a%2Fb");
  });

  it("`host` est toujours signé, et c'est l'hôte de l'URL", () => {
    const signed = signSigV4({
      method: "GET",
      url: new URL("https://bedrock.eu-west-3.amazonaws.com/x"),
      headers: {},
      body: "",
      config: CONFIG,
      credentials: CREDENTIALS,
      now: AT,
    });
    expect(signed.canonicalRequest).toContain("host:bedrock.eu-west-3.amazonaws.com");
    expect(signed.headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  it("LES VALEURS D'EN-TÊTE SONT TRIMÉES, espaces internes compris", () => {
    /*
     * « trim any leading or trailing spaces » ET « convert sequential spaces to a single
     * space ». Omettre la seconde partie est l'erreur classique : elle ne se voit que sur
     * un en-tête qui en contient, donc rarement, donc tard.
     */
    const signed = signSigV4({
      method: "POST",
      url: new URL("https://example.amazonaws.com/"),
      headers: { "content-type": "  application/json;   charset=utf-8  " },
      body: "{}",
      config: CONFIG,
      credentials: CREDENTIALS,
      now: AT,
    });
    expect(signed.canonicalRequest).toContain("content-type:application/json; charset=utf-8\n");
  });

  it("les en-têtes canoniques sont en minuscules et triés", () => {
    const signed = signSigV4({
      method: "POST",
      url: new URL("https://example.amazonaws.com/"),
      headers: { "Content-Type": "text/plain" },
      body: "x",
      config: CONFIG,
      credentials: { ...CREDENTIALS, sessionToken: "jeton" },
      now: AT,
    });
    const names = signed.canonicalRequest.split("\n").slice(3, -3).map((line) => line.split(":")[0]);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("content-type");
    expect(names).toContain("x-amz-security-token");
  });

  it("le hachage du corps est celui du corps BRUT, octet pour octet", () => {
    const body = '{"a":1}';
    const signed = signSigV4({
      method: "POST",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body,
      config: CONFIG,
      credentials: CREDENTIALS,
      now: AT,
    });
    const expected = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
    expect(signed.headers["x-amz-content-sha256"]).toBe(expected);
    expect(signed.canonicalRequest.endsWith(expected)).toBe(true);
  });

  it("un corps vide est haché comme la chaîne vide, pas omis", () => {
    const signed = signSigV4({
      method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "",
      config: CONFIG, credentials: CREDENTIALS, now: AT,
    });
    /* Le condensat SHA-256 de la chaîne vide, que la documentation d'AWS cite elle-même. */
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("l'en-tête `Authorization` a la forme exacte de la spécification", () => {
    const signed = signSigV4({
      method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "",
      config: CONFIG, credentials: CREDENTIALS, now: AT,
    });
    /*
     * Pas de virgule entre l'algorithme et `Credential`, des virgules entre les trois
     * autres : la spécification l'écrit ainsi, et un service refuse l'autre forme.
     */
    expect(signed.headers.authorization).toBe(
      `${SIGV4_ALGORITHM} Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ` +
        `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signed.signature}`,
    );
  });

  it("la portée porte la DATE, pas l'horodatage complet", () => {
    const signed = signSigV4({
      method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "",
      config: CONFIG, credentials: CREDENTIALS, now: AT,
    });
    expect(signed.stringToSign).toContain("20150830/us-east-1/service/aws4_request");
    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("`amzDates` rend les deux formats attendus", () => {
    expect(amzDates(new Date("2013-05-24T00:00:00Z"))).toEqual({
      amzDate: "20130524T000000Z",
      dateStamp: "20130524",
    });
  });

  it("le jeton de session est à la fois SIGNÉ et envoyé", () => {
    const signed = signSigV4({
      method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "",
      config: CONFIG, credentials: { ...CREDENTIALS, sessionToken: "jeton-temporaire" }, now: AT,
    });
    expect(signed.canonicalRequest).toContain("x-amz-security-token:jeton-temporaire");
    expect(signed.headers["x-amz-security-token"]).toBe("jeton-temporaire");
    expect(signed.headers.authorization).toContain("x-amz-security-token");
  });

  it("les en-têtes SAUTÉS ne sont jamais signés", () => {
    /*
     * La spécification met en garde : `connection`, `transfer-encoding`, `keep-alive`,
     * `user-agent` sont réécrits en transit par un proxy ou un répartiteur. Les signer
     * fait échouer la requête quelque part entre Oathrion et AWS, de façon intermittente et
     * sans cause lisible. `content-length` non plus : le transport l'ajoute APRÈS.
     */
    const signed = signSigV4({
      method: "POST",
      url: new URL("https://example.amazonaws.com/"),
      headers: {
        "content-type": "application/json",
        connection: "keep-alive",
        "user-agent": "placet/1",
        "transfer-encoding": "chunked",
        "content-length": "2",
      },
      body: "{}",
      config: CONFIG,
      credentials: CREDENTIALS,
      now: AT,
    });
    for (const unwanted of ["connection", "user-agent", "transfer-encoding", "content-length"]) {
      expect(signed.headers.authorization).not.toContain(unwanted);
      expect(signed.canonicalRequest).not.toContain(`${unwanted}:`);
    }
  });
});

describe("la configuration et les credentials", () => {
  it("absente veut dire « pas de signature », et ce n'est pas une erreur", () => {
    expect(sigv4ConfigFor("stripe", {} as NodeJS.ProcessEnv)).toBeNull();
    expect(sigv4ConfigProblems({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("présente et complète est acceptée", () => {
    const config = sigv4ConfigFor("aws-bedrock", {
      OATHRION_SIGV4_AWS_BEDROCK: JSON.stringify({ region: "eu-west-3", service: "bedrock" }),
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({ region: "eu-west-3", service: "bedrock" });
  });

  it("UNE RÉGION MAL ÉCRITE REFUSE AU DÉMARRAGE", () => {
    /*
     * Parce que son symptôme à l'exécution est « signature mismatch », qui ne dit pas que
     * la cause est la région. Un refus au démarrage avec le nom de la variable est la
     * seule forme utile.
     */
    const problems = sigv4ConfigProblems({
      OATHRION_SIGV4_AWS_BEDROCK: JSON.stringify({ region: "EU-West-3", service: "bedrock" }),
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("OATHRION_SIGV4_AWS_BEDROCK");
    expect(problems[0]).toContain("signature");
  });

  it("un JSON invalide ou un champ manquant refuse aussi", () => {
    expect(() => sigv4ConfigFor("x", { OATHRION_SIGV4_X: "pas du json" } as NodeJS.ProcessEnv)).toThrow(
      SigV4ConfigError,
    );
    expect(() =>
      sigv4ConfigFor("x", { OATHRION_SIGV4_X: JSON.stringify({ region: "us-east-1" }) } as NodeJS.ProcessEnv),
    ).toThrow(/service/);
  });

  it("les credentials se lisent sous les deux formes", () => {
    expect(parseSigV4Credentials("AKIDEXAMPLE:secret-tres-long")).toEqual({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret-tres-long",
    });
    expect(
      parseSigV4Credentials(
        JSON.stringify({ accessKeyId: "AKID", secretAccessKey: "sk", sessionToken: "st" }),
      ),
    ).toEqual({ accessKeyId: "AKID", secretAccessKey: "sk", sessionToken: "st" });
  });

  it("un secret contenant « : » n'est pas coupé en deux", () => {
    /* On coupe au PREMIER séparateur ; le reste appartient au secret. */
    expect(parseSigV4Credentials("AKID:abc:def").secretAccessKey).toBe("abc:def");
  });

  it("un credential illisible LÈVE, il ne produit pas une signature vide", () => {
    expect(() => parseSigV4Credentials("une-seule-valeur")).toThrow(SigV4ConfigError);
    expect(() => parseSigV4Credentials(":rien-devant")).toThrow(SigV4ConfigError);
    expect(() => parseSigV4Credentials("rien-derriere:")).toThrow(SigV4ConfigError);
    expect(() => parseSigV4Credentials('{"accessKeyId":"a"}')).toThrow(/secretAccessKey/);
  });

  it("LE SECRET N'APPARAÎT DANS AUCUN MESSAGE D'ERREUR", () => {
    const error = (() => {
      try {
        parseSigV4Credentials('{"accessKeyId":"AKID","secretAccessKey":""}');
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    const text = error instanceof Error ? error.message : String(error);
    expect(text).not.toContain("AKID");
  });
});
