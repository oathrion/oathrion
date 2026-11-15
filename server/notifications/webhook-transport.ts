/**
 * The guarded outbound transport used by {@link WebhookChannel}.
 *
 * `assertSafeWebhookUrl` validates the *configured string*. This file guards the
 * *actual socket*, which is a different problem and the one that matters:
 *
 *  - **DNS rebinding.** A hostname that resolved to a public address when the
 *    channel was registered can resolve to 127.0.0.1 by the time a notification is
 *    sent. Validating the hostname, or even resolving it once and validating the
 *    result, does not prevent this — the connection uses a *later* lookup. The only
 *    check that cannot be raced is one applied to the address the socket is about
 *    to connect to, so a custom `lookup` inspects every candidate address and fails
 *    the connection rather than the pre-flight.
 *
 *  - **Redirects.** `fetch` follows redirects by default, so a validated public
 *    host answering `302 Location: http://169.254.169.254/...` reached the metadata
 *    service with all the pre-flight checks having passed. Redirects are not
 *    followed here at all. A 3xx is reported as an unsuccessful delivery, which is
 *    the truth: a webhook receiver that redirects is misconfigured.
 *
 *  - **Unbounded response bodies.** The reply is discarded, so a receiver that
 *    streams gigabytes should not be able to grow this process's memory. The body
 *    is capped and the socket destroyed past the cap.
 *
 * Implemented on `node:http`/`node:https` rather than `fetch` because only the
 * former exposes the `lookup` hook that makes the address check possible.
 */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { PassThrough, type Readable } from "node:stream";
import { blockedAddressReason } from "./webhook-url";

/** Discard the reply past this many bytes. A webhook ack has no reason to be large. */
/**
 * LE DÉLAI D'UNE TENTATIVE DE CONNEXION, PAR ADRESSE — et la valeur par défaut de Node
 * coupait Oathrion du monde sur une liaison lente.
 *
 * Quand un nom résout en plusieurs adresses (IPv6 et IPv4), Node les essaie l'une après
 * l'autre (`autoSelectFamily`, « Happy Eyeballs »). Mais son délai par défaut est de
 * **250 ms par adresse**, et Node ABANDONNE une tentative à l'expiration au lieu de la
 * laisser courir. Sur une liaison où l'établissement TCP + TLS prend plus de 250 ms, chaque
 * tentative est coupée avant d'aboutir, et la requête échoue en `ETIMEDOUT` alors que le
 * fournisseur est parfaitement joignable.
 *
 * Mesuré, pas supposé, en éprouvant le paquet OpenAI contre le vrai service : la route
 * IPv6 vers api.openai.com tombait par intermittence, et la connexion IPv4 qui restait
 * prenait plus d'une seconde. Avec 250 ms, `ETIMEDOUT` en 1 004 ms ; avec 2 500 ms, 401 de
 * l'API en 1 379 ms via IPv4. CHAQUE appel gouverné vers OpenAI échouait en 502
 * `forward_failed`.
 *
 * C'est le cas courant, pas un cas limite : un déploiement en Afrique de l'Ouest qui
 * appelle des API hébergées aux États-Unis, ou tout réseau d'entreprise dont l'IPv6 est
 * annoncé mais mal routé.
 *
 * Le prix d'une valeur plus haute : si une adresse est un trou noir, on attend jusqu'à
 * 2,5 s avant de passer à la suivante. C'est une lenteur ponctuelle, contre une panne
 * systématique. Le délai GLOBAL de la requête (`timeoutMs`) reste la borne supérieure.
 */
export const CONNECT_ATTEMPT_MS = 2_500;

/*
 * Les options de connexion, dans un objet à part. `@types/node` ne les déclare pas sur
 * `https.RequestOptions`, alors que Node les transmet bien jusqu'à `net.connect` — mesuré :
 * passées à `https.get`, elles font aboutir la connexion qui échouait. Un objet étalé
 * échappe au contrôle des propriétés en trop, sans transtyper la requête entière.
 */
const CONNECT_OPTIONS: { autoSelectFamily: true; autoSelectFamilyAttemptTimeout: number } = {
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS,
};

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Phase 9 — the cap when the caller actually needs the body.
 *
 * The webhook channel discards the reply, so 64 KiB is generous for it. The MCP
 * relay reuses this transport (see `server/gateway/tools/mcp-destination.ts` for
 * why it must, rather than using `fetch`) and does need the reply, because the
 * reply is the tool result. It still has to be bounded: a downstream that
 * streams without end must not be able to grow this process until it dies, and
 * "the control plane fell over" is a worse outcome than "one dispatch failed".
 *
 * 1 MiB is far above any real MCP tool result and far below anything dangerous.
 */
const MAX_CAPTURED_BYTES = 1024 * 1024;

/*
 * ────────────────────────── LE MODE FLUX ──────────────────────────
 *
 * Les deux modes au-dessus TAMPONNENT : ils rendent la réponse entière, ou la refusent si
 * elle dépasse. C'est le bon choix pour un résultat d'outil, qu'un appelant doit recevoir
 * complet ou pas du tout.
 *
 * Et c'est exactement ce qui rendait Oathrion inutilisable devant une API de modèle. Une
 * réponse `text/event-stream` d'OpenAI ou d'Anthropic arrive par jetons pendant plusieurs
 * secondes : la tamponner, c'est rendre à l'agent une réponse complète à la fin, donc
 * supprimer le streaming que l'application de l'utilisateur attend — et pour une réponse
 * longue, buter sur le plafond et refuser l'appel.
 *
 * `streamGuarded` rend les en-têtes DÈS QU'ILS ARRIVENT et laisse le corps couler. Toutes
 * les gardes de ce fichier restent en place : la vérification d'adresse au niveau du
 * socket, l'absence de suivi de redirection, et un plafond — déplacé, pas retiré.
 */

/**
 * Le plafond d'un flux. 64 MiB.
 *
 * Il ne protège plus la mémoire du processus — un flux ne s'accumule pas, il traverse —
 * mais il borne toujours ce qu'un amont peut faire durer. Sans lui, un amont qui émet
 * sans fin tient un socket, un descripteur et une exécution ouverte pour toujours.
 *
 * Le dépassement COUPE le flux au lieu de le refuser, et c'est l'inverse du mode
 * tamponné. La raison : au moment où le plafond est atteint, l'agent a DÉJÀ reçu des
 * octets. Refuser rétroactivement n'est pas une option offerte par HTTP ; ce qui l'est,
 * c'est de couper et de le DIRE — `truncated` dans l'issue, et le reçu le porte.
 */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/**
 * L'inactivité tolérée au milieu d'un flux. 60 s.
 *
 * Un flux de modèle est long par nature, donc une durée totale courte le casserait. Ce
 * qui n'est pas normal, c'est le SILENCE : un amont qui a envoyé ses en-têtes puis plus
 * rien pendant une minute est tombé, et l'exécution doit se fermer plutôt que d'attendre.
 */
const STREAM_IDLE_MS = 60_000;

/**
 * Le plafond de DURÉE TOTALE. 10 minutes.
 *
 * L'inactivité seule ne suffit pas : un amont qui émet un octet toutes les trente
 * secondes ne déclenche jamais le délai d'inactivité et tient la connexion
 * indéfiniment. C'est le même raisonnement que le plafond d'octets — borner ce qu'un
 * tiers peut faire durer — appliqué à l'autre dimension.
 */
const MAX_STREAM_MS = 600_000;

/** Ce que `streamGuarded` rend, dès les en-têtes. */
export interface GuardedStream {
  /** Le statut DU FOURNISSEUR. Jamais fabriqué, 3xx compris. */
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /**
   * Le corps, à piper. C'est un `PassThrough` et non la réponse brute : le comptage et le
   * plafond vivent ICI, dans le transport, et pas chez l'appelant. Poser un écouteur
   * `data` sur la réponse brute pour compter la mettrait en mode coulant et consommerait
   * les octets que l'appelant doit relayer.
   */
  body: Readable;
  /**
   * L'issue, connue seulement à la fin. L'appelant la lit APRÈS avoir pipé, pour écrire
   * un reçu qui dit ce qui s'est réellement passé plutôt que ce qui avait commencé.
   *
   * Ne rejette jamais : une coupure au milieu d'un flux est une issue, pas une exception.
   */
  completion: Promise<{ bytes: number; truncated: boolean; reason: string | null }>;
}

export interface GuardedRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /**
   * La méthode HTTP. `POST` par défaut, donc le canal webhook et le relais MCP sont
   * inchangés octet pour octet.
   *
   * Ajoutée pour les connecteurs REST (phase connecteurs) : l'API GitHub se lit en `GET`
   * et s'écrit en `POST`/`PATCH`. L'alternative aurait été un second chemin de sortie
   * avec son propre client HTTP — c'est-à-dire une seconde copie des gardes d'adresse,
   * qui est exactement ce que `server/gateway/tools/mcp-destination.ts` refuse : une
   * seconde copie d'une liste anti-SSRF est une copie qui prend du retard.
   */
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * L'encodage du corps à l'écriture. `utf8` par défaut, donc le webhook, le relais MCP
   * et les connecteurs sont inchangés octet pour octet.
   *
   * `latin1` existe pour le pare-feu, qui relaie des octets ARBITRAIRES — un téléversement
   * multipart contenant un PNG. En UTF-8, chaque octet au-dessus de 0x7F en devenait deux :
   * 288 octets envoyés, 293 reçus, et un fichier corrompu sans erreur nulle part.
   *
   * Explicite et non global : passer tout le transport en latin1 casserait un corps JSON
   * contenant un « é », qui doit bien partir sur deux octets.
   */
  bodyEncoding?: "utf8" | "latin1";
  /** Skip the address check. Mirrors OATHRION_WEBHOOK_ALLOW_PRIVATE. */
  allowPrivate?: boolean;
  /**
   * Return the response body instead of discarding it. Off by default, so the
   * webhook channel's behaviour is byte-for-byte unchanged.
   *
   * When on, a body that exceeds the cap is a REJECTION rather than a truncation.
   * Truncating is right for a webhook ack nobody reads; it is wrong for a tool
   * result, because a truncated JSON frame either fails to parse - a confusing
   * error - or, worse, parses into something that is not what the downstream
   * said. A caller must never act on a partial answer.
   */
  captureBody?: boolean;
}

export interface GuardedResponse {
  status: number;
  ok: boolean;
  /** Present only when `captureBody` was requested. */
  body?: string;
  /**
   * Les en-têtes de la réponse, présents seulement avec `captureBody`.
   *
   * Nécessaires et non décoratifs pour un connecteur : GitHub annonce les portées
   * RÉELLES d'un jeton dans `x-oauth-scopes`, et l'état de son quota dans
   * `x-ratelimit-remaining` / `x-ratelimit-reset`. Sans eux, « quelles permissions ce
   * jeton a-t-il » ne pourrait qu'être deviné à partir de ce que l'exploitant a coché —
   * c'est-à-dire affiché sans être su.
   */
  headers?: Record<string, string>;
}

/** Raised when a resolved address is refused. Distinct so the detail is legible. */
export class BlockedAddressError extends Error {
  constructor(hostname: string, address: string, reason: string) {
    super(`Refused to connect to ${hostname} (${address}): ${reason}.`);
    this.name = "BlockedAddressError";
  }
}

/**
 * A `lookup` implementation that refuses to hand a blocked address to the socket.
 *
 * Node calls this with `all: true` for some agents and `all: false` for others, so
 * both shapes are handled. When `all` is set, every returned address is filtered:
 * returning only the safe subset would let a hostname that resolves to one public
 * and one private address still be contacted, and worse, would make the outcome
 * depend on resolver ordering. One bad address fails the whole connection.
 */
function guardedLookup(hostname: string, options: dns.LookupOptions, callback: unknown): void {
  // `dns.lookup`'s callback is overloaded on `options.all`; the cast is confined
  // to this one boundary rather than leaking an `any` into the module.
  const done = callback as (
    err: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number,
  ) => void;

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return done(err);
    if (addresses.length === 0) {
      return done(new BlockedAddressError(hostname, "no address", "DNS returned no records"));
    }

    for (const entry of addresses) {
      const reason = blockedAddressReason(entry.address);
      if (reason !== null) {
        return done(new BlockedAddressError(hostname, entry.address, reason));
      }
    }

    if (options.all === true) return done(null, addresses);
    return done(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * The guard for an IP LITERAL, which `guardedLookup` never sees.
 *
 * Node skips `lookup` entirely when the host is already an address, so a URL such as
 * `http://169.254.169.254/` reached the socket without the check the rest of this
 * module promises. Every caller that accepts a TENANT-supplied URL already refuses
 * private literals upstream (`webhook-url.ts`, `mcp-destination.ts`); this closes the
 * transport itself, so that promise holds for operator-configured origins too.
 * Thrown before any socket exists: nothing is sent.
 */
function literalAddressRefusal(url: URL, allowPrivate: boolean | undefined): BlockedAddressError | null {
  if (allowPrivate === true) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) === 0) return null;
  const reason = blockedAddressReason(host);
  return reason === null ? null : new BlockedAddressError(host, host, reason);
}

/**
 * POST a body to a validated URL with the socket-level guards applied.
 *
 * Rejects on transport failure, timeout or a refused address; resolves with the
 * status for any HTTP reply, including 3xx and 5xx. `ok` is true only for 2xx —
 * a redirect is not a successful delivery.
 */
export function sendGuarded(request: GuardedRequest): Promise<GuardedResponse> {
  const { url, headers, body, timeoutMs, allowPrivate } = request;
  /*
   * L'encodage décide de `Content-Length` ET de ce qui part sur le socket. Les deux
   * doivent être calculés avec le même, sinon l'en-tête annonce une longueur que le corps
   * n'a pas — et le fournisseur attend des octets qui ne viendront jamais.
   */
  const encoding = request.bodyEncoding ?? "utf8";
  const transport = url.protocol === "https:" ? https : http;

  const literal = literalAddressRefusal(url, allowPrivate);
  if (literal) return Promise.reject(markSent(literal, false));

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method ?? "POST",
        /*
         * `Content-Length` seulement quand il y a un corps. Un `GET` avec
         * `Content-Length: 0` est légal mais quelques passerelles le traitent comme une
         * requête malformée, et l'API GitHub n'en a pas besoin.
         */
        headers:
          body === ""
            ? { ...headers }
            : { ...headers, "Content-Length": Buffer.byteLength(body, encoding).toString() },
        // The whole point of this file. Opting out is a deliberate operator choice.
        lookup: allowPrivate === true ? undefined : guardedLookup,
        /* Voir `CONNECT_ATTEMPT_MS` : la valeur par défaut de Node (250 ms) échoue sur une liaison lente. */
        ...CONNECT_OPTIONS,
      },
      (res) => {
        const capture = request.captureBody === true;
        const cap = capture ? MAX_CAPTURED_BYTES : MAX_RESPONSE_BYTES;
        const chunks: Buffer[] = [];
        let received = 0;
        let overflowed = false;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > cap) {
            overflowed = true;
            res.destroy();
            return;
          }
          if (capture) chunks.push(chunk);
        });

        const settle = () =>
          finish(() => {
            if (capture && overflowed) {
              // See `captureBody`: a partial answer is refused, not returned.
              reject(
                new Error(
                  `Downstream response exceeded ${cap} bytes and was refused rather than ` +
                    "truncated.",
                ),
              );
              return;
            }
            const status = res.statusCode ?? 0;
            const result: GuardedResponse = { status, ok: status >= 200 && status < 300 };
            if (capture) {
              result.body = Buffer.concat(chunks).toString("utf8");
              result.headers = Object.fromEntries(
                Object.entries(res.headers).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(", ") : String(v ?? ""),
                ]),
              );
            }
            resolve(result);
          });

        res.on("end", settle);
        // A body truncated by the cap is not a delivery failure for a webhook:
        // the receiver already accepted the event, and the reply is discarded.
        res.on("close", settle);
        res.on("error", (error) => finish(() => reject(markSent(error, true))));
      },
    );

    /*
     * LA REQUÊTE EST-ELLE PARTIE ? `finish` signifie que la requête entière a été remise
     * au système d'exploitation. Une erreur APRÈS ce point — un délai d'attente de la
     * réponse, une connexion coupée en lisant — laisse l'effet INCONNU : le service a
     * peut-être agi. Une erreur AVANT — nom introuvable, connexion refusée, adresse
     * bloquée — garantit que rien n'est parti. Voir `requestMayHaveReached`.
     */
    let sent = false;
    req.on("finish", () => {
      sent = true;
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Outbound request to ${url.host} timed out after ${timeoutMs}ms`));
    });
    req.on("error", (error) => finish(() => reject(markSent(error, sent))));
    req.end(body, encoding);
  });
}

const REQUEST_SENT = Symbol("placet.requestSent");

function markSent(error: unknown, sent: boolean): unknown {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, REQUEST_SENT, { value: sent, enumerable: false });
  }
  return error;
}

/**
 * Une erreur de transport laisse-t-elle l'effet INCONNU chez le destinataire ?
 *
 * `true` quand la requête avait été entièrement envoyée avant l'erreur, ou quand on ne
 * sait pas (erreur venue d'ailleurs) : un connecteur ne doit alors JAMAIS écrire « rien
 * n'est parti ». `false` seulement quand le transport a établi que rien n'avait été
 * remis — c'est la seule affirmation qu'on puisse faire sans réponse du service.
 */
export function requestMayHaveReached(error: unknown): boolean {
  if (error === null || typeof error !== "object") return true;
  const flag = (error as Record<symbol, unknown>)[REQUEST_SENT];
  return flag !== false;
}

/**
 * Le même envoi, mais le corps COULE au lieu d'être tamponné.
 *
 * ## Ce qui est partagé avec `sendGuarded`, et pourquoi c'est écrit ici
 *
 * `guardedLookup` — donc la vérification d'adresse au niveau du socket, celle qu'un
 * rebinding DNS ne peut pas contourner. Et l'absence de suivi de redirection : un 3xx est
 * rendu tel quel à l'appelant, jamais suivi.
 *
 * Ces deux gardes sont la raison d'être du fichier, et c'est pourquoi le mode flux vit
 * ICI plutôt que dans un second client HTTP. Une seconde copie d'une liste anti-SSRF est
 * une copie qui prend du retard — la même règle que `mcp-destination.ts` applique.
 *
 * ## Ce qui est différent, et c'est une décision de gouvernance
 *
 * Le mode tamponné REFUSE une réponse trop grosse ; celui-ci la COUPE. L'appelant a déjà
 * commencé à relayer des octets quand le plafond tombe, et HTTP n'offre pas de reprise. On
 * coupe, et `completion` le dit pour que le reçu porte « tronqué » plutôt que « réussi ».
 *
 * Rejette comme `sendGuarded` tant que les EN-TÊTES ne sont pas arrivés : un échec de
 * transport, un délai dépassé, une adresse refusée. Après les en-têtes, plus rien ne
 * rejette — tout passe par `completion`.
 */
export function streamGuarded(request: GuardedRequest): Promise<GuardedStream> {
  const { url, headers, body, timeoutMs, allowPrivate } = request;
  const encoding = request.bodyEncoding ?? "utf8";
  const transport = url.protocol === "https:" ? https : http;

  const literal = literalAddressRefusal(url, allowPrivate);
  if (literal) return Promise.reject(literal);

  return new Promise<GuardedStream>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method ?? "POST",
        headers:
          body === ""
            ? { ...headers }
            : { ...headers, "Content-Length": Buffer.byteLength(body, encoding).toString() },
        lookup: allowPrivate === true ? undefined : guardedLookup,
        /* Voir `CONNECT_ATTEMPT_MS` : la valeur par défaut de Node (250 ms) échoue sur une liaison lente. */
        ...CONNECT_OPTIONS,
      },
      (res) => {
        /*
         * Le délai d'ÉTABLISSEMENT est remplacé par un délai d'INACTIVITÉ dès que les
         * en-têtes sont là. Garder `timeoutMs` couperait un flux de modèle parfaitement
         * sain au bout de trente secondes — ce qui serait la panne que ce mode existe
         * pour éviter.
         */
        req.setTimeout(0);
        res.setTimeout(STREAM_IDLE_MS, () => {
          res.destroy(new Error(`silent for more than ${STREAM_IDLE_MS}ms`));
        });

        const out = new PassThrough();
        let bytes = 0;
        let truncated = false;
        let reason: string | null = null;
        let done: (value: { bytes: number; truncated: boolean; reason: string | null }) => void;
        const completion = new Promise<{ bytes: number; truncated: boolean; reason: string | null }>(
          (r) => (done = r),
        );
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(ceiling);
          done({ bytes, truncated, reason });
        };

        /*
         * Le plafond de durée. `unref` pour qu'un flux en cours n'empêche pas le processus
         * de s'arrêter : un arrêt propre ne doit pas attendre dix minutes.
         */
        const ceiling = setTimeout(() => {
          truncated = true;
          reason = `stream cut after ${MAX_STREAM_MS}ms`;
          res.destroy();
          out.end();
        }, MAX_STREAM_MS);
        ceiling.unref();

        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_STREAM_BYTES) {
            truncated = true;
            reason = `stream cut beyond ${MAX_STREAM_BYTES} bytes`;
            res.destroy();
            out.end();
            return;
          }
          /*
           * `write` rend `false` quand le consommateur est en retard. On met la réponse en
           * pause et on reprend sur `drain` : sans cette contre-pression, un amont rapide
           * devant un agent lent ferait grossir le tampon du `PassThrough` sans borne —
           * c'est-à-dire reconstituerait en mémoire exactement ce que le mode flux évite.
           */
          if (!out.write(chunk)) {
            res.pause();
            out.once("drain", () => res.resume());
          }
        });

        res.on("end", () => {
          out.end();
          close();
        });
        res.on("error", (error: Error) => {
          truncated = true;
          reason = error.message;
          out.end();
          close();
        });
        /*
         * L'agent a raccroché : on coupe l'amont. Sans ça, le fournisseur continuerait
         * d'émettre vers un `PassThrough` que personne ne lit, et l'exécution resterait
         * ouverte jusqu'au plafond de durée.
         */
        out.on("close", () => {
          if (!res.destroyed) res.destroy();
          close();
        });

        finish(() =>
          resolve({
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(", ") : String(v ?? ""),
              ]),
            ),
            body: out,
            completion,
          }),
        );
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Outbound request to ${url.host} timed out after ${timeoutMs}ms`));
    });
    req.on("error", (error) => finish(() => reject(error)));
    req.end(body, encoding);
  });
}
