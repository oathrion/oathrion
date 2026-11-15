/**
 * Notifier — the fan-out point between the control plane and the outside world.
 *
 * Two rules make this safe to call from a request path:
 *
 *  1. **Never blocking.** `emit()` returns immediately; delivery runs after.
 *     An approval is recorded whether or not Slack is up.
 *  2. **Never throwing.** A channel that fails is recorded as a failed
 *     delivery. A broken webhook cannot break a decision.
 *
 * The recent-deliveries buffer is intentionally in memory and small: it exists
 * so an operator can answer "did the webhook fire?" without a log aggregator.
 */

import crypto from "node:crypto";
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationEvent,
  NotificationEventType,
} from "./types";
import { WebhookChannel } from "./webhook";
import { SlackChannel } from "./slack";

export type { NotificationChannel, NotificationEvent, NotificationEventType, DeliveryResult };
export { WebhookChannel };

const RECENT_LIMIT = 50;

export interface EmitInput extends Omit<NotificationEvent, "id" | "at"> {
  at?: string;
}

export class Notifier {
  private readonly channels: NotificationChannel[] = [];
  private readonly recent: DeliveryResult[] = [];
  /** Tracked so tests can await the fan-out instead of sleeping. */
  private inFlight: Promise<unknown> = Promise.resolve();

  register(channel: NotificationChannel): this {
    this.channels.push(channel);
    return this;
  }

  clear(): void {
    this.channels.length = 0;
    this.recent.length = 0;
  }

  get channelIds(): string[] {
    return this.channels.map((c) => c.id);
  }

  /** Fire-and-forget. Returns the event that was queued, not the deliveries. */
  emit(input: EmitInput): NotificationEvent {
    const event: NotificationEvent = {
      ...input,
      id: `ntf_${crypto.randomBytes(8).toString("hex")}`,
      at: input.at ?? new Date().toISOString(),
    };

    const targets = this.channels.filter((c) => c.handles(event.type));
    if (targets.length === 0) return event;

    const work = Promise.all(
      targets.map((channel) =>
        channel
          .deliver(event)
          .catch((error: unknown) => ({
            channelId: channel.id,
            eventId: event.id,
            at: new Date().toISOString(),
            ok: false,
            detail: error instanceof Error ? error.message : "Channel threw",
          }))
          .then((result: DeliveryResult) => {
            this.record(result);
            if (!result.ok) {
              console.warn(`[notify] ${result.channelId} failed for ${event.type}: ${result.detail}`);
            }
            return result;
          }),
      ),
    );

    this.inFlight = this.inFlight.then(() => work);
    return event;
  }

  /** Resolves once every queued delivery has settled. Used by tests. */
  async drain(): Promise<void> {
    await this.inFlight;
  }

  recentDeliveries(limit = RECENT_LIMIT): DeliveryResult[] {
    return this.recent.slice(0, limit);
  }

  private record(result: DeliveryResult): void {
    this.recent.unshift(result);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
  }
}

export const notifier = new Notifier();

/**
 * Wires the channels declared in the environment. Called once at boot.
 * No webhook configured is a valid state — notifications are optional.
 */
export function configureNotifications(target: Notifier = notifier): string[] {
  /*
   * LE CANAL SLACK D'ABORD, et indépendamment du webhook générique.
   *
   * Les deux sont utiles ensemble : Slack porte les demandes d'approbation, avec leurs
   * boutons, et le webhook porte tout le reste vers l'outil de l'exploitant. Les lier
   * obligerait à choisir.
   *
   * Un `OATHRION_SLACK_WEBHOOK_URL` sans secret de signature ne démarre pas — voir
   * `slackConfigProblems`, appelé par `runtimeConfigProblems`. Ici on peut donc supposer
   * la configuration cohérente, et il reste à la monter.
   */
  const slackUrl = process.env.OATHRION_SLACK_WEBHOOK_URL?.trim();
  if (slackUrl) {
    try {
      target.register(
        new SlackChannel({
          url: slackUrl,
          allowPrivate: process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE?.trim().toLowerCase() === "true",
        }),
      );
    } catch (error) {
      /*
       * Fail closed, et l'URL n'est PAS journalisée : un webhook entrant Slack porte son
       * secret dans son chemin.
       */
      const reason = error instanceof Error ? error.message : "unknown validation failure";
      console.error(`[notify] OATHRION_SLACK_WEBHOOK_URL rejected — no Slack channel registered. ${reason}`);
    }
  }

  const url = process.env.OATHRION_WEBHOOK_URL?.trim();
  if (!url) return target.channelIds;

  const timeoutRaw = Number(process.env.OATHRION_WEBHOOK_TIMEOUT_MS);

  /*
   * `OATHRION_WEBHOOK_ALLOW_PRIVATE` lets an operator point the webhook at loopback
   * or an RFC1918 neighbour — a legitimate single-host deployment shape, and an SSRF
   * primitive everywhere else. It is opt-in, exact-match on "true", and never
   * inferred from the URL: inferring it would mean the guard disables itself
   * precisely when it is needed.
   */
  const allowPrivate = process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE?.trim().toLowerCase() === "true";

  try {
    // The old check here was `/^https?:\/\//`, which accepted
    // `http://169.254.169.254/` — the cloud metadata service — as valid
    // configuration. Construction now validates the destination properly and
    // throws WebhookUrlError on a refused target.
    target.register(
      new WebhookChannel({
        url,
        secret: process.env.OATHRION_WEBHOOK_SECRET?.trim() || undefined,
        timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined,
        allowPrivate,
      }),
    );
  } catch (error) {
    // Fail closed: no channel is registered, so nothing is delivered anywhere.
    // The message explains the refusal and how to override it deliberately, because
    // a webhook that "silently does nothing" is how permissive fallbacks get added.
    // The URL itself is not logged — it may carry a token in its path.
    const reason = error instanceof Error ? error.message : "unknown validation failure";
    console.error(`[notify] OATHRION_WEBHOOK_URL rejected — no webhook registered. ${reason}`);
    return target.channelIds;
  }

  return target.channelIds;
}
