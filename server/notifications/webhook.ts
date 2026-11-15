/**
 * HTTP webhook channel — the one concrete transport the MVP ships.
 *
 * Deliberately dumb: POST the event as JSON, sign it, give up after a timeout.
 * A Slack or email channel is a sibling file implementing the same interface;
 * nothing upstream changes when one is added.
 *
 * It is dumb about *content*, not about *destination*. This channel is a signed,
 * server-side HTTP client living inside the control plane's trust boundary, which
 * makes it an SSRF primitive: whoever influences its URL decides what the control
 * plane connects to. It previously called global `fetch` with the raw configured
 * string, so cloud metadata endpoints, loopback admin ports and RFC1918 hosts were
 * all reachable, and redirects were followed by default. `webhook-url.ts` explains
 * the exposure in full; `webhook-transport.ts` holds the socket-level guards.
 *
 * Validation happens in the constructor so a bad URL fails loudly at boot rather
 * than silently at the first notification an operator was relying on.
 */

import crypto from "node:crypto";
import { sendGuarded } from "./webhook-transport";
import { assertSafeWebhookUrl } from "./webhook-url";
import type { DeliveryResult, NotificationChannel, NotificationEvent, NotificationEventType } from "./types";
import { legacyWireHeader, wireHeader } from "@shared/wire-headers";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface WebhookOptions {
  url: string;
  secret?: string;
  timeoutMs?: number;
  /** Restrict to specific event types. Empty means "everything". */
  types?: NotificationEventType[];
  /**
   * Injectable for tests; when supplied it replaces the guarded transport.
   *
   * Retained deliberately: the existing suite drives this channel through a fake
   * `fetch` and asserts on signatures, headers and retry behaviour, none of which
   * should require a live socket. A test double is inside the trust boundary by
   * definition, so it is not subject to the address guard — but the URL is still
   * validated in the constructor, so a test cannot accidentally document a
   * dangerous URL as acceptable configuration.
   */
  fetchImpl?: typeof fetch;
  /**
   * Permit loopback / private-range destinations. Off unless the operator sets
   * `OATHRION_WEBHOOK_ALLOW_PRIVATE=true`. Never inferred.
   */
  allowPrivate?: boolean;
}

export class WebhookChannel implements NotificationChannel {
  readonly id = "webhook";
  private readonly types: Set<NotificationEventType>;
  private readonly url: URL;

  constructor(private readonly options: WebhookOptions) {
    this.types = new Set(options.types ?? []);
    // Throws WebhookUrlError on a refused target. Callers that must not crash on
    // bad configuration (`configureNotifications`) catch it and register nothing;
    // fail-closed, never fail-open.
    this.url = assertSafeWebhookUrl(options.url, { allowPrivate: options.allowPrivate });
  }

  handles(type: NotificationEventType): boolean {
    return this.types.size === 0 || this.types.has(type);
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    const at = new Date().toISOString();
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Oathrion/1.0",
      [wireHeader("event")]: event.type,
      [wireHeader("delivery")]: event.id,
      /*
       * OBSOLÈTES (renommage Placet → Oathrion). Un receveur construit contre le nom
       * précédent filtre sur `X-Placet-*` ; retirer ces en-têtes casserait en silence
       * chaque intégration existante à la mise à jour, et le receveur est du code tiers
       * qu'on ne peut pas migrer. Dupliqués, donc, et non remplacés.
       *
       * Les `X-ARIA-*` (et avant eux `X-AgentOS-*`) sont en revanche RETIRÉS ici : trois
       * signatures du même corps dans une même requête n'est pas de la compatibilité,
       * c'est un contrat qu'on ne peut plus énoncer — et un receveur qui vérifie la
       * mauvaise des trois se croit protégé. Une génération sort quand une entre.
       */
      [legacyWireHeader("event")]: event.type,
      [legacyWireHeader("delivery")]: event.id,
    };

    // Signed so the receiver can prove the payload came from this control
    // plane and was not replayed with edits. Optional: an internal endpoint
    // behind a VPN may not need it.
    if (this.options.secret) {
      const signature = `sha256=${crypto
        .createHmac("sha256", this.options.secret)
        .update(body)
        .digest("hex")}`;
      headers[wireHeader("signature")] = signature;
      // Même obsolescence que les en-têtes d'événement ci-dessus : un receveur existant
      // vérifie `X-Oathrion-Signature` et rejette tout ce qui n'est pas signé, donc
      // l'en-tête hérité doit porter une valeur IDENTIQUE sur un corps identique.
      headers[legacyWireHeader("signature")] = signature;
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const res = await this.send(headers, body, timeoutMs);
      return {
        channelId: this.id,
        eventId: event.id,
        at,
        ok: res.ok,
        detail: `HTTP ${res.status}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transport error";
      return { channelId: this.id, eventId: event.id, at, ok: false, detail: message };
    }
  }

  /**
   * Dispatch via the injected double when present, else the guarded transport.
   *
   * Kept separate from `deliver` so the error/result shaping above is identical on
   * both paths — a divergence there is how a test suite ends up proving something
   * the production path does not do.
   */
  private async send(
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number }> {
    const injected = this.options.fetchImpl;
    if (injected) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await injected(this.url.toString(), {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        return { ok: res.ok, status: res.status };
      } finally {
        clearTimeout(timer);
      }
    }

    return sendGuarded({
      url: this.url,
      headers,
      body,
      timeoutMs,
      allowPrivate: this.options.allowPrivate,
    });
  }
}
