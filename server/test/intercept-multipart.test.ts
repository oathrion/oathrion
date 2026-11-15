/**
 * LE TÉLÉVERSEMENT GOUVERNÉ : un corps `multipart/form-data` qui arrive INTACT.
 *
 * ## Le défaut que ce fichier ferme
 *
 * `rawBody` était capturé par le `verify` des parseurs JSON et form-encoded. Un corps
 * `multipart/form-data` n'est réclamé par aucun des deux, donc leur `verify` ne
 * s'exécutait pas, donc `rawBody` n'existait pas : **le relais envoyait un corps VIDE**.
 *
 * Et l'échec était silencieux du mauvais côté : le fournisseur recevait une requête
 * `multipart` bien formée, avec les bons en-têtes, sans contenu. Pas d'erreur chez Oathrion,
 * pas de refus — un fichier qui n'arrive pas.
 *
 * ## Ce que ce fichier mesure
 *
 * Le corps reçu PAR L'AMONT, octet pour octet, frontière multipart comprise. C'est la
 * seule assertion qui vaille : un corps « presque » intact — une frontière réécrite, un
 * `\\r\\n` perdu, un octet binaire passé par UTF-8 — est un fichier corrompu que personne
 * ne remarque avant de l'ouvrir.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import type { ConnectorVault } from "../connectors/vault";
import { resolveDownstreamDestination } from "../gateway/tools/mcp-destination";
import { INTERCEPT_REF_KEY, InterceptTool, putPending, resetPending } from "../intercept/forward";
import { extractAction, ExtractionError, matchRule, parseInterceptRules } from "../intercept/rules";
import { maxBodyBytes } from "../config-check";

const ORG = "org_default" as OrganizationId;
const DEST = "local-fixture";

interface Seen {
  method: string;
  url: string;
  contentType: string;
  /** Le corps en OCTETS, jamais décodé : c'est la seule forme qui prouve l'intégrité. */
  body: Buffer;
}
const seen: Seen[] = [];
let upstream: Server;
let upstreamUrl = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"id":"doc_1"}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  resetPending();
});

/*
 * UNE RÈGLE QUI LIT LA CIBLE DANS L'URL, parce qu'elle n'a pas le choix : un corps
 * multipart n'est pas parsé, donc aucune source `body.` n'y trouverait rien. C'est la
 * contrainte du mode, et elle est documentée plutôt que contournée.
 */
const RULES = [
  {
    id: "televersement",
    destination: DEST,
    method: "POST",
    path: "/v1/dossiers/{dossier}/pieces",
    action: "upload",
    target: "path.dossier",
    forwardHeaders: ["content-type"],
  },
];

/** Un vrai corps multipart, avec une frontière et un fragment BINAIRE. */
function multipartBody(): { body: Buffer; boundary: string; binary: Buffer } {
  const boundary = "----OathrionBoundary7MA4YWxkTrZu0gW";
  /*
   * Des octets qui ne survivent pas à un aller-retour UTF-8 : 0x80 à 0x8f sont des
   * continuations invalides seules. Si le relais décode puis ré-encode, ils deviennent
   * des U+FFFD et le test tombe — c'est exactement ce qu'on veut attraper.
   */
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0x81, 0x8f, 0xff, 0x00, 0x7f]);
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="reference"\r\n\r\n` +
      `RE-2026-114\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="piece"; filename="recu.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, binary, tail]), boundary, binary };
}

const toolFor = (env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) =>
  new InterceptTool(
    { open: () => Promise.resolve(null) } as unknown as ConnectorVault,
    null,
    { OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE: "sk_du_coffre", ...env } as NodeJS.ProcessEnv,
  );

async function relay(rawBody: Buffer, contentType: string, path = "/v1/dossiers/d_42/pieces") {
  const destination = resolveDownstreamDestination({
    OATHRION_LOCAL_MCP_URL: upstreamUrl,
  } as NodeJS.ProcessEnv);
  expect(destination).not.toBeNull();

  const ref = `ref_mp_${String(seen.length)}_${Math.random().toString(36).slice(2)}`;
  putPending(ref, {
    destination: destination!,
    destinationId: DEST,
    request: {
      method: "POST",
      path,
      query: {},
      headers: { "content-type": contentType },
      /* Pas d'objet parsé : c'est précisément le cas qu'on éprouve. */
      body: null,
      rawBody: rawBody.toString("binary"),
    },
    credentialHeader: "authorization",
    credentialTemplate: "Bearer {secret}",
    forwardHeaders: ["content-type"],
  });

  return toolFor().execute({
    organizationId: ORG,
    executionId: `exe_${ref}`,
    agentId: "agt_upload",
    agentName: "Agent de téléversement",
    action: "upload",
    target: "d_42",
    metadata: { [INTERCEPT_REF_KEY]: ref },
    currency: "EUR",
  });
}

describe("le corps multipart arrive intact", () => {
  it("la frontière, les en-têtes de partie et les OCTETS BINAIRES sont préservés", async () => {
    const { body, boundary, binary } = multipartBody();
    const result = await relay(body, `multipart/form-data; boundary=${boundary}`);

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const received = seen[0]!;

    /* Le `content-type` avec sa frontière : sans elle, l'amont ne sait pas découper. */
    expect(received.contentType).toBe(`multipart/form-data; boundary=${boundary}`);

    /*
     * LA MESURE QUI COMPTE : les octets reçus, à l'identique. Comparer des chaînes
     * décodées laisserait passer une corruption de binaire, puisque deux séquences
     * invalides différentes donnent le même U+FFFD.
     */
    const sent = Buffer.from(body.toString("binary"), "binary");
    expect(received.body.equals(sent)).toBe(true);
    /* Et le fragment binaire, explicitement, parce que c'est lui qui se perd. */
    expect(received.body.includes(binary)).toBe(true);
    expect(received.body.includes(Buffer.from("recu.png", "utf8"))).toBe(true);
  });

  it("aucun `\\r\\n` n'est perdu : la longueur est exacte", async () => {
    const { body, boundary } = multipartBody();
    await relay(body, `multipart/form-data; boundary=${boundary}`);
    /*
     * Un relais qui normalise les fins de ligne — ce que fait toute ré-écriture de texte
     * — casse le découpage multipart sans changer le contenu visible. La longueur le dit
     * d'un coup.
     */
    expect(seen[0]!.body.length).toBe(body.length);
  });

  it("le chemin part tel quel, et la cible vient de l'URL", async () => {
    const { body, boundary } = multipartBody();
    await relay(body, `multipart/form-data; boundary=${boundary}`);
    expect(seen[0]!.url).toBe("/v1/dossiers/d_42/pieces");
    expect(seen[0]!.method).toBe("POST");
  });
});

describe("l'extraction d'une règle multipart", () => {
  const rulesOf = () =>
    parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULES) } as NodeJS.ProcessEnv);

  it("la cible se lit dans le chemin, sans corps parsé", () => {
    const request = {
      method: "POST",
      path: "/v1/dossiers/d_42/pieces",
      query: {},
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: null,
    };
    const rule = matchRule(rulesOf(), request);
    expect(rule?.id).toBe("televersement");
    expect(extractAction(rule!, request).target).toBe("d_42");
  });

  it("UNE RÈGLE QUI LIRAIT `body.` SUR UN MULTIPART REFUSE, et le motif nomme la cause", () => {
    /*
     * Le refus existait déjà — « cible absente » — mais il ne disait pas POURQUOI le corps
     * est vide. Un exploitant allait chercher dans sa requête ce qui est une limite connue
     * du mode multipart.
     */
    const rules = parseInterceptRules({
      OATHRION_INTERCEPTS: JSON.stringify([
        { ...RULES[0], id: "mauvaise_source", target: "body.reference" },
      ]),
    } as NodeJS.ProcessEnv);
    const request = {
      method: "POST",
      path: "/v1/dossiers/d_42/pieces",
      query: {},
      headers: {},
      body: null,
    };

    let message = "";
    try {
      extractAction(rules[0]!, request);
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("multipart");
    /* Et il dit quoi faire à la place. */
    expect(message).toContain("path.<segment>");
  });
});

describe("le plafond du corps", () => {
  it("vaut 10 Mio par défaut", () => {
    expect(maxBodyBytes({} as NodeJS.ProcessEnv)).toBe(10 * 1024 * 1024);
  });

  it("se règle, avec un plancher et un plafond", () => {
    expect(maxBodyBytes({ OATHRION_MAX_BODY_BYTES: "1048576" } as NodeJS.ProcessEnv)).toBe(1_048_576);
    /*
     * Un plancher : une valeur absurde ne doit pas refuser toute requête de la console.
     * Un plafond : un zéro de trop ne doit pas transformer la borne en absence de borne.
     */
    expect(maxBodyBytes({ OATHRION_MAX_BODY_BYTES: "10" } as NodeJS.ProcessEnv)).toBe(4096);
    expect(maxBodyBytes({ OATHRION_MAX_BODY_BYTES: "999999999999" } as NodeJS.ProcessEnv)).toBe(
      256 * 1024 * 1024,
    );
  });

  it("une valeur illisible retombe sur le défaut", () => {
    expect(maxBodyBytes({ OATHRION_MAX_BODY_BYTES: "dix mégas" } as NodeJS.ProcessEnv)).toBe(
      10 * 1024 * 1024,
    );
    expect(maxBodyBytes({ OATHRION_MAX_BODY_BYTES: "-5" } as NodeJS.ProcessEnv)).toBe(10 * 1024 * 1024);
  });

  it("un corps volumineux passe, dans la limite", async () => {
    /*
     * 2 Mio de binaire : au-dessus du défaut d'Express (100 kio), donc ce test échouerait
     * si le plafond n'était pas réellement appliqué aux parseurs.
     */
    const boundary = "----OathrionGros";
    const payload = randomBytes(2 * 1024 * 1024);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="gros.bin"\r\n\r\n`, "utf8"),
      payload,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    const result = await relay(body, `multipart/form-data; boundary=${boundary}`);
    expect(result.ok).toBe(true);
    expect(seen[0]!.body.length).toBe(body.length);
    expect(seen[0]!.body.includes(payload)).toBe(true);
  });
});

/**
 * LE SAS D'APPROBATION PORTE AUSSI DES OCTETS.
 *
 * Un téléversement retenu pour approbation est SCELLÉ, puis repris des minutes plus tard.
 * Le chiffrement d'enveloppe travaille sur des chaînes : si l'aller-retour n'est pas
 * sans perte pour des octets arbitraires, le fichier relâché après approbation est
 * corrompu — et cette corruption-là arriverait APRÈS qu'un humain a dit oui, donc avec
 * son nom dans la trace d'audit.
 */
describe("un corps binaire survit au scellement", () => {
  it("l'aller-retour de l'enveloppe est sans perte pour TOUS les octets", async () => {
    const { loadKeyring, openSecret, sealSecret } = await import("../secrets/envelope");
    const { resolveSecretProvider } = await import("../secrets/provider");
    /*
     * Le vrai fournisseur de secrets, lu dans un environnement de test : le chemin exact
     * que le sas emprunte en production, et non une enveloppe fabriquée à côté.
     */
    const keyring = await loadKeyring(
      resolveSecretProvider({ OATHRION_KEK: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv),
    );

    /* Les 256 valeurs d'octet, dans l'ordre : aucune n'a le droit de se transformer. */
    const everyByte = Buffer.from(Array.from({ length: 256 }, (_unused, index) => index));
    const carried = everyByte.toString("latin1");

    const sealed = sealSecret(keyring, "intercept:org_default:ref_bin", carried);
    const recovered = openSecret(keyring, "intercept:org_default:ref_bin", sealed);

    expect(Buffer.from(recovered, "latin1").equals(everyByte)).toBe(true);
  });
});
