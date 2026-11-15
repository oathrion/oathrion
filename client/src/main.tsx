import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/*
 * LE RETOUR D'UNE AUTORISATION SLACK OU LINEAR, DANS LA FENÊTRE SURGISSANTE.
 *
 * La session de la console vit en mémoire de l'onglet, jamais sur le disque. Envoyer
 * l'onglet chez Slack la détruirait : la personne reviendrait sur l'écran de connexion au
 * milieu du parcours. L'autorisation s'ouvre donc dans une fenêtre à part ; quand elle
 * revient ici, elle transmet le résultat à l'onglet qui l'a ouverte — même origine
 * seulement — puis se ferme. Sans `opener` (fenêtre surgissante bloquée), la page s'affiche
 * normalement et l'écran de démarrage lit le résultat dans l'adresse.
 */
const RETURN = /^#\/onboarding\?(.*connector=.*)$/.exec(window.location.hash);
if (RETURN && window.opener && window.opener !== window) {
  try {
    const params = Object.fromEntries(new URLSearchParams(RETURN[1]));
    (window.opener as Window).postMessage({ type: "placet-connector-return", ...params }, window.location.origin);
    window.close();
  } catch {
    /* L'ouvreur a changé d'origine : on laisse la page s'afficher. */
  }
}

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);
