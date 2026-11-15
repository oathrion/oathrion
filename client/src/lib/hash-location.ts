/**
 * L'ADRESSE DE LA CONSOLE, après le `#` (11 novembre) : `useHashLocation` de wouter rend
 * « /share?t=…&to=… » en entier, comme chemin. Aucune route n'y répondait, et `useSearch` lisait
 * la vraie adresse, pas celle d'après le `#`. Ici, le chemin et la requête sont séparés.
 */
import { useHashLocation } from "wouter/use-hash-location";

export function useHashPath(): ReturnType<typeof useHashLocation> {
  const [location, navigate] = useHashLocation();
  const at = location.indexOf("?");
  return [at === -1 ? location : location.slice(0, at), navigate] as ReturnType<typeof useHashLocation>;
}

export function useHashSearch(): string {
  const [location] = useHashLocation();
  const at = location.indexOf("?");
  return at === -1 ? "" : location.slice(at + 1);
}
