/**
 * Le signal « non vérifiable ici », distinct de l'échec.
 *
 * Une propriété peut être parfaitement correcte et ne pas pouvoir être jugée sur un
 * profil donné : l'implémentation ne nomme pas l'objet dont la propriété a besoin, ou
 * l'état préparé ne porte pas l'élément facultatif qu'elle exige. Confondre ce cas avec
 * un FAIL accuserait à tort ; le confondre avec un PASS serait pire.
 *
 * D'où un troisième état, qui porte toujours sa raison, et qui ne se compte jamais comme
 * une réussite : une propriété **core** en SKIP donne le verdict INCOMPLET, et INCOMPLET
 * n'est pas une conformité.
 */

export class SkipSignal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipSignal";
  }
}

/** Déclare la propriété non vérifiable sur ce profil, avec sa raison. */
export function skip(reason: string): never {
  throw new SkipSignal(reason);
}
