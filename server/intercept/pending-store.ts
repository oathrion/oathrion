/**
 * Le sas des requêtes qui attendent un humain.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Le pare-feu garait la requête interceptée dans une `Map` du processus, TTL soixante
 * secondes. Mesuré : *« après 61 s, la requête est : PERDUE »*. Un opérateur qui approuvait
 * après une minute voyait son approbation réussir et rien partir. Le test qui couvrait ce
 * chemin approuvait dans la milliseconde, donc il passait.
 *
 * Et deux conséquences du même choix : un redémarrage effaçait les requêtes en attente, et
 * sur deux instances, approuver sur l'une ne relâchait pas une requête garée sur l'autre.
 *
 * ## LA VOIE RAPIDE RESTE EN MÉMOIRE, ET C'EST VOULU
 *
 * Un ALLOW est synchrone : la route dépose, le relais reprend dans la même requête HTTP.
 * Rien n'est écrit. Payer une écriture et une suppression pour chaque appel autorisé
 * serait une amplification d'écriture au bénéfice de personne.
 *
 * Ce magasin n'est écrit QUE lorsque la décision est APPROVAL_REQUIRED — quand un humain
 * entre dans la boucle et que l'attente se mesure en minutes.
 *
 * ## Trois garde-fous, parce que persister un corps est un arbitrage
 *
 * Ce dépôt vient d'imposer au pare-feu que le corps d'une requête ne soit PAS persisté, et
 * ce fichier en persiste un. La règle n'est pas abandonnée, elle est arbitrée : pour
 * compléter une requête après qu'un humain l'ait approuvée, il faut l'avoir gardée —
 * l'alternative est de la perdre, c'est-à-dire le défaut qu'on corrige.
 *
 *   1. **chiffré** par `secrets/envelope.ts`, avec le locataire dans le contexte
 *      authentifié : une ligne déplacée chez un autre client ne déchiffre pas ;
 *   2. **à usage unique** — la reprise est une suppression conditionnelle, et c'est ELLE
 *      qui décide : deux approbations concurrentes ne peuvent pas obtenir la même ligne ;
 *   3. **expirante** — une ligne périmée n'est jamais rendue, même si aucun balayage n'a
 *      encore eu lieu.
 *
 * Ce n'est pas la trace d'audit. Celle-ci ne porte toujours que les champs évalués.
 */

import type { OrganizationId } from "@shared/tenancy";

import { openSecret, sealSecret } from "../secrets/envelope";
import { vaultKeyring } from "../connectors/vault";
import type { SqlExecutor } from "../sql/executor";
import { PENDING_INTERCEPTIONS_TABLE } from "../migrations/022-pending-interceptions";
import { resolveDestination } from "../authority/destinations";
import type { PendingForward } from "./forward";

interface Row {
  ref: string;
  execution_id: string;
  destination_id: string;
  method: string;
  path: string;
  query: string;
  headers_envelope: string;
  body_envelope: string;
  credential_header: string;
  credential_template: string;
  forward_headers: string;
  /** NULL : la règle ne déclarait pas de champ de réussite (migration 24). */
  success_field: string | null;
  expires_at: string;
}

/**
 * Le délai laissé à un humain.
 *
 * Aligné sur `OATHRION_ACTION_APPROVAL_TTL_MS`, le TTL d'approbation du plan d'autorité
 * (15 minutes par défaut) : deux horloges différentes pour le même geste produiraient
 * l'une des deux situations absurdes — une approbation encore valide dont la requête a
 * disparu, ou une requête conservée pour une approbation périmée.
 */
export function approvalWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OATHRION_ACTION_APPROVAL_TTL_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

/**
 * Le contexte de scellement. `envelope.ts` refuse un « . », d'où la vérification.
 *
 * Le `ref` est un UUID v4 : il ne contient ni point ni deux-points. Le vérifier quand
 * même évite qu'un futur générateur de jetons casse le format en silence.
 */
function sealingContext(org: OrganizationId, ref: string): string {
  if (ref.includes(".") || ref.includes(":") || ref.trim() === "") {
    throw new Error(
      `The interception token ${JSON.stringify(ref)} is invalid: it cannot contain ` +
        `"." or ":".`,
    );
  }
  return `intercept:${org}:${ref}`;
}

export class PendingInterceptionStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Gare une requête en attendant un humain.
   *
   * Scelle AVANT d'écrire : le clair ne passe jamais par un paramètre de requête, donc ni
   * par le WAL, ni par un journal de requêtes lentes.
   */
  async put(params: {
    ref: string;
    executionId: string;
    forward: PendingForward;
    now?: Date;
  }): Promise<void> {
    const keyring = await vaultKeyring(this.env);
    const context = sealingContext(this.org, params.ref);
    const { forward } = params;
    const now = params.now ?? new Date();
    const expires = new Date(now.getTime() + approvalWindowMs(this.env));

    await this.sql.run(
      `DELETE FROM ${PENDING_INTERCEPTIONS_TABLE} WHERE organization_id = ? AND ref = ?`,
      [this.org, params.ref],
    );
    await this.sql.run(
      `INSERT INTO ${PENDING_INTERCEPTIONS_TABLE}
         (organization_id, ref, execution_id, destination_id, method, path, query,
          headers_envelope, body_envelope, credential_header, credential_template,
          forward_headers, success_field, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.org,
        params.ref,
        params.executionId,
        forward.destinationId,
        forward.request.method,
        forward.request.path,
        JSON.stringify(forward.request.query),
        sealSecret(keyring, context, JSON.stringify(forward.request.headers)),
        /*
         * Le corps BRUT est scellé, pas l'objet parsé : c'est lui qui repartira, et une
         * re-sérialisation après approbation réintroduirait exactement le défaut qui
         * rendait Stripe inutilisable.
         */
        sealSecret(keyring, context, forward.request.rawBody ?? JSON.stringify(forward.request.body)),
        forward.credentialHeader,
        forward.credentialTemplate,
        JSON.stringify(forward.forwardHeaders),
        /* Garé avec la requête : c'est la règle en vigueur à la DÉCISION qui jugera la réussite. */
        forward.successField ?? null,
        now.toISOString(),
        expires.toISOString(),
      ],
    );
  }

  /**
   * Reprend la requête, UNE SEULE FOIS.
   *
   * ## L'ordre est la propriété, comme pour la consommation d'un grant
   *
   * On lit, puis on supprime **avec les mêmes prédicats**, et c'est la SUPPRESSION qui
   * décide : la ligne n'est rendue que si le `DELETE` a effectivement retiré une ligne.
   * Deux approbations concurrentes voient donc la même ligne au `SELECT`, et une seule
   * repart avec — l'autre reçoit `null`, et le relais répond « plus disponible ».
   *
   * Sans ce `DELETE` conditionnel, deux approbations simultanées relaieraient deux fois la
   * même requête : le grant à usage unique de la passerelle ferme déjà cette porte, et
   * celle-ci est la seconde serrure sur la même porte.
   *
   * `expires_at > ?` est répété dans le `DELETE` : une ligne périmée n'est jamais rendue,
   * même si aucun balayage n'a encore eu lieu.
   */
  async take(ref: string, now: Date = new Date()): Promise<PendingForward | null> {
    const stamp = now.toISOString();
    const rows = await this.sql.all<Row>(
      `SELECT ref, execution_id, destination_id, method, path, query, headers_envelope,
              body_envelope, credential_header, credential_template, forward_headers, success_field, expires_at
         FROM ${PENDING_INTERCEPTIONS_TABLE}
        WHERE organization_id = ? AND ref = ? AND expires_at > ?`,
      [this.org, ref, stamp],
    );
    const row = rows[0];
    if (!row) return null;

    const claimed = await this.sql.run(
      `DELETE FROM ${PENDING_INTERCEPTIONS_TABLE}
        WHERE organization_id = ? AND ref = ? AND expires_at > ?`,
      [this.org, ref, stamp],
    );
    if (claimed < 1) return null;

    /*
     * La destination est RE-RÉSOLUE, jamais relue depuis la ligne.
     *
     * Entre le dépôt et l'approbation, l'exploitant peut avoir retiré la destination du
     * registre, ou l'avoir sortie de la portée de ce locataire. Faire confiance à ce qui a
     * été écrit ferait partir une requête vers une destination qui n'est plus permise —
     * c'est la faille de liaison de destination que le plan d'autorité refuse déjà
     * ailleurs. Si elle ne résout plus, la requête n'est pas relayée.
     */
    let destination;
    try {
      destination = resolveDestination(row.destination_id, this.env, this.org).destination;
    } catch {
      return null;
    }

    const keyring = await vaultKeyring(this.env);
    const context = sealingContext(this.org, ref);
    const headers = JSON.parse(openSecret(keyring, context, row.headers_envelope)) as Record<string, string>;
    const rawBody = openSecret(keyring, context, row.body_envelope);
    /*
     * Le parsé est reconstruit depuis le brut pour les appelants qui le lisent ; le brut
     * reste la source de ce qui part. Un corps non-JSON — form-encoded — ne se reparse pas
     * ici, et n'a pas à l'être : la décision a déjà été prise.
     */
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      body = null;
    }

    return {
      destination,
      destinationId: row.destination_id,
      request: {
        method: row.method,
        path: row.path,
        query: JSON.parse(row.query) as Record<string, string>,
        headers,
        body,
        ...(rawBody === "" ? {} : { rawBody }),
      },
      credentialHeader: row.credential_header,
      credentialTemplate: row.credential_template,
      /*
       * L'allowlist telle qu'elle était au moment de la décision, relue depuis la ligne.
       * La reprendre de `OATHRION_INTERCEPTS` ferait partir la requête avec la permission du
       * moment où l'humain clique, qui peut être plus large que celle qui a été jugée.
       */
      forwardHeaders: JSON.parse(row.forward_headers) as string[],
      ...(row.success_field ? { successField: row.success_field } : {}),
    };
  }

  /**
   * Efface les lignes périmées de CE locataire.
   *
   * Appelé par la route au moment où elle en gare une : un balayage à l'écriture coûte
   * une suppression par plage et n'a besoin d'aucune tâche de fond — laquelle serait, sur
   * plusieurs instances, une tâche à coordonner. Une ligne périmée non encore balayée est
   * de toute façon inatteignable (`expires_at > ?`).
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    return this.sql.run(
      `DELETE FROM ${PENDING_INTERCEPTIONS_TABLE} WHERE organization_id = ? AND expires_at <= ?`,
      [this.org, now.toISOString()],
    );
  }

  /** Test-only : combien de requêtes attendent pour ce locataire. */
  async count(): Promise<number> {
    const rows = await this.sql.all<{ n: number | string }>(
      `SELECT count(*) AS n FROM ${PENDING_INTERCEPTIONS_TABLE} WHERE organization_id = ?`,
      [this.org],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
