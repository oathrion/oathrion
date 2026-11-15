/**
 * Le signal « cette approbation est tranchée », pour qui attend son issue.
 *
 * Le relais d'`oathrion wrap` relisait l'approbation toutes les secondes : approuvée, l'agent
 * attendait jusqu'à une seconde de plus sa réponse (1,03 s mesurés par
 * `script/mesure-fluidite.mjs`, le 28 octobre 2026). Désormais il ATTEND côté serveur
 * (`GET /api/approvals/:id/issue`), et la passerelle le réveille dès que l'issue est connue.
 *
 * Le signal est local au processus. Il ne porte aucune donnée : celui qui attend relit tout en
 * base. Plusieurs instances derrière un équilibreur ne se préviennent pas entre elles ; c'est
 * pourquoi l'attente relit aussi l'état chaque seconde — le signal accélère, il ne décide de rien.
 */
import { EventEmitter } from "node:events";

const signals = new EventEmitter();
signals.setMaxListeners(0);

const key = (organization: string, approvalId: string) => `${organization}\u0000${approvalId}`;

/** À appeler quand une approbation est tranchée ET que ce qui devait suivre a suivi. */
export function approvalSettled(organization: string, approvalId: string): void {
  signals.emit(key(organization, approvalId));
}

/** Attend le signal, au plus `ms` millisecondes. Rend toujours : l'appelant relit l'état. */
export function waitForApprovalSignal(organization: string, approvalId: string, ms: number): Promise<void> {
  return new Promise((done) => {
    const name = key(organization, approvalId);
    const finish = () => {
      clearTimeout(timer);
      signals.off(name, finish);
      done();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signals.once(name, finish);
  });
}
