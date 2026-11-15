/**
 * Le contrat du kit de conformité — § 4 de SPEC.md.
 *
 * Deux idées gouvernent ce fichier, et elles expliquent sa petitesse.
 *
 * 1. **Le kit appelle lui-même.** Il ne délègue aucune requête jugée à du code fourni
 *    par l'implémenteur. Un driver qui lirait les réponses à la place du kit pourrait
 *    blanchir une violation, et le kit jugerait alors le driver.
 *
 * 2. **Le driver fournit un ÉTAT, pas des opérations.** Comment cet état est fabriqué —
 *    API, SQL, configuration, script — ne regarde pas le kit. Chaque opération qu'on
 *    ajouterait ici serait une barrière de plus pour quiconque veut se conformer.
 *
 * Il reste donc exactement une opération, et sa justification est dans SPEC.md § 4.2 :
 * aucune réponse HTTP ne prouve qu'une action n'a PAS atteint l'outil.
 */

/** Un credential et l'agent auquel il est lié, du point de vue du kit. */
export interface Principal {
  /** La valeur du jeton, telle qu'elle part en `Authorization: Bearer …`. */
  readonly token: string;
  /** L'identifiant d'agent que ce credential porte, ou `null` pour un humain. */
  readonly agentId: string | null;
}

/** Ce qu'une organisation doit offrir au kit pour être jugeable. */
export interface TenantState {
  readonly agent: Principal;
  /** Un second agent de la MÊME organisation — C12, C16. */
  readonly agent2: Principal;
  /** Peut lire, approuver et rejeter dans son organisation — jamais dans l'autre. */
  readonly admin: Principal;
  readonly destination: string;
}

export interface PreparedState {
  readonly a: TenantState;
  readonly b: TenantState;
  /** Un verbe autorisé sous plafond et retenu au-dessus. */
  readonly allowVerb: string;
  /** Un verbe qu'aucune règle n'autorise jamais. */
  readonly blockVerb: string;
  readonly belowCeiling: number;
  readonly aboveCeiling: number;
  readonly currency: string;
}

export interface Driver {
  readonly name: string;
  /** L'origine HTTP que le kit interroge. */
  readonly baseUrl: string;
  readonly state: PreparedState;
  /**
   * O1 — le nombre de livraisons effectuées vers cette destination depuis le début.
   *
   * La SEULE opération du driver. Le kit n'en lit jamais la valeur absolue : il
   * compare deux relevés autour d'une étape (`Δ` dans SPEC.md).
   */
  deliveries(destination: string): Promise<number>;
  close(): Promise<void>;
}

export type Status = "PASS" | "FAIL" | "SKIP" | "NOT_IMPLEMENTED";
export type Level = "core" | "extended";

export interface PropertyResult {
  readonly id: string;
  readonly level: Level;
  readonly title: string;
  readonly status: Status;
  /** Ce qui a été observé : statuts, codes, Δ. Lisible sans ouvrir le code. */
  readonly detail: string;
  /** Obligatoire pour un SKIP. */
  readonly reason?: string;
}

/**
 * Une propriété. `run` lève pour signaler un échec : le runner traduit l'exception en
 * FAIL, ce qui évite à chaque propriété de porter son propre `try`.
 *
 * `needs` nomme les propriétés dont celle-ci dépend (§ 1.5) : si l'une est FAIL, celle-ci
 * est SKIP plutôt que de tomber en même temps, pour qu'une violation reste imputable à
 * une seule propriété.
 */
export interface Property {
  readonly id: string;
  readonly level: Level;
  readonly title: string;
  readonly needs?: readonly string[];
  run(ctx: Context): Promise<string>;
}

export interface Context {
  readonly driver: Driver;
  readonly state: PreparedState;
  /** Client HTTP du kit. Toute requête jugée passe par lui. */
  readonly http: HttpClient;
  /** Une valeur aléatoire, différente à chaque passage. */
  nonce(): string;
}

export interface HttpReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

export interface HttpClient {
  send(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options?: { token?: string | null; json?: unknown },
  ): Promise<HttpReply>;
  /** Toutes les réponses non-2xx vues, pour le contrôle transversal de C35. */
  readonly errors: readonly HttpReply[];
}
