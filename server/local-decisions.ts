/**
 * LA DÉCISION DANS LE NAVIGATEUR (11 novembre, avant la publication) : la notification d'Oathrion
 * avec la mascotte, ses boutons et le partage n'existe que sous Linux (`notifications/popup.ts`).
 * Sous macOS et Windows, la notification du système n'a qu'un bouton, « Decide » : il ouvre
 * maintenant la console sur CETTE décision (`/decide?e=<id>`), avec la mascotte de l'agent, les
 * mêmes boutons, puis « Was this right? » et le partage. Les boutons passent par la même voie que
 * ceux de la fenêtre (`onAction` de `local-notifications.ts`) : rien n'est décidé deux fois.
 *
 * En mémoire, les 50 dernières : une décision n'est pas une donnée à garder (le fil et les reçus
 * gardent ce qui s'est passé). Rien de privé : le titre, le texte et la mascotte de la notification.
 */
import { desktopText, doneOf, notificationActions } from "./notifications/desktop";
import type { NotificationEvent } from "./notifications/types";

/** Ce qu'un bouton a fait : le texte affiché, et la phrase à partager quand il y en a une. */
export interface DecisionDone {
  text: string;
  share?: string;
}

export interface DecisionView {
  id: string;
  title: string;
  body: string;
  mascot: { id: string; name: string } | null;
  danger: boolean;
  actions: { id: string; label: string }[];
  done: DecisionDone | null;
  judged: boolean;
  /** La phrase à partager, avant même d'avoir décidé (un leurre lu), ou après. */
  share: string | null;
}

interface Pending {
  event: NotificationEvent;
  done: DecisionDone | null;
  judged: boolean;
}

export interface DecisionHandlers {
  act: (event: NotificationEvent, actionId: string) => unknown;
  feedback: (event: NotificationEvent, right: boolean, decision: string) => void;
}

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export class DecisionDesk {
  private readonly items = new Map<string, Pending>();
  private handlers: DecisionHandlers | null = null;

  /** Les boutons et le feedback : ceux des notifications, branchés par `registerLocalNotifications`. */
  bind(handlers: DecisionHandlers): void {
    this.handlers = handlers;
  }

  /** Garde une notification à boutons ; rend son identifiant, ou `null` si elle n'a rien à décider. */
  keep(event: NotificationEvent): string | null {
    if (!ID.test(event.id) || notificationActions(event).length === 0) return null;
    if (!this.items.has(event.id)) this.items.set(event.id, { event, done: null, judged: false });
    while (this.items.size > 50) this.items.delete(this.items.keys().next().value!);
    return event.id;
  }

  view(id: string): DecisionView | null {
    const item = this.items.get(id);
    if (!item) return null;
    const { event } = item;
    const mascot = (event.data.mascot ?? null) as { id?: unknown; name?: unknown } | null;
    const given = typeof event.data.share === "string" && event.data.share !== "" ? event.data.share : null;
    /* Les mots de la notification elle-même (« Claude Code wants to run: … »), pas ceux de l'événement brut. */
    const { title, body } = desktopText(event);
    return {
      id,
      title,
      body,
      mascot: typeof mascot?.id === "string" ? { id: mascot.id, name: typeof mascot.name === "string" ? mascot.name : mascot.id } : null,
      danger: event.data.danger === true,
      actions: notificationActions(event),
      done: item.done,
      judged: item.judged,
      share: item.done?.share ?? given,
    };
  }

  /** Un bouton : agit une seule fois ; un second clic (ou la fenêtre déjà cliquée) rend ce qui a été fait. */
  async choose(id: string, actionId: string): Promise<DecisionDone | string> {
    const item = this.items.get(id);
    if (!item) return "This decision is no longer here: it may have been made from the notification.";
    if (item.done) return item.done;
    if (!notificationActions(item.event).some((a) => a.id === actionId)) return `Unknown choice: ${actionId}`;
    if (!this.handlers) return "Oathrion cannot act on this decision right now.";
    item.done = doneOf(await this.handlers.act(item.event, actionId));
    return item.done;
  }

  /** « Was this right? » : une réponse par décision. */
  judge(id: string, right: boolean): boolean {
    const item = this.items.get(id);
    if (!item || !item.done || item.judged || !this.handlers) return false;
    item.judged = true;
    this.handlers.feedback(item.event, right, item.done.text);
    return true;
  }
}
