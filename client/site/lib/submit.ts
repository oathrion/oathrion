/**
 * L'envoi des candidatures et des inscriptions — **une abstraction, et un transport réel
 * par défaut**.
 *
 * ## L'état du dépôt, constaté avant d'écrire une ligne
 *
 * Il n'existe aucune route publique d'écriture. Tout `/api/*` est fermé par
 * `authenticate()`, et c'est la bonne posture pour un plan de contrôle. Il n'existe pas
 * non plus de table pour des prospects.
 *
 * ## Pourquoi je n'ajoute PAS d'endpoint public au plan de contrôle
 *
 * C'était l'option évidente et c'est la mauvaise. Elle demanderait :
 *
 *   - une surface d'écriture **non authentifiée** sur le produit dont l'argument de vente
 *     est le refus par défaut ;
 *   - une migration pour stocker des données personnelles — dans un produit dont
 *     `docs/limitations.md` dit noir sur blanc qu'il **n'a pas d'effacement** ;
 *   - une protection anti-abus sur un chemin que personne ne surveille.
 *
 * Une candidature au pilote n'est pas une donnée de plan de contrôle. La mettre dans la
 * même base parce que la base est là serait un raccourci qu'on paierait au premier audit.
 *
 * ## Ce qui est donc livré
 *
 * Un contrat (`FormTransport`) et **deux transports réels** :
 *
 *   - `mailtoTransport` — par défaut. Ouvre le client de messagerie avec un message
 *     entièrement rédigé. Ce n'est pas une fausse soumission : le message part vraiment,
 *     et il arrive vraiment. Il fonctionne aujourd'hui, sans domaine, sans compte, sans
 *     base de données, et sans stocker la moindre donnée personnelle chez nous.
 *   - `httpTransport(url)` — à brancher le jour où un point de collecte existe
 *     (fonction serverless, service de formulaire, ou une route dédiée hors du plan de
 *     contrôle). Une ligne dans `main.tsx`, et aucune page ne change.
 *
 * `configureTransport()` est le seul endroit qui décide. Les pages appellent `submit()`
 * et ne connaissent ni l'un ni l'autre.
 */

export interface PilotApplication {
  kind: "pilot";
  name: string;
  email: string;
  company: string;
  role: string;
  country: string;
  building: string;
  workflow: string;
  agents: string;
  problem: string;
  wants: string;
}

export interface WaitlistSignup {
  kind: "waitlist";
  email: string;
  name: string;
  country: string;
  role: string;
  useCase: string;
}

export type Submission = PilotApplication | WaitlistSignup;

export type TransportName = "mailto" | "http" | "redirect";

export type SubmitOutcome =
  | { ok: true; via: TransportName; reference?: string }
  | { ok: false; reason: string; retryable: boolean };

export interface FormTransport {
  readonly name: TransportName;
  send(submission: Submission): Promise<SubmitOutcome>;
  /** Facultatif : le nom réel pour UN type, quand le transport route par type. */
  kindName?(kind: Submission["kind"]): TransportName;
}

/** L'adresse qui reçoit les candidatures tant qu'aucun point de collecte n'existe. */
export const CONTACT_EMAIL = "contact@oathrion.com";

/* ------------------------------------------------------------------ mailto */

const LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  company: "Company",
  role: "Role",
  country: "Country",
  building: "What are you building",
  workflow: "Current AI-agent workflow",
  agents: "Number of agents",
  problem: "Biggest governance problem",
  wants: "What you want Oathrion to solve",
  useCase: "Use case",
};

const ORDER: Record<Submission["kind"], string[]> = {
  pilot: ["name", "email", "company", "role", "country", "building", "workflow", "agents", "problem", "wants"],
  waitlist: ["email", "name", "country", "role", "useCase"],
};

function compose(submission: Submission): { subject: string; body: string } {
  const record = submission as unknown as Record<string, string>;
  const lines = ORDER[submission.kind]
    .map((key) => `${LABELS[key] ?? key}: ${(record[key] ?? "").trim()}`)
    .join("\n");

  return submission.kind === "pilot"
    ? {
        subject: `Founding Pilot application — ${record.company || record.name || "Oathrion"}`,
        /*
         * Le corps est déjà rempli à partir du formulaire : la personne a saisi dans une
         * belle interface, et le client de messagerie ne sert plus qu'à appuyer sur
         * « envoyer ». C'est ce qui distingue ce transport d'un simple lien `mailto`.
         */
        body: `Founding Pilot application\n\n${lines}\n`,
      }
    : {
        subject: `Waitlist — Oathrion`,
        body: `${lines}\n`,
      };
}

export const mailtoTransport: FormTransport = {
  name: "mailto",
  async send(submission) {
    const { subject, body } = compose(submission);
    const href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    /*
     * `location.href` plutôt qu'un `window.open` : un `mailto` n'ouvre pas de fenêtre, et
     * un `open` bloqué par le navigateur rendrait un succès là où rien n'a eu lieu.
     */
    if (typeof window === "undefined") {
      return { ok: false, reason: "No browser available to open a mail client.", retryable: false };
    }
    window.location.href = href;
    return { ok: true, via: "mailto" };
  },
};

/* -------------------------------------------------------------------- http */

/**
 * Le transport à brancher quand un point de collecte existe.
 *
 * Attend un `2xx`. Tout le reste est une erreur **nommée** : un formulaire qui dit
 * « quelque chose s'est mal passé » fait recommencer la personne à l'identique, et elle
 * échoue à l'identique.
 */
export function httpTransport(endpoint: string): FormTransport {
  return {
    name: "http",
    async send(submission) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submission),
        });
        if (response.status === 429) {
          return { ok: false, reason: "Too many submissions from here. Try again in a few minutes.", retryable: true };
        }
        if (!response.ok) {
          return {
            ok: false,
            reason: `The server refused the submission (HTTP ${response.status}).`,
            retryable: response.status >= 500,
          };
        }
        const payload = (await response.json().catch(() => ({}))) as { reference?: string };
        return { ok: true, via: "http", reference: payload.reference };
      } catch {
        return { ok: false, reason: "Could not reach the server. Check your connection.", retryable: true };
      }
    },
  };
}

/* ------------------------------------------------------------------ routage */

/**
 * Un transport par type d'envoi, et c'est volontaire.
 *
 * Une candidature au pilote et une inscription à la liste d'attente ne sont pas la même
 * chose, et ne doivent pas atterrir au même endroit. La première est une **conversation**
 * : dix réponses à lire, une décision à rendre, un refus à écrire avec respect. La
 * seconde est un **abonnement** : une adresse à garder dix-huit mois, puis un message, et
 * un désabonnement qui doit fonctionner.
 *
 * Les confondre coûte deux fois. Une boîte de réception ne sait pas envoyer à deux mille
 * personnes sans finir en indésirable ; et un outil d'envoi en nombre est un mauvais
 * endroit pour instruire cinq dossiers.
 *
 * Un type sans point de collecte retombe sur `mailto`, qui reste un envoi réel — on ne
 * remplace jamais un transport qui fonctionne par un échec silencieux.
 */
export function routedTransport(
  routes: Partial<Record<Submission["kind"], string | FormTransport>>,
): FormTransport {
  const built = new Map<string, FormTransport>();
  for (const [kind, route] of Object.entries(routes)) {
    if (!route) continue;
    // Une chaine est une URL JSON ; un transport deja construit passe tel quel. Les deux
    // coexistent parce que les deux formulaires n'ont pas le meme destinataire.
    built.set(kind, typeof route === "string" ? httpTransport(route) : route);
  }
  return {
    name: "http",
    kindName: (kind) => built.get(kind)?.name ?? "mailto",
    async send(submission) {
      return (built.get(submission.kind) ?? mailtoTransport).send(submission);
    },
  };
}

/* ---------------------------------------------------------------- redirect */

/**
 * La soumission de formulaire NATIVE, et pourquoi elle existe à côté de `httpTransport`.
 *
 * ## Le problème qu'elle résout
 *
 * Les points de collecte grand public — Buttondown, Mailchimp, Substack — exposent un
 * `embed-subscribe` conçu pour être la cible d'un `<form method="post">`, pas d'un
 * `fetch`. Ils n'autorisent pas l'origine appelante, donc le navigateur masque la
 * réponse : `httpTransport` ne verrait ni le code ni le corps.
 *
 * On pourrait appeler en `mode: "no-cors"`, qui ne lève pas d'erreur — et c'est
 * exactement le piège. On afficherait « vous êtes inscrit » sans aucun moyen de savoir si
 * quoi que ce soit a été enregistré. C'est la **fausse soumission** que ce site s'interdit
 * ailleurs, et la pire des trois options : le visiteur part content, et personne n'a son
 * adresse.
 *
 * ## Ce qu'elle fait à la place
 *
 * Elle construit un formulaire, le remplit, et le soumet comme le ferait un bouton HTML.
 * Le navigateur quitte la page et atterrit sur la confirmation du collecteur. Rien n'est
 * inventé : la personne VOIT où son inscription est arrivée.
 *
 * Le prix est réel — le visiteur sort du site. Il est assumé : une inscription perdue
 * coûte plus cher qu'une page de confirmation qui n'est pas la nôtre.
 */
export function redirectTransport(endpoint: string, fieldMap: Record<string, string>): FormTransport {
  return {
    name: "redirect",
    async send(submission) {
      if (typeof document === "undefined") {
        return { ok: false, reason: "No browser available to submit the form.", retryable: false };
      }
      const record = submission as unknown as Record<string, string>;
      const form = document.createElement("form");
      form.method = "post";
      form.action = endpoint;
      /*
       * Hors écran plutôt que `display: none` : un formulaire masqué par `display` est
       * refusé à la soumission par certains navigateurs.
       */
      form.style.position = "fixed";
      form.style.left = "-9999px";

      for (const [ours, theirs] of Object.entries(fieldMap)) {
        const value = (record[ours] ?? "").trim();
        if (!value) continue;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = theirs;
        input.value = value;
        form.appendChild(input);
      }

      document.body.appendChild(form);
      form.submit();
      // La page s'en va : cette valeur n'est jamais lue, mais le contrat l'exige.
      return { ok: true, via: "redirect" };
    },
  };
}

/* --------------------------------------------------------------- selection */

let transport: FormTransport = mailtoTransport;

/** Branche un transport. Appelée une fois, au démarrage, jamais par une page. */
export function configureTransport(next: FormTransport): void {
  transport = next;
}

/**
 * Le nom du transport qui servira POUR CE TYPE d'envoi.
 *
 * Les pages s'en servent pour écrire la vérité sous le bouton — « ouvre votre client de
 * messagerie » ou « nous répondons à chaque candidature ». Sans le type, une page
 * annoncerait le comportement de l'autre dès que les deux ne sont pas branchés de la
 * même façon : exactement le genre de petit mensonge d'interface que ce produit refuse
 * ailleurs.
 */
export function activeTransport(kind?: Submission["kind"]): FormTransport["name"] {
  if (kind && transport.kindName) return transport.kindName(kind);
  return transport.name;
}

export async function submit(submission: Submission): Promise<SubmitOutcome> {
  return transport.send(submission);
}

/* ------------------------------------------------------------- validation */

export type Errors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * La validation, côté client, et ce qu'elle vaut.
 *
 * Elle existe pour **épargner un aller-retour à une personne de bonne foi**, pas pour
 * protéger quoi que ce soit : tout ce qui est vérifié ici est contournable. Le jour où un
 * point de collecte existe, il revalide tout, et c'est sa validation qui décide.
 */
export function validate(values: Record<string, string>, required: string[]): Errors {
  const errors: Errors = {};
  for (const key of required) {
    if (!(values[key] ?? "").trim()) errors[key] = "Required.";
  }
  if (values.email && !EMAIL.test(values.email.trim())) {
    errors.email = "That does not look like an email address.";
  }
  /*
   * Le piège à robots : un champ que personne ne voit et qu'un script remplit. Rempli,
   * la soumission est acceptée en apparence et jetée — un robot qui reçoit une erreur
   * réessaie en s'adaptant, un robot qui reçoit un succès s'en va.
   */
  return errors;
}

export function isTrap(values: Record<string, string>): boolean {
  return (values.website ?? "").trim() !== "";
}
