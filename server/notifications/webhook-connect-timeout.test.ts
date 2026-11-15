/**
 * LE DÉLAI D'UNE TENTATIVE DE CONNEXION — le défaut qui coupait Oathrion d'OpenAI.
 *
 * ## Ce qui s'est passé
 *
 * En éprouvant le paquet OpenAI contre le vrai service (`npm run verify:openai`), CHAQUE
 * appel relayé par Oathrion échouait en 502 `forward_failed`. OpenAI était joignable :
 * `curl` passait.
 *
 * La cause, mesurée sur la machine : la route IPv6 vers api.openai.com tombait par
 * intermittence, et l'IPv4 qui restait mettait plus d'une seconde à s'établir. Node essaie
 * les adresses l'une après l'autre (`autoSelectFamily`), avec un délai par défaut de
 * **250 ms par adresse**, et il ABANDONNE une tentative à l'expiration. Chaque tentative
 * était coupée avant d'aboutir :
 *
 *     délai 250 ms (défaut)   ETIMEDOUT en 1 004 ms
 *     délai 2 500 ms          401 d'OpenAI en 1 379 ms, via IPv4
 *
 * Après la correction, et sur le même réseau dont l'IPv6 était cassé, Oathrion a relayé les
 * réponses d'OpenAI au lieu d'échouer.
 *
 * ## Pourquoi ce test observe les options plutôt que la panne
 *
 * Reproduire la panne localement exigerait une adresse qui avale les paquets sans rien
 * répondre et une connexion qui met plus de 250 ms à s'établir — ni l'une ni l'autre ne
 * s'obtient de façon fiable sur une boucle locale, où une connexion refusée échoue en une
 * milliseconde. La preuve contre la panne réelle est `verify:openai` ; ce fichier garde la
 * LOI : les deux points de connexion du transport passent le délai, à chaque appel.
 */

import http from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CONNECT_ATTEMPT_MS, sendGuarded, streamGuarded } from "./webhook-transport";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Les options réellement passées à `http.request` pendant un appel. */
function spyOnRequest() {
  return vi.spyOn(http, "request");
}

function optionsOf(spy: ReturnType<typeof spyOnRequest>): Record<string, unknown> {
  expect(spy).toHaveBeenCalled();
  return spy.mock.calls[0]![0] as unknown as Record<string, unknown>;
}

describe("chaque connexion sortante tolère une liaison lente", () => {
  it("le délai par tentative est bien au-dessus des 250 ms de Node", () => {
    /*
     * La valeur elle-même. 250 ms échouait sur une liaison réelle ; une valeur ramenée
     * sous la seconde reproduirait la panne sur toute connexion transatlantique.
     */
    expect(CONNECT_ATTEMPT_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("`sendGuarded` passe la bascule de famille et son délai à la connexion", async () => {
    const spy = spyOnRequest();
    const reply = await sendGuarded({
      url: new URL(`${base}/x`),
      method: "GET",
      headers: {},
      body: "",
      timeoutMs: 5_000,
      captureBody: true,
      allowPrivate: true,
    });
    expect(reply.status).toBe(200);
    const options = optionsOf(spy);
    expect(options.autoSelectFamily).toBe(true);
    expect(options.autoSelectFamilyAttemptTimeout).toBe(CONNECT_ATTEMPT_MS);
  });

  it("`streamGuarded` aussi — c'est la voie qu'empruntent les API de modèle", async () => {
    /*
     * Le paquet OpenAI déclare `stream: true` : ses complétions passent par CE chemin et
     * non par `sendGuarded`. Corriger un seul des deux points de connexion laisserait
     * exactement les appels qui ont révélé le défaut en panne.
     */
    const spy = spyOnRequest();
    const stream = await streamGuarded({
      url: new URL(`${base}/y`),
      method: "GET",
      headers: {},
      body: "",
      timeoutMs: 5_000,
      allowPrivate: true,
    });
    stream.body.resume();
    expect(stream.status).toBe(200);
    const options = optionsOf(spy);
    expect(options.autoSelectFamily).toBe(true);
    expect(options.autoSelectFamilyAttemptTimeout).toBe(CONNECT_ATTEMPT_MS);
  });

  it("le réglage ne remplace pas la garde d'adresse", async () => {
    /*
     * Les options de connexion sont étalées À CÔTÉ du `lookup` gardé, pas à sa place. Sans
     * `allowPrivate`, le `lookup` doit toujours être celui du transport — c'est lui qui
     * refuse une adresse privée.
     */
    const spy = spyOnRequest();
    /*
     * Un NOM d'hôte et non `127.0.0.1` : une IP littérale privée est désormais refusée
     * avant même `http.request` (voir `literalAddressRefusal`), donc elle ne montrerait
     * plus les options passées à la connexion. Un nom passe par `lookup`, qui est
     * précisément la garde dont ce test vérifie la présence.
     */
    await sendGuarded({
      url: new URL(`${base.replace("127.0.0.1", "localhost")}/z`),
      method: "GET",
      headers: {},
      body: "",
      timeoutMs: 5_000,
      captureBody: true,
    }).catch(() => undefined);
    const options = optionsOf(spy);
    expect(typeof options.lookup).toBe("function");
    expect(options.autoSelectFamilyAttemptTimeout).toBe(CONNECT_ATTEMPT_MS);
  });
});
