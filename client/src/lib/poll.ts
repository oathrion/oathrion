/**
 * Relire quelque chose à intervalle, tant que l'onglet est visible.
 *
 * Écrit pour la page Approvals, qui ne relisait la liste qu'à son ouverture. Relevé en
 * essayant Claude Code de bout en bout le 5 novembre : une deuxième demande arrivée trois
 * secondes après la première approbation est restée invisible — « Pending 0 » — jusqu'à ce
 * qu'on recharge la page, ce qui, la session vivant dans l'onglet, déconnecte.
 *
 *   · onglet caché : aucune requête ; au retour, une relecture immédiate ;
 *   · une relecture encore en cours n'en lance pas une seconde : une réponse lente ne
 *     s'empile pas.
 */

export interface Visibility {
  visible: () => boolean;
  /** Appelle `listener` quand l'onglet redevient visible ; rend de quoi arrêter. */
  onVisible: (listener: () => void) => () => void;
}

const browserVisibility = (): Visibility => ({
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  onVisible: (listener) => {
    if (typeof document === "undefined") return () => undefined;
    const handler = () => {
      if (document.visibilityState !== "hidden") listener();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
});

/** Lance la relecture ; rend la fonction qui l'arrête. */
export function pollWhileVisible(run: () => Promise<unknown> | void, everyMs: number, visibility: Visibility = browserVisibility()): () => void {
  let running = false;
  const tick = () => {
    if (running || !visibility.visible()) return;
    running = true;
    void Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, everyMs);
  const stopListening = visibility.onVisible(tick);
  return () => {
    clearInterval(timer);
    stopListening();
  };
}
