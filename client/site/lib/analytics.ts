/**
 * L'instrumentation du parcours d'acquisition — **une abstraction, pas un fournisseur**.
 *
 * ## Pourquoi aucun nom de fournisseur n'apparaît ici
 *
 * Le dépôt n'a aujourd'hui aucune infrastructure d'analytique : rien dans `client/`, rien
 * côté serveur. Brancher le site directement sur un fournisseur reviendrait à écrire son
 * SDK dans cinquante composants, et à devoir les rouvrir tous le jour où l'on en change —
 * ce qui arrive toujours, soit pour le coût, soit pour la conformité.
 *
 * Ce module est donc le seul endroit qui connaît un fournisseur. Les pages émettent des
 * événements nommés ; `configure()` décide où ils vont. Tant que rien n'est configuré,
 * les événements sont mis en file et **rien ne part** : pas de script tiers, pas de
 * cookie, pas de requête.
 *
 * ## Ce qui N'EST PAS collecté, par construction
 *
 * Aucune donnée personnelle ne transite par ici. Les événements portent un nom et des
 * propriétés **non identifiantes** — une page, un libellé de bouton, une source de
 * campagne. L'adresse e-mail d'un candidat au pilote voyage par le formulaire, vers le
 * serveur, et jamais par ce canal. C'est une contrainte de type : `EventProps` n'accepte
 * que des valeurs scalaires courtes, et `track` refuse une clé qui ressemble à un
 * identifiant personnel.
 */

export type EventProps = Record<string, string | number | boolean | null | undefined>;

/** Les étapes du parcours, nommées une fois pour que les pages ne les inventent pas. */
export const EVENTS = {
  pageView: "page_view",
  ctaClick: "cta_click",
  sectionView: "section_view",
  pilotFormStart: "pilot_form_start",
  pilotFormSubmit: "pilot_form_submit",
  pilotFormError: "pilot_form_error",
  waitlistStart: "waitlist_start",
  waitlistSubmit: "waitlist_submit",
  waitlistError: "waitlist_error",
  docsOpen: "docs_open",
  codeCopy: "code_copy",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Ce qu'un fournisseur doit savoir faire. Trois fonctions, rien de plus. */
export interface AnalyticsSink {
  pageView(path: string, props?: EventProps): void;
  track(event: EventName, props?: EventProps): void;
  /** Associe les événements suivants à une campagne. Jamais à une personne. */
  campaign(source: Campaign): void;
}

export interface Campaign {
  source?: string;
  medium?: string;
  campaign?: string;
  referrer?: string;
}

/*
 * Les clés refusées. Une propriété d'événement qui porte l'un de ces noms est une fuite
 * de donnée personnelle vers un tiers, et elle est écartée avant l'envoi plutôt que
 * confiée à la vigilance de chaque appelant.
 */
const FORBIDDEN_KEYS = /^(email|e_?mail|name|full_?name|phone|address|company_?name|ip|user_?id)$/i;
const MAX_VALUE_LENGTH = 120;

function scrub(props: EventProps | undefined): EventProps {
  if (!props) return {};
  const safe: EventProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
      safe[key] = value.slice(0, MAX_VALUE_LENGTH);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

let sink: AnalyticsSink | null = null;
let campaign: Campaign = {};

/** Les événements émis avant qu'un fournisseur soit configuré. Bornée, puis oubliée. */
const queue: Array<{ event: EventName; props: EventProps }> = [];
const QUEUE_MAX = 50;

/**
 * Branche un fournisseur. Appelée une fois, au démarrage, par du code qui connaît le
 * déploiement — jamais par une page.
 *
 * Rejoue la file : les événements du premier écran ne sont pas perdus parce que le
 * script du fournisseur a mis 400 ms à se charger.
 */
export function configure(next: AnalyticsSink): void {
  sink = next;
  if (Object.keys(campaign).length > 0) next.campaign(campaign);
  for (const queued of queue.splice(0, queue.length)) {
    next.track(queued.event, queued.props);
  }
}

/** Lit la campagne depuis l'URL. Les paramètres `utm_*` sont la convention universelle. */
export function readCampaign(search: string, referrer: string): Campaign {
  const params = new URLSearchParams(search);
  const read = (key: string) => params.get(key) ?? undefined;
  const found: Campaign = {
    source: read("utm_source") ?? read("ref") ?? undefined,
    medium: read("utm_medium"),
    campaign: read("utm_campaign"),
    /*
     * Seulement l'origine du référent, jamais le chemin complet : une URL de référence
     * peut porter un identifiant de session ou un terme de recherche, et nous n'en avons
     * pas besoin pour savoir d'où viennent les visiteurs.
     */
    referrer: referrer ? safeOrigin(referrer) : undefined,
  };
  campaign = found;
  if (sink) sink.campaign(found);
  return found;
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function track(event: EventName, props?: EventProps): void {
  const safe = { ...scrub(props), ...scrub(campaign as EventProps) };
  if (!sink) {
    if (queue.length < QUEUE_MAX) queue.push({ event, props: safe });
    return;
  }
  sink.track(event, safe);
}

export function pageView(path: string, props?: EventProps): void {
  const safe = { ...scrub(props), ...scrub(campaign as EventProps) };
  if (!sink) {
    if (queue.length < QUEUE_MAX) queue.push({ event: EVENTS.pageView, props: { path, ...safe } });
    return;
  }
  sink.pageView(path, safe);
}

/**
 * Un fournisseur de développement qui écrit dans la console.
 *
 * Exporté et **non branché par défaut** : une page qui enverrait des événements quelque
 * part sans que personne l'ait décidé est exactement ce que ce module évite. Pour le
 * brancher : `configure(consoleSink)` dans `main.tsx`.
 */
export const consoleSink: AnalyticsSink = {
  pageView(path, props) {
    // eslint-disable-next-line no-console -- c'est la raison d'être de ce puits
    console.info("[analytics] page", path, props);
  },
  track(event, props) {
    // eslint-disable-next-line no-console -- idem
    console.info("[analytics]", event, props);
  },
  campaign(source) {
    // eslint-disable-next-line no-console -- idem
    console.info("[analytics] campaign", source);
  },
};
