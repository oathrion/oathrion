/**
 * Les noms d'événements du journal d'une exécution, tels que la console les affiche.
 *
 * Le serveur les écrit en anglais, et ils restent ainsi en base : chaque entrée est chaînée
 * (`server/audit-chain.ts`). La console les traduisait en français ; depuis le 4 novembre 2026
 * elle est en anglais et les montre tels quels.
 */
export function auditEventLabel(event: string): string {
  return event;
}
