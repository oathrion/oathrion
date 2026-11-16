/**
 * L'ADRESSE DE LA CONSOLE, après le `#` (11 novembre) : `useHashLocation` de wouter rend
 * « /share?t=…&to=… » en entier, comme chemin. Aucune route n'y répondait, et `useSearch` lisait
 * la vraie adresse, pas celle d'après le `#`. Ici, le chemin et la requête sont séparés.
 */
import { useHashLocation } from "wouter/use-hash-location";

/*
 * Naviguer (16 novembre) : le `navigate` de wouter 3.10 met la requête AVANT le `#`
 * (« console?wrong=1#/feedback »), que `useHashSearch` ne lit pas ; et elle y restait pour les
 * pages suivantes. « Tell us what happened » ouvrait la page sans son mode, et la carte de
 * `/decide` partait vers `/share` sans son jeton. Ici, tout reste après le `#`.
 */
export function navigateInHash(to: string, { state = null, replace = false }: { state?: unknown; replace?: boolean } = {}): void {
  const oldURL = location.href;
  const url = new URL(location.href);
  url.search = "";
  url.hash = `/${to.replace(/^#?\/?/, "")}`;
  history[replace ? "replaceState" : "pushState"](state, "", url.href);
  dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: url.href }));
}

export function useHashPath(): ReturnType<typeof useHashLocation> {
  const [location] = useHashLocation();
  const at = location.indexOf("?");
  return [at === -1 ? location : location.slice(0, at), navigateInHash] as ReturnType<typeof useHashLocation>;
}

export function useHashSearch(): string {
  const [location] = useHashLocation();
  const at = location.indexOf("?");
  return at === -1 ? "" : location.slice(at + 1);
}
