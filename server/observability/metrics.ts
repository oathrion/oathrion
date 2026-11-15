/**
 * Le registre de métriques : **déclaré**, borné par construction, sans dépendance.
 *
 * ## Pourquoi un registre écrit à la main plutôt que `prom-client`
 *
 * Deux raisons, et aucune n'est le goût du sur-mesure. La première est le format : la
 * sortie texte de Prometheus tient en quarante lignes, et une dépendance de plus sur le
 * chemin d'un déploiement d'entreprise se paie en revue de licence et en surface de
 * mise à jour. La seconde est la contrainte qui suit, que `prom-client` ne sait pas
 * exprimer.
 *
 * ## LA CONTRAINTE : les valeurs d'étiquette sont DÉCLARÉES
 *
 * Une métrique étiquetée par une valeur non bornée est la panne classique de la
 * supervision : chaque valeur nouvelle crée une série, et la mémoire du collecteur
 * croît avec le trafic jusqu'à le tuer. Oathrion est multi-locataire et ses identifiants
 * de locataire sont opaques et illimités — c'est exactement la forme du piège.
 *
 * Ici, chaque métrique déclare ses étiquettes **et l'ensemble fini de leurs valeurs**.
 * Le nombre de séries est donc connu à la compilation, et une valeur hors liste ne peut
 * pas créer de série : elle est rangée dans `other` et comptée dans
 * `oathrion_metric_label_violations_total`. Ce choix mérite d'être justifié dans les deux
 * sens :
 *
 *   - **ne pas lever d'exception**, parce que ce code tourne sur le chemin d'une
 *     requête client. Faire échouer un remboursement pour une étiquette mal écrite
 *     serait un remède pire que le mal : la supervision ne doit jamais pouvoir faire
 *     tomber ce qu'elle observe ;
 *   - **ne pas ignorer en silence**, parce qu'un compteur qui perd des événements sans
 *     le dire est précisément le genre de mesure qui rassure à tort. La violation est
 *     elle-même une métrique, donc visible depuis le tableau de bord, et
 *     `server/test/metrics-registry.test.ts` exige qu'elle reste à zéro sur la suite
 *     complète.
 *
 * ## CE QUI N'ENTRE PAS DANS CE REGISTRE : le locataire
 *
 * Aucune série ne porte d'identifiant d'organisation, et ce n'est pas un oubli. Deux
 * raisons distinctes, qui pointent dans le même sens :
 *
 *   1. la cardinalité, ci-dessus ;
 *   2. la divulgation. `/api/metrics` est lue par la supervision de l'exploitant. Une
 *      étiquette par locataire y livrerait la liste de ses clients, et leur volume
 *      d'affaires, à quiconque peut lire un tableau de bord. La migration 18 a rendu
 *      les identifiants opaques précisément pour que le nom d'une entreprise ne
 *      transite pas ; les réintroduire ici par une étiquette annulerait ce travail.
 *
 * Les chiffres **par locataire** existent déjà et ne sont pas refaits ici : `GET
 * /api/usage` sert les compteurs de quota de l'organisation du porteur, et `GET
 * /api/actions/receipts/verify` son verdict de chaîne. Les deux sont cadrés par le
 * credential présenté. Ajouter une vue par locataire sur `/api/metrics` aurait créé un
 * SECOND chemin vers les mêmes nombres — exactement ce que le dépôt refuse ailleurs,
 * parce que deux lecteurs d'une même vérité finissent par ne plus dire la même chose.
 * `docs/ON-CALL.md` pointe donc vers les routes existantes pour la question « ce
 * client », et vers celle-ci pour la question « ce déploiement ».
 *
 * ## Ce que ce module ne fait pas
 *
 * Aucun histogramme, donc aucun quantile de latence. Un histogramme utile exige des
 * tranches (`buckets`) choisies d'après une distribution réelle ; celles d'Oathrion ne sont
 * pas mesurées sur une charge d'entreprise — le plan d'identité passe par un pont
 * synchrone qui plafonne l'instance autour de 90–190 req/s, et c'est le chiffre qui
 * compte avant une latence de queue. Des tranches inventées produiraient des quantiles
 * d'allure crédible et sans fondement. Compteurs et jauges, donc, et le dire.
 */

/** Une valeur d'étiquette hors de l'ensemble déclaré est rangée ici. */
import { monitorEventLoopDelay } from "node:perf_hooks";

export const OTHER = "other";

interface MetricDefinition {
  readonly help: string;
  /** Les étiquettes, dans l'ordre de rendu, avec l'ensemble FINI de leurs valeurs. */
  readonly labels?: Readonly<Record<string, readonly string[]>>;
}

/**
 * LA LISTE. Un seul endroit où un nom de métrique existe.
 *
 * `server/test/metrics-single-path.test.ts` interdit qu'un nom `oathrion_…` apparaisse
 * ailleurs que dans ce tableau : une métrique définie en deux endroits est une
 * métrique dont la signification dépend du chemin qui l'incrémente.
 */
export const COUNTERS = {
  oathrion_action_decisions_total: {
    help: "Authorization decisions made, by verdict.",
    labels: { decision: ["allow", "block", "approval_required", OTHER] },
  },
  oathrion_action_executions_total: {
    help: "Grant presentations at execution time, by outcome. `refused` reaches no tool.",
    labels: { outcome: ["succeeded", "failed", "refused", OTHER] },
  },
  /*
   * LE TRAFIC QUE LE PARE-FEU REFUSE AVANT TOUTE DÉCISION.
   *
   * Une requête qu'aucune règle d'interception ne reconnaît n'atteint pas le moteur,
   * donc elle ne produit AUCUNE exécution — et la piste d'audit de ce produit est
   * dérivée des exécutions. Ce trafic serait donc invisible, et un exploitant qui lit
   * « 0 bloqué » dans la console ne saurait pas distinguer « rien de dangereux » de
   * « des requêtes sont refusées à la porte et personne ne les compte ».
   *
   * Un compteur plutôt qu'une ligne d'audit : il n'y a pas de décision à tracer — il n'y
   * a pas de verbe à juger. Fabriquer une exécution pour l'occasion inventerait une
   * décision que le moteur n'a pas rendue. `docs/firewall.md` dit cette limite : ce
   * trafic est COMPTÉ, pas tracé individuellement.
   */
  oathrion_intercept_refusals_total: {
    help: "Requests refused by the proxy before any decision, by reason.",
    labels: {
      reason: [
        "no_rule",
        "destination_mismatch",
        "destination_unavailable",
        "unreadable_request",
        "overloaded",
        "gateway_failed",
        "quota_exceeded",
        OTHER,
      ],
    },
  },
  oathrion_feedback_total: {
    help: "Product feedback submitted, by category.",
    labels: {
      category: [
        "experience", "bug", "missing_feature", "wrong_result",
        "performance", "security", "suggestion", OTHER,
      ],
    },
  },
  /*
   * DEUX métriques et non une étiquette `code` sur la précédente, et c'est un choix
   * mesuré. Croiser quatre issues avec onze codes produit 44 séries dont 33 sont
   * IMPOSSIBLES — `succeeded` avec `grant_expired` n'arrivera jamais. Un registre qui
   * émet à perpétuité des séries à zéro qui ne peuvent pas bouger encombre le
   * collecteur et, pire, laisse croire sur un tableau de bord qu'une combinaison est
   * surveillée alors qu'elle n'a pas de sens. Deux noms, chacun une seule chose.
   */
  oathrion_action_refusals_total: {
    help: "Refusals when a grant is presented, by code. The closed enumeration of `RefusalCode`.",
    labels: {
      /*
       * Borné par l'énumération du point d'application, en minuscules. C'est ce qui
       * rend la métrique utile à 3 h du matin : un flot d'`agent_mismatch` et un flot
       * de `grant_expired` ne se diagnostiquent pas du tout pareil — le premier est une
       * intégration qui présente le grant d'un autre agent, le second une horloge ou un
       * TTL trop court.
       */
      code: [
        "grant_not_found",
        "grant_not_issued",
        "grant_expired",
        "grant_already_consumed",
        "agent_mismatch",
        "action_mismatch",
        "destination_mismatch",
        "decision_not_executable",
        "destination_unknown",
        "race_lost",
        OTHER,
      ],
    },
  },
  oathrion_downstream_calls_total: {
    help: "Calls dispatched to a downstream tool, by outcome. `transport_error` = no usable response.",
    labels: { outcome: ["ok", "business_error", "transport_error", OTHER] },
  },
  oathrion_rate_limit_outcomes_total: {
    help: "Passes through the rate limiter. `store_unavailable` reports an unreachable store.",
    labels: {
      scope: ["decision", "write", "approval", OTHER],
      outcome: ["allowed", "rejected", "store_unavailable", OTHER],
    },
  },
  oathrion_auth_failures_total: {
    help: "Credential presentations refused, by reason. The reasons are the ones the server CAN tell apart.",
    labels: {
      /*
       * Exactement ce que le code sait distinguer, et rien de plus.
       *
       * Le premier jet listait `expired`, `revoked` et `unknown_key` séparément — ce qui
       * aurait été une métrique INVENTÉE : `resolveBearer` rend `null` pour les trois
       * sans dire laquelle, délibérément, pour que la réponse HTTP ne devienne pas un
       * oracle sur l'existence d'un credential. Trois séries dont deux resteraient
       * éternellement à zéro auraient fait lire « aucune clé révoquée n'a été présentée »
       * là où la vérité est « on ne mesure pas ça ». Les motifs de connexion, eux, sont
       * réellement distingués par `login()`, et ils figurent donc.
       */
      reason: [
        "missing_credential",
        "invalid_credential",
        "login_invalid_credentials",
        "login_account_suspended",
        "login_no_active_organization",
        "login_ambiguous_organization",
        "login_throttled",
        "missing_console_header",
        OTHER,
      ],
    },
  },
  oathrion_receipt_chain_verifications_total: {
    help: "Receipt chain verifications requested, by verdict. `broken` must wake someone up.",
    labels: { result: ["ok", "broken", OTHER] },
  },
  oathrion_http_responses_total: {
    help: "HTTP responses, by surface and status class. No URL path: cardinality is bounded.",
    labels: {
      surface: ["probe", "auth", "actions", "console", "mcp", OTHER],
      class: ["2xx", "3xx", "4xx", "5xx", OTHER],
    },
  },
  oathrion_admission_shed_total: {
    help: "Requests refused immediately (503 overloaded) because the instance had reached OATHRION_MAX_IN_FLIGHT requests in flight, by surface.",
    labels: { surface: ["auth", "actions", "console", "mcp", OTHER] },
  },
  oathrion_metric_label_violations_total: {
    help: "Label values outside the declared set, filed under `other`. Must stay at zero.",
    labels: { metric: [OTHER] },
  },
} as const satisfies Record<string, MetricDefinition>;

export type CounterName = keyof typeof COUNTERS;

/* ------------------------------- état interne ------------------------------ */

/** `nom{étiquette="valeur",…}` → compte. Le nombre de clés est borné par COUNTERS. */
const counts = new Map<string, number>();

/*
 * L'histogramme du retard de boucle, démarré à l'import et jamais arrêté.
 *
 * `resolution: 10` ms : assez fin pour voir un blocage qui compte — en dessous de dix
 * millisecondes, un retard n'est pas ce qui fait attendre une requête — et assez grossier
 * pour que l'échantillonnage ne coûte rien. Le runtime le remplit lui-même, hors
 * JavaScript, donc il ne peut pas être retardé par ce qu'il mesure.
 */
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

/** La dernière issue observée du magasin de quotas, pour la jauge correspondante. */
let rateLimitStoreReachable = true;

function labelKey(name: string, labels: Record<string, string>): string {
  const definition = COUNTERS[name as CounterName];
  const declared = (definition.labels ?? {}) as Record<string, readonly string[]>;
  const parts: string[] = [];
  let violated = false;

  // Rendu dans l'ordre de DÉCLARATION et non d'appel : deux appels qui nomment les
  // mêmes étiquettes dans un ordre différent doivent toucher la même série.
  for (const label of Object.keys(declared)) {
    const raw = labels[label] ?? OTHER;
    const allowed = declared[label] ?? [];
    const value = allowed.includes(raw) ? raw : OTHER;
    if (value !== raw) violated = true;
    parts.push(`${label}="${value}"`);
  }

  if (violated && name !== "oathrion_metric_label_violations_total") {
    // Récursion impossible : la métrique de violation n'a qu'une valeur déclarée.
    increment("oathrion_metric_label_violations_total", { metric: OTHER });
  }
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
}

/** Incrémente un compteur déclaré. Ne lève jamais : la mesure ne casse pas le mesuré. */
export function increment(name: CounterName, labels: Record<string, string> = {}, by = 1): void {
  const key = labelKey(name, labels);
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/** Enregistre l'accessibilité du magasin de quotas, lue par la jauge. */
export function noteRateLimitStore(reachable: boolean): void {
  rateLimitStoreReachable = reachable;
}

/** Seam de test : remet le registre à zéro. Jamais appelé par le serveur. */
export function resetMetrics(): void {
  counts.clear();
  rateLimitStoreReachable = true;
}

/** Lecture d'un compteur, pour les tests et pour les bancs de vérification. */
export function readCounter(name: CounterName, labels: Record<string, string> = {}): number {
  return counts.get(labelKey(name, labels)) ?? 0;
}

/* --------------------------------- rendu ---------------------------------- */

/** Ce que l'appelant fournit au rendu : des faits que le registre ne connaît pas. */
export interface DeploymentState {
  /** `/api/ready` répondrait-elle 200 ? */
  ready: boolean;
  databaseReachable: boolean;
  /** Le processus est-il en train de se vider (arrêt gracieux) ? */
  draining: boolean;
  /** `closed` est la posture par défaut, et la seule qui ne devienne pas un contournement. */
  rateLimitFailClosed: boolean;
}

function gauge(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`];
}

/**
 * Le rendu au format texte de Prometheus, à l'échelle du DÉPLOIEMENT.
 *
 * Toutes les séries déclarées sont émises, y compris à zéro. Une série absente tant
 * qu'elle n'a pas eu lieu oblige chaque alerte à distinguer « pas d'événement » de
 * « pas d'instrumentation », et c'est la différence entre une alerte qui se déclenche
 * et une alerte qui n'existe pas : `absent()` et `== 0` ne sont pas la même requête.
 */
export function renderDeploymentMetrics(state: DeploymentState): string {
  const lines: string[] = [];

  lines.push(...gauge("oathrion_up", "1 if the process responds. Always 1 when this page is served.", 1));
  lines.push(...gauge("oathrion_ready", "1 if this instance should receive traffic (database reachable and not draining).", state.ready ? 1 : 0));
  lines.push(...gauge("oathrion_database_reachable", "1 if PostgreSQL responds.", state.databaseReachable ? 1 : 0));
  lines.push(...gauge("oathrion_draining", "1 during a graceful shutdown. Expected during a deployment, never otherwise.", state.draining ? 1 : 0));
  /*
   * « DERNIER passage », et la nuance est opérationnelle, pas rédactionnelle : cette
   * jauge ne sonde rien. Elle rapporte ce que le limiteur a constaté la dernière fois
   * qu'une requête l'a traversé. Un déploiement sans trafic garde donc la dernière
   * valeur observée, et `/api/metrics` elle-même ne la rafraîchit pas — la page de
   * métriques est une sonde et ne passe pas par le limiteur. Une alerte doit donc la
   * croiser avec `oathrion_rate_limit_outcomes_total`, et `docs/ON-CALL.md` le dit.
   *
   * L'alternative — sonder le magasin à chaque scrape — a été écartée : elle ferait de
   * la supervision une charge sur le composant qu'elle observe, et une panne du magasin
   * deviendrait une panne de la page qui sert à la voir.
   */
  lines.push(...gauge("oathrion_rate_limit_store_reachable", "0 if the LAST pass through the limiter could not reach its store. Probes nothing: without traffic, the value does not change.", rateLimitStoreReachable ? 1 : 0));
  lines.push(...gauge("oathrion_rate_limit_fail_closed", "1 if an unreachable store refuses the request. 0 = an infrastructure incident removes the brute-force protection.", state.rateLimitFailClosed ? 1 : 0));
  lines.push(...gauge("oathrion_uptime_seconds", "Seconds since the process started. A value that resets = restart loop.", Math.floor(process.uptime())));

  /*
   * ───────────── LE RETARD DE LA BOUCLE D'ÉVÉNEMENTS ─────────────
   *
   * La seule mesure qui distingue « le serveur est chargé » de « le serveur est BLOQUÉ ».
   *
   * Un processus Node saturé de travail asynchrone garde un retard de boucle faible : il
   * passe d'une tâche à l'autre. Un processus qui fait des entrées-sorties SYNCHRONES voit
   * ce retard égaler la durée de ces appels — et pendant ce temps il ne peut rien
   * chevaucher, pas même répondre à une sonde de vie.
   *
   * Le banc de charge mesure l'attente depuis l'EXTÉRIEUR (`/api/live` sous charge) ; cette
   * jauge dit depuis l'intérieur si cette attente est une file de tâches ou un blocage.
   * Les deux ensemble attribuent la cause, ce que ni l'un ni l'autre ne fait seul.
   *
   * `monitorEventLoopDelay` est un histogramme de la bibliothèque standard, échantillonné
   * par le runtime lui-même : il ne coûte pas un timer en JavaScript, et il ne peut donc
   * pas se faire retarder par ce qu'il mesure.
   */
  lines.push(
    ...gauge(
      "oathrion_event_loop_delay_p50_ms",
      "Median event loop delay. A high delay = synchronous work is holding the loop, and no request can be interleaved meanwhile.",
      Math.round(eventLoopDelay.percentile(50) / 1e6),
    ),
    ...gauge(
      "oathrion_event_loop_delay_p99_ms",
      "99th percentile of event loop delay. It is the longest stall a trivial request suffers.",
      Math.round(eventLoopDelay.percentile(99) / 1e6),
    ),
    ...gauge(
      "oathrion_event_loop_delay_max_ms",
      "The longest delay observed since startup. Never resets: a single spike stays visible.",
      Math.round(eventLoopDelay.max / 1e6),
    ),
  );

  for (const [name, definition] of Object.entries(COUNTERS) as Array<[CounterName, MetricDefinition]>) {
    lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} counter`);
    for (const combination of combinations(definition.labels)) {
      const key = labelKey(name, combination);
      lines.push(`${key} ${counts.get(key) ?? 0}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Le produit cartésien des valeurs déclarées : l'ensemble exact des séries possibles. */
function combinations(
  labels: Readonly<Record<string, readonly string[]>> | undefined,
): Array<Record<string, string>> {
  if (labels === undefined) return [{}];
  let rows: Array<Record<string, string>> = [{}];
  for (const [label, values] of Object.entries(labels)) {
    const next: Array<Record<string, string>> = [];
    for (const row of rows) for (const value of values) next.push({ ...row, [label]: value });
    rows = next;
  }
  return rows;
}

/** Le nombre exact de séries que ce registre peut produire. Connu à la compilation. */
export function seriesCount(): number {
  return Object.values(COUNTERS).reduce(
    (total, definition) => total + combinations((definition as MetricDefinition).labels).length,
    0,
  );
}
