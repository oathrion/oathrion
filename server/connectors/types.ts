/**
 * Le contrat d'un connecteur.
 *
 * ## Ce qu'un connecteur est, et ce qu'il n'est jamais
 *
 * Un connecteur sait parler à UN service tiers : s'authentifier, vérifier que le jeton
 * fonctionne, dire quelles capacités il a réellement, et exécuter une opération.
 *
 * Il ne décide RIEN. Il ne consulte aucune politique, ne lit aucun mandat, ne vérifie
 * aucune permission. C'est le même choix que pour `Tool` (`server/gateway/tools/types.ts`) :
 * « A Tool NEVER decides whether an action is permitted ». Un connecteur qui porterait
 * sa propre vérification serait une seconde autorité, donc une seconde chance de dire
 * oui là où la passerelle dit non.
 *
 * La conséquence pratique : atteindre `execute()` signifie que la décision est déjà
 * prise. Le chemin est `AgentGateway.dispatch()` → `Tool.execute()` →
 * `ConnectorTool.run()` → `Connector.execute()`, et il n'y en a pas d'autre.
 *
 * ## Les cinq moments d'un connecteur, et pourquoi ils sont séparés
 *
 * `connect` valide un credential CONTRE LE SERVICE avant de le stocker. Stocker d'abord
 * et vérifier ensuite produit exactement l'écran que ce chantier remplace : une console
 * qui affiche « Connected » parce qu'un booléen a basculé.
 *
 * `test` refait cette vérification à la demande, plus tard. Un jeton valide hier peut
 * avoir été révoqué par son propriétaire — un état que seul un appel réel révèle.
 *
 * `capabilities` dit ce que CE credential peut faire, d'après ce que le service a
 * répondu, et non d'après ce que l'exploitant a coché à la connexion.
 *
 * `execute` agit. Une seule méthode, un seul point d'entrée.
 *
 * `revoke` est côté Oathrion. Chaque connecteur dit explicitement ce qu'il ne fait pas —
 * voir `ConnectorRevocation.remoteStillValid`.
 */

import type { OrganizationId } from "@shared/tenancy";

import type { ConnectorVault } from "./vault";

/** Le résultat d'un appel réel au service, succès comme échec. */
/**
 * Ce que le SERVICE dit d'une clé : vivante (elle ouvre encore une porte), morte (il la
 * refuse comme inconnue ou révoquée), ou inconnu (panne, quota, réponse illisible — on ne
 * conclut pas). Jamais déduit de la forme de la clé.
 */
export interface CredentialLiveness {
  state: "alive" | "dead" | "unknown";
  detail: string;
}

/** Une écriture vue CHEZ LE SERVICE, telle que la réconciliation la confronte aux reçus. */
export interface ReconcileItem {
  kind: "issue" | "pull_request" | "comment" | "refund" | "payout" | "payment" | "customer" | "dispute" | "message" | "task" | "missing_receipt";
  id: string;
  url: string | null;
  createdAt: string;
  /** L'auteur tel que le service le nomme, quand il le dit. */
  actor: string | null;
  /** Une ligne lisible : titre, montant. Jamais le corps entier. */
  summary: string;
  /** L'identifiant d'exécution porté par la marque d'Oathrion, ou `null` sans marque. */
  marker: string | null;
  /** Faite sous l'identité même qu'Oathrion utilise (même compte GitHub, même compte Stripe). */
  byOathrionIdentity: boolean;
}

export type ReconcileListing =
  | {
      ok: true;
      /** Sous quelle identité Oathrion agit chez ce service. */
      identity: string;
      items: ReconcileItem[];
      /** Le service avait plus à dire que ce qui a été lu : le résultat est partiel. */
      truncated: boolean;
      /** Ce que cette réconciliation ne peut pas voir, dit avec le résultat. */
      limits: string[];
    }
  | { ok: false; code: ConnectorProbeCode; detail: string };

export interface ConnectorProbe {
  ok: boolean;
  /**
   * Le compte, l'utilisateur ou l'installation tels que LE SERVICE les a nommés.
   * Jamais ce que l'exploitant a saisi : la différence entre les deux est précisément
   * ce qu'un test de connexion existe pour révéler.
   */
  account: string;
  /** Les portées que le service a confirmées. Vide quand il n'en annonce aucune. */
  scopes: string[];
  /** Ce que le service a répondu, en clair, pour qu'un humain puisse agir. */
  detail: string;
  /**
   * Un code machine stable : `ok`, `unauthorized`, `forbidden`, `not_found`,
   * `rate_limited`, `unreachable`, `unexpected`. Une interface branche sur lui ; la
   * prose de `detail` est pour l'humain et peut changer avec le service.
   */
  code: ConnectorProbeCode;
}

export type ConnectorProbeCode =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unreachable"
  | "unexpected";

/** Une capacité réellement disponible pour ce credential. */
export interface ConnectorCapability {
  /** Le verbe Oathrion, celui que la politique gouverne : `github.issue.create`. */
  action: string;
  label: string;
  /**
   * `true` seulement quand le service a confirmé que ce credential peut le faire.
   * `false` avec un motif est une information utile ; `true` par défaut serait un
   * mensonge commode.
   */
  available: boolean;
  /** Pourquoi elle ne l'est pas, quand elle ne l'est pas. */
  reason?: string;
}

export interface ConnectorExecuteRequest {
  /** Le verbe Oathrion déjà autorisé. */
  action: string;
  /** La cible de l'action, telle que la politique l'a vue. */
  target: string;
  /** Les métadonnées de l'exécution. Un connecteur n'y ajoute rien. */
  metadata: Record<string, unknown>;
  /** La clé d'idempotence : l'exécution à laquelle cet appel appartient. */
  executionId: string;
}

export interface ConnectorExecuteResult {
  ok: boolean;
  /** Une ligne lisible, stockée sur l'exécution. */
  summary: string;
  /** Ce que le service a rendu, réduit à ce qui est utile et non sensible. */
  data: Record<string, unknown>;
  code: ConnectorProbeCode;
}

export interface ConnectorRevocation {
  ok: boolean;
  /**
   * CE QUE OATHRION NE PEUT PAS FAIRE, DIT PAR LE CONNECTEUR LUI-MÊME.
   *
   * `true` signifie : Oathrion a oublié le jeton, et le service tiers le considère
   * toujours comme valide. C'est le cas d'un jeton personnel GitHub, qui ne s'annule que
   * depuis le compte qui l'a créé. Un connecteur qui appellerait une vraie API de
   * révocation mettrait `false` — et aucun ne le fait aujourd'hui.
   *
   * Le champ existe pour que l'interface l'affiche. « Déconnecté » tout court laisserait
   * croire que le jeton est mort.
   */
  remoteStillValid: boolean;
  detail: string;
}

/**
 * Ce qu'un connecteur reçoit pour agir : le coffre et le locataire.
 *
 * Le coffre et non le jeton : c'est le connecteur qui demande l'ouverture, au moment où
 * il en a besoin, et le secret ne traverse donc aucune signature de fonction
 * intermédiaire où il pourrait être journalisé par mégarde.
 */
export interface ConnectorContext {
  organizationId: OrganizationId;
  vault: ConnectorVault;
  env: NodeJS.ProcessEnv;
}

/**
 * Une ressource que le client peut CHOISIR : un dépôt, un canal, une équipe.
 *
 * `target` est exactement la cible qu'une action portera (`github.com/o/r`,
 * `slack.com/C0…`, `linear.app/ENG`) : c'est elle que la règle de périmètre nomme.
 */
export interface ConnectorResource {
  target: string;
  label: string;
  detail?: string;
}

export type ConnectorResourceListing =
  | { ok: true; resources: ConnectorResource[]; note?: string }
  | { ok: false; code: ConnectorProbeCode; detail: string };

export interface Connector {
  /** L'identifiant stable : `github`. Sans point ni deux-points (voir `sealingContext`). */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Les verbes Oathrion que ce connecteur sert. Chacun doit être au catalogue d'actions. */
  readonly actions: readonly string[];
  /**
   * La documentation de la création du credential, affichée à la connexion.
   * Une procédure, pas une promesse.
   */
  readonly credentialGuide: string;

  /** Valide un credential CONTRE LE SERVICE. Ne stocke rien. */
  verify(secret: string, options: { account?: string }, env: NodeJS.ProcessEnv): Promise<ConnectorProbe>;

  /** Refait la vérification avec le credential stocké. */
  test(context: ConnectorContext): Promise<ConnectorProbe>;

  /** Ce que CE credential peut réellement faire. */
  capabilities(context: ConnectorContext): Promise<ConnectorCapability[]>;

  /** Agit. Atteindre cette méthode signifie que la décision est déjà prise. */
  execute(context: ConnectorContext, request: ConnectorExecuteRequest): Promise<ConnectorExecuteResult>;

  /** Oublie le credential côté Oathrion, et dit ce qui reste valide ailleurs. */
  revoke(context: ConnectorContext, by: string): Promise<ConnectorRevocation>;

  /**
   * « Cette clé fonctionne-t-elle encore chez le service ? » — pour « fermer les autres
   * portes » quand un agent existant est branché sur Oathrion : la clé qu'il détenait doit
   * être MORTE, sinon l'agent garde une seconde route.
   *
   * Distinct de `verify`, et c'est voulu : `verify` refuse certaines clés AVANT d'appeler
   * le service (jeton Slack utilisateur, clé Stripe réelle…). Ici ce refus local dirait
   * « morte » d'une clé qui ouvre encore la porte — le pire faux réconfort. La question
   * est donc posée au service, sans filtre de forme. Ne stocke rien, ne rend jamais la clé.
   */
  credentialAlive?(secret: string, env: NodeJS.ProcessEnv): Promise<CredentialLiveness>;

  /**
   * La réconciliation : ce que LE SERVICE a enregistré depuis `since`, sur les ressources
   * choisies, pour le confronter aux reçus d'Oathrion. Le connecteur liste et décrit ; il
   * ne juge pas — la route classe (via Oathrion / hors Oathrion / autre auteur), parce qu'elle
   * seule sait quelles exécutions existent dans l'organisation.
   */
  reconcile?(context: ConnectorContext, options: { since: string; resources: string[] }): Promise<ReconcileListing>;

  /**
   * Les ressources que CE credential atteint réellement, pour que le client choisisse.
   * Un appel de CONFIGURATION par un administrateur (comme `test`), jamais une action
   * d'agent : il ne lit que des noms, pas de contenu.
   */
  resources?(context: ConnectorContext): Promise<ConnectorResourceListing>;
}
