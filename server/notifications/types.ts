/**
 * Notification contracts.
 *
 * The control plane emits *events*; channels decide what to do with them.
 * Slack, email or PagerDuty are later additions that implement
 * `NotificationChannel` and register themselves — no caller changes.
 */

export type NotificationEventType =
  | "approval.requested"
  | "approval.resolved"
  | "action.blocked"
  /*
   * La réconciliation a vu chez un service une écriture faite HORS d'Oathrion (ou une
   * marque inconnue). Émis une fois par écriture : la base n'en rend que les nouvelles.
   * `agentId` est vide — le service ne dit pas quel agent, seulement quelle identité.
   */
  | "reconciliation.alert"
  /*
   * Des autorisations ont été consommées sans que leur reçu soit jamais écrit (processus
   * tué entre l'appel au fournisseur et le reçu, patience épuisée). L'action a peut-être
   * eu lieu chez le fournisseur sans trace dans la chaîne. Émis une fois par autorisation.
   */
  | "receipt.gap";

export interface NotificationEvent {
  id: string;
  type: NotificationEventType;
  at: string;
  /** One-line human summary — what a Slack message or an email subject shows. */
  title: string;
  /** Longer context, safe to render as plain text. */
  summary: string;
  risk: string;
  agentId: string;
  agentName: string;
  executionId: string | null;
  approvalId: string | null;
  policyId: string | null;
  policyName: string | null;
  /** Structured extras a channel may template with. */
  data: Record<string, unknown>;
}

export interface DeliveryResult {
  channelId: string;
  eventId: string;
  at: string;
  ok: boolean;
  /** Transport-level detail: HTTP status, or the failure message. */
  detail: string;
}

export interface NotificationChannel {
  readonly id: string;
  /** Channels opt in per event type so a noisy one can stay narrow. */
  handles(type: NotificationEventType): boolean;
  deliver(event: NotificationEvent): Promise<DeliveryResult>;
}
