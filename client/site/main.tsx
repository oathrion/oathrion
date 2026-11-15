/**
 * Le point d'entrée du site public.
 *
 * Volontairement séparé de `client/src/main.tsx` : la console et le site n'ont ni le même
 * public, ni les mêmes dépendances, ni la même durée de vie. Deux entrées Vite, deux
 * bundles — un visiteur ne télécharge pas la console pour lire une page, et un exploitant
 * ne télécharge pas le site pour approuver une action.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readCampaign } from "./lib/analytics";
import { configureTransport, redirectTransport, routedTransport } from "./lib/submit";

import "./styles.css";
import "./components/shell.css";
import "./components/flow.css";

/*
 * La classe `js` arme les apparitions.
 *
 * Elle est posée AVANT le premier rendu, et c'est l'ordre qui compte : `.reveal` est à
 * son état visible par défaut, et seul `.js .reveal` le met en retrait. Un lecteur sans
 * JavaScript, ou dont le script échoue, voit donc une page complète plutôt qu'une page
 * vide — l'inverse du motif habituel, où tout est à `opacity: 0` en attendant un
 * observateur qui ne viendra peut-être jamais.
 */
document.documentElement.classList.add("js");

/*
 * La campagne est lue au chargement, jamais l'identité.
 *
 * Aucun fournisseur d'analytique n'est branché : `configure()` n'est pas appelé, donc
 * rien ne quitte le navigateur. Les événements s'accumulent dans une file bornée et sont
 * oubliés. Pour brancher un fournisseur, une ligne ici — voir `lib/analytics.ts`.
 */
readCampaign(window.location.search, document.referrer);

/*
 * L'envoi des formulaires.
 *
 * Le défaut reste `mailto`, qui est un envoi RÉEL — il fonctionne sans domaine, sans
 * compte et sans base. Il a un défaut connu et sérieux : sur mobile il ouvre souvent une
 * application que la personne n'utilise pas, et l'inscription est perdue au moment précis
 * où elle arrive.
 *
 * Deux variables, posées au moment du build, suffisent à le remplacer — et chaque
 * formulaire part à SA destination :
 *
 *   VITE_PLACET_FORM_PILOT=https://…    les candidatures au pilote
 *   VITE_PLACET_FORM_WAITLIST=https://… les inscriptions à la liste d'attente
 *
 * Celle qui manque laisse son formulaire sur `mailto`. On ne remplace jamais un transport
 * qui fonctionne par un échec silencieux. Voir `lib/submit.ts` pour pourquoi aucun
 * endpoint public n'a été ajouté au plan de contrôle.
 */
const PILOT_ENDPOINT = import.meta.env.VITE_PLACET_FORM_PILOT as string | undefined;
const WAITLIST_ENDPOINT = import.meta.env.VITE_PLACET_FORM_WAITLIST as string | undefined;
/*
 * La liste d'attente part en SOUMISSION NATIVE, pas en `fetch`.
 *
 * Les collecteurs grand public n'autorisent pas l'origine appelante : un `fetch` verrait
 * sa reponse masquee, et annoncer un succes qu'on ne peut pas lire serait une fausse
 * soumission. Voir `redirectTransport` dans `lib/submit.ts`.
 *
 * La correspondance des champs est explicite : le collecteur nomme `email` ce que le
 * formulaire appelle `email`, et ignore le reste. Les champs facultatifs restent dans le
 * formulaire parce qu'ils renseignent la personne sur ce qu'on cherche a savoir, meme
 * quand le collecteur ne sait pas encore les stocker.
 */
if (PILOT_ENDPOINT || WAITLIST_ENDPOINT) {
  configureTransport(
    routedTransport({
      pilot: PILOT_ENDPOINT,
      waitlist: WAITLIST_ENDPOINT ? redirectTransport(WAITLIST_ENDPOINT, { email: "email" }) : undefined,
    }),
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from the document.");

createRoot(container).render(<App />);
