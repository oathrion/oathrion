/**
 * REGROUPER LES NOTIFICATIONS RAPPROCHÉES — moins déranger, sans jamais retarder la première.
 *
 * Un agent qui écrit trois fichiers d'affilée produisait trois notifications en dix secondes.
 * Une personne interrompue sans cesse finit par tout approuver sans lire, ou par tout couper :
 * c'est le premier risque du parcours (« ne prévient que si nécessaire »).
 *
 *   · la PREMIÈRE demande après un moment calme part tout de suite ;
 *   · les suivantes, pendant `windowMs`, sont mises de côté ; à la fin de la fenêtre, celles qui
 *     attendent ENCORE partent en une seule notification (« 3 requests are waiting ») — une seule
 *     restante part telle quelle, aucune ne part si toutes ont été tranchées entre-temps.
 */
import type { DeliveryResult, NotificationEvent } from "./types";

export interface CoalesceOptions {
  windowMs: number;
  /** La demande attend-elle encore ? Absent : on la suppose en attente. */
  pending?: (approvalId: string | null) => Promise<boolean>;
  now?: () => number;
}

/** Le message groupé : la première demande sert de modèle, `data.grouped` dit combien. */
export function groupedEvent(events: readonly NotificationEvent[]): NotificationEvent {
  const first = events[0]!;
  return {
    ...first,
    id: `${first.id}-grouped`,
    approvalId: null,
    title: `${String(events.length)} requests are waiting for your decision`,
    summary: events.map((event) => event.title).slice(0, 3).join(" · ") + (events.length > 3 ? " · …" : ""),
    data: {
      ...first.data,
      grouped: events.length,
      titles: events.map((event) => event.title).slice(0, 5),
      /* Ce que chacune demande, dit comme dans la console : la notification les liste (`desktopText`). */
      headlines: events.map((event) => (event.data.words as { headline?: unknown } | undefined)?.headline).filter((h): h is string => typeof h === "string").slice(0, 5),
      /* Les mêmes, dites par l'agent comme un ami (`shared/friendly-words.ts`). */
      asks: events.map((event) => (event.data.words as { friendly?: { ask?: unknown } } | undefined)?.friendly?.ask).filter((h): h is string => typeof h === "string").slice(0, 5),
      sameAgent: events.every((event) => event.agentName === first.agentName),
    },
  };
}

export function coalesced(deliver: (event: NotificationEvent) => Promise<DeliveryResult>, channelId: string, options: CoalesceOptions) {
  const now = options.now ?? Date.now;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let held: NotificationEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    timer = null;
    const waiting: NotificationEvent[] = [];
    for (const event of held) if (!options.pending || (await options.pending(event.approvalId))) waiting.push(event);
    held = [];
    if (waiting.length === 0) return;
    lastSentAt = now();
    await deliver(waiting.length === 1 ? waiting[0]! : groupedEvent(waiting));
  };

  return async (event: NotificationEvent): Promise<DeliveryResult> => {
    if (timer === null && now() - lastSentAt >= options.windowMs) {
      lastSentAt = now();
      return deliver(event);
    }
    held.push(event);
    if (timer === null) {
      timer = setTimeout(() => void flush(), Math.max(0, lastSentAt + options.windowMs - now()));
      timer.unref?.();
    }
    return { channelId, eventId: event.id, at: new Date(now()).toISOString(), ok: true, detail: "grouped with the next notification" };
  };
}
