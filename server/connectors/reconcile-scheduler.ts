/**
 * La réconciliation périodique : sans que personne n'appuie sur un bouton, Oathrion relit
 * régulièrement chez chaque service ce qui s'est fait sans lui, et alerte.
 *
 * `OATHRION_RECONCILE_INTERVAL_MS` — par défaut une heure ; `0` coupe la tâche ; jamais
 * moins d'une minute (un service n'a pas à être interrogé en continu, et un quota épuisé
 * empêcherait aussi les vraies actions des agents).
 *
 * Ce que la tâche garantit :
 *   · le premier passage a lieu APRÈS un intervalle — le démarrage n'attend aucun service ;
 *   · un passage qui n'a pas fini empêche le suivant de démarrer (pas d'empilement) ;
 *   · une organisation, puis un outil, à la fois ; l'échec de l'un n'arrête pas les autres ;
 *   · rien n'est lancé pendant l'arrêt du serveur, et le minuteur ne retient pas le processus ;
 *   · une écriture n'alerte qu'une fois, même avec plusieurs instances (`reconcile-store.ts`).
 *
 * Ce qu'elle ne garantit pas : avec plusieurs instances, chacune interroge les services
 * (les alertes, elles, restent uniques). Le dire est préférable à un verrou distribué
 * qu'aucun test n'éprouve ici.
 */

export const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
export const MIN_RECONCILE_INTERVAL_MS = 60 * 1000;

/** Un intervalle lu dans l'environnement, borné. `0` coupe la tâche. Une valeur illisible garde le défaut. */
export function intervalMsFrom(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (value === 0) return 0;
  return Math.max(MIN_RECONCILE_INTERVAL_MS, Math.floor(value));
}

/** L'intervalle demandé, borné. `0` coupe la tâche. Une valeur illisible garde le défaut. */
export function reconcileIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return intervalMsFrom(env.OATHRION_RECONCILE_INTERVAL_MS, DEFAULT_RECONCILE_INTERVAL_MS);
}

/**
 * La recherche des actions sans reçu (`server/authority/receipt-gaps.ts`) : toutes les
 * 5 minutes par défaut. Une requête par organisation, servie par des index ; un trou
 * doit se voir vite, pas à l'heure suivante.
 */
export const DEFAULT_RECEIPT_GAP_INTERVAL_MS = 5 * 60 * 1000;
export function receiptGapIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return intervalMsFrom(env.OATHRION_RECEIPT_GAP_INTERVAL_MS, DEFAULT_RECEIPT_GAP_INTERVAL_MS);
}

export interface ReconcileSchedulerOptions<Org extends { id: string; name: string; active: boolean }> {
  intervalMs: number;
  organizations: () => Org[];
  runOrganization: (organization: Org) => Promise<void>;
  isShuttingDown: () => boolean;
  log: (message: string) => void;
  /** Ce que la tâche fait, pour le journal. « réconciliation périodique » par défaut. */
  label?: string;
  /** La variable qui la règle, pour le journal. */
  variable?: string;
}

export interface ReconcileScheduler {
  /** Un passage complet, maintenant. Exposé pour les tests ; la tâche l'appelle seule. */
  tick(): Promise<void>;
  stop(): void;
}

export function startReconcileScheduler<Org extends { id: string; name: string; active: boolean }>(
  options: ReconcileSchedulerOptions<Org>,
): ReconcileScheduler {
  let running = false;
  const label = options.label ?? "periodic reconciliation";
  const variable = options.variable ?? "OATHRION_RECONCILE_INTERVAL_MS";

  async function tick(): Promise<void> {
    if (running || options.isShuttingDown()) return;
    running = true;
    try {
      for (const organization of options.organizations()) {
        if (!organization.active || options.isShuttingDown()) continue;
        try {
          await options.runOrganization(organization);
        } catch (error) {
          /* Le message d'erreur seulement : jamais un corps de réponse, jamais un en-tête. */
          options.log(`${label} of ${organization.id} interrupted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      running = false;
    }
  }

  if (options.intervalMs <= 0) {
    options.log(`${label} disabled (${variable}=0)`);
    return { tick, stop: () => undefined };
  }
  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  options.log(`${label} every ${String(Math.round(options.intervalMs / 60000))} min`);
  return { tick, stop: () => clearInterval(timer) };
}
