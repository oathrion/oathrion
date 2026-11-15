/**
 * Ce que le Hero affiche, et comment il le choisit.
 *
 * Deux scènes, une décision prise sur les capacités réelles du visiteur :
 *
 *   - **le noyau WebGL** quand l'appareil peut le porter — un volume qui occupe l'espace
 *     et donne au Hero sa présence ;
 *   - **la scène SVG** sinon, et elle n'est pas un lot de consolation : c'est elle qui
 *     raconte la séquence des contrôles, et elle reste sous le noyau sur grand écran.
 *
 * Les conditions de repli sont des faits, pas des suppositions : pas de WebGL, mouvement
 * réduit demandé, écran étroit, ou peu de cœurs. Un portable bon marché ne doit pas
 * chauffer pour une page d'accueil.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { FlowScene } from "./FlowScene";

const ControlCore = lazy(() =>
  import("./ControlCore").then((module) => ({ default: module.ControlCore })),
);

function capable(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return false;
  if (window.innerWidth < 1024) return false;
  /*
   * Seul un cœur unique est refusé, et c'est un assouplissement délibéré.
   *
   * Le seuil était à deux cœurs — et il a rejeté la machine sur laquelle la scène a été
   * mise au point, qui en déclare deux. Or le garde de largeur ci-dessus écarte déjà les
   * téléphones, et ce qui reste est un icosaèdre en fil de fer avec huit sphères : moins
   * lourd que la bibliothèque de graphiques que la console charge sans sourciller. Un
   * garde si prudent qu'il éteint la fonctionnalité sur du matériel ordinaire ne protège
   * personne, il supprime juste la fonctionnalité.
   *
   * `hardwareConcurrency` est absent sur certains navigateurs : l'absence ne vaut pas
   * refus, on ne refuse que sur une valeur basse CONNUE.
   */
  const cores = navigator.hardwareConcurrency;
  if (typeof cores === "number" && cores <= 1) return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function HeroScene(): JSX.Element {
  const [eligible] = useState(capable);
  /*
   * Le volume n'est demandé qu'APRÈS le premier affichage.
   *
   * Mesuré : charger et compiler les 747 ko de Three.js occupe le fil principal plusieurs
   * secondes sur une machine modeste, et pendant ce temps le navigateur ne fait rien
   * d'autre. Le monter dès le premier rendu retardait donc ce que le visiteur était venu
   * lire, pour une décoration.
   *
   * `requestIdleCallback` attend que le navigateur n'ait plus rien d'urgent. Le repli par
   * minuterie existe pour Safari, qui ne l'implémente pas.
   */
  const [mount3d, setMount3d] = useState(false);
  useEffect(() => {
    if (!eligible) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (idle) {
      const handle = idle(() => setMount3d(true), { timeout: 2500 });
      return () => (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(() => setMount3d(true), 900);
    return () => window.clearTimeout(timer);
  }, [eligible]);

  return (
    <div className="scene">
      {mount3d && (
        <Suspense fallback={null}>
          <ControlCore />
        </Suspense>
      )}
      <FlowScene />
    </div>
  );
}
