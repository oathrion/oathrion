/**
 * La chaîne des reçus d'action : une seule définition de son empreinte, et son
 * vérificateur.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le plan d'autorité écrit sa propre chaîne — chaque reçu porte `prevHash`, `entryHash`
 * et un `entrySeq` sans trou, unique par locataire depuis la migration 13. Elle rend
 * détectables l'édition, le réordonnancement et la suppression, exactement comme la
 * chaîne d'audit des exécutions.
 *
 * Il n'existait **aucun moyen de la vérifier**. La route d'audit
 * (`GET /api/executions/:id/audit/verify`) vérifie une AUTRE chaîne, celle des
 * exécutions, et le chemin d'autorité n'écrit pas dans cette table : son `executionId`
 * est un `axn_…` qui nomme l'appel aval, pas une ligne de `executions`. Un client qui
 * n'utilise que le plan d'autorité — c'est-à-dire le chemin recommandé — ne disposait
 * donc d'aucune façon, par HTTP, de vérifier la trace de ses propres actions.
 *
 * C'est le kit de conformité qui l'a trouvé : C32 et C33 restaient en SKIP, motif « le
 * profil ne nomme aucun enregistrement vérifiable ».
 *
 * ## La règle qui gouverne ce fichier
 *
 * Le calcul de l'empreinte était écrit **en ligne** dans `writeReceipt`. Le dupliquer
 * ici aurait créé deux définitions de « empreinte d'un reçu », et c'est la plus faible
 * des deux qui aurait fini par servir de vérificateur — un vérificateur qui calcule
 * autrement laisse passer une chaîne falsifiée ou condamne une chaîne saine. Il est donc
 * extrait, et l'écrivain l'appelle.
 *
 * ## Ce que cette vérification prouve, et ce qu'elle ne prouve pas
 *
 * Elle prouve que la suite de reçus n'a pas été éditée, réordonnée, ni amputée en son
 * milieu depuis son écriture. Elle ne prouve rien à un tiers : il n'y a ni signature ni
 * ancrage externe, donc quelqu'un disposant d'un accès en écriture à la base ET au code
 * peut recalculer une chaîne entière et cohérente. Même limite que `audit-chain.ts`, et
 * elle est écrite dans `docs/limitations.md`.
 */

import { createHash } from "node:crypto";
import type { OrganizationId } from "@shared/tenancy";

/** Les champs d'un reçu qui entrent dans son empreinte. */
export interface ReceiptChainInput {
  receiptId: string;
  grantId: string;
  actionId: string;
  agentId: string;
  action: string;
  actionHash: string;
  destinationId: string;
  decision: string;
  approvalId: string | null;
  executedAt: string;
  downstreamExecutionId: string | null;
  outcome: "succeeded" | "failed";
  resultHash: string;
  /**
   * Le résumé lisible du résultat, borné à 500 caractères.
   *
   * **Dans l'empreinte depuis le renommage ARIA → Placet, et il n'y était pas avant.** Ce champ
   * figure sur chaque reçu que lit un auditeur ; un accès en écriture à la base
   * permettait donc de réécrire « remboursement de 25 émis » en autre chose sans rompre
   * la vérification. Ce n'était pas une faille d'exécution — la décision, l'issue et
   * l'empreinte du résultat étaient protégées — mais c'était un écart entre ce que le
   * reçu MONTRE et ce que la chaîne COUVRE, et un auditeur raisonnable supposait le
   * contraire.
   *
   * Trouvé en éprouvant `npm run audit:chains` : le banc falsifiait précisément ce champ
   * pour prouver qu'une rupture est détectée, et l'audit avait RAISON de ne rien voir.
   */
  resultSummary: string;
  prevHash: string | null;
  entrySeq: number | null;
}

/**
 * L'empreinte d'un reçu — **la seule définition**, appelée à l'écriture comme à la
 * vérification.
 *
 * `entrySeq` entre dans le corps haché : sans lui, un reçu pourrait être déplacé à une
 * autre position tout en vérifiant encore, ce qui rendrait la séquence décorative.
 *
 * **`resultSummary` y entre aussi, et pas depuis le début.** Le corps hachait quinze
 * champs et laissait dehors le seul texte lisible du reçu, celui qu'un auditeur lit en
 * premier. L'ajouter INVALIDE toute chaîne écrite avant ce changement — même classe de
 * conséquence que modifier le séparateur ci-dessous — et c'était donc une décision du
 * propriétaire, prise avant le premier pilote, quand elle ne coûtait rien. Il n'existe
 * pas de migration de rattrapage honnête : recalculer les empreintes depuis la base
 * reviendrait à certifier des lignes qu'on n'a pas vues écrire, ce que la chaîne existe
 * précisément pour empêcher.
 *
 * Le prédécesseur d'un premier reçu est `genesis:<organisation>` et non la chaîne vide :
 * deux locataires qui démarrent ne doivent pas partager un point de départ, sinon le
 * premier reçu de l'un se greffe sans effort sur la chaîne de l'autre.
 */
export function receiptEntryHash(organization: OrganizationId, receipt: ReceiptChainInput): string {
  const body = [
    organization,
    receipt.receiptId,
    receipt.grantId,
    receipt.actionId,
    receipt.agentId,
    receipt.action,
    receipt.actionHash,
    receipt.destinationId,
    receipt.decision,
    receipt.approvalId ?? "",
    receipt.executedAt,
    receipt.downstreamExecutionId ?? "",
    receipt.outcome,
    receipt.resultHash,
    receipt.resultSummary,
    String(receipt.entrySeq),
  ].join("\u0000");

  return createHash("sha256")
    .update(`${receipt.prevHash ?? `genesis:${organization}`}\u0000${body}`, "utf8")
    .digest("hex");
}

/** Un reçu tel qu'il est stocké : les champs hachés, plus l'empreinte écrite. */
export type StoredReceipt = ReceiptChainInput & { entryHash: string };

export interface ReceiptChainVerdict {
  ok: boolean;
  /** Nombre de reçus examinés. */
  entries: number;
  /** L'empreinte du dernier reçu, ou `null` quand la chaîne est vide. */
  headHash: string | null;
  /** Position (0-based) du premier reçu en défaut, ou `null`. */
  brokenAt: number | null;
  /** Ce qui est cassé, en clair, pour un exploitant qui lit un incident. */
  reason: string | null;
}

/**
 * Vérifie la chaîne d'un locataire. `receipts` doit être **croissant par `entrySeq`**.
 *
 * Quatre défauts sont distingués, parce qu'ils ne se diagnostiquent pas pareil :
 *
 *   - `sequence` — un trou ou un doublon dans les positions : un reçu a été retiré ou
 *     inséré. C'est le seul défaut que le chaînage seul ne verrait pas, puisqu'un reçu
 *     retiré en fin de chaîne laisse le reste cohérent ;
 *   - `link` — le `prevHash` ne nomme pas l'empreinte du prédécesseur : la suite a été
 *     réordonnée, ou un reçu a été greffé ;
 *   - `content` — l'empreinte recalculée diffère de celle stockée : le contenu a été
 *     édité ;
 *   - `genesis` — le premier reçu prétend avoir un prédécesseur, ou un reçu du milieu
 *     prétend n'en avoir aucun.
 *
 * Une chaîne vide est `ok` : un locataire qui n'a encore rien exécuté n'a rien à
 * prouver. C'est la réponse honnête, et `entries: 0` permet à l'appelant de ne pas la
 * confondre avec une chaîne vérifiée.
 */
export function verifyReceiptChain(
  organization: OrganizationId,
  receipts: readonly StoredReceipt[],
): ReceiptChainVerdict {
  const verifier = new ReceiptChainVerifier(organization);
  for (const receipt of receipts) verifier.push(receipt);
  return verifier.verdict();
}

/**
 * La même vérification, un reçu à la fois : la mémoire reste celle d'UN reçu, quelle que
 * soit la longueur de la chaîne.
 *
 * ## Pourquoi
 *
 * La route de vérification chargeait TOUTE la chaîne du locataire en un tableau : sa
 * mémoire suivait la longueur de la chaîne, donc l'âge du locataire — 20 000 reçus à
 * l'heure sous le banc d'endurance, un demi-million en douze heures. Relevé en cherchant
 * la croissance du tas de V8 sous trafic continu (`docs/STRESS-TEST-LOG.md` § 5.13) ; ce
 * correctif borne CE coût, il n'est PAS démontré être la cause de cette croissance.
 *
 * ## Le verdict est EXACTEMENT celui de l'ancienne version, en un seul passage
 *
 * L'ancienne version vérifiait tous les contenus, puis tous les liens : un contenu édité,
 * où qu'il soit, l'emporte sur un lien rompu plus tôt. C'est un choix de diagnostic : une
 * édition change l'empreinte recalculée du reçu édité, ce qui casse AUSSI le lien de son
 * successeur ; vérifier les liens d'abord accuserait le reçu suivant (« lien rompu au
 * n°3 » là où la vérité est « contenu modifié au n°2 » — le test « détecte un contenu
 * édité » l'a montré au premier jet de ce fichier). Ici :
 *
 *   - le PREMIER défaut de contenu rencontré est le plus bas : il est le verdict, et la
 *     suite ne sert plus qu'à compter les reçus (`entries` reste le total) ;
 *   - le premier défaut de position, de genèse ou de lien est RETENU, et le parcours
 *     continue, parce qu'un contenu édité plus loin l'emporterait sur lui ;
 *   - le lien du reçu `i` est comparé à l'empreinte RECALCULÉE de `i − 1`, comme avant :
 *     tant qu'aucun contenu n'est en défaut, elle est égale à l'empreinte stockée.
 *
 * `verifyReceiptChain` ci-dessus passe par cette classe : les tests du verdict éprouvent
 * donc le même code que la route.
 */
export class ReceiptChainVerifier {
  private entries = 0;
  /** L'empreinte recalculée du dernier reçu vu (son contenu était intact). */
  private previousHash: string | null = null;
  private content: { index: number; reason: string } | null = null;
  private link: { index: number; reason: string } | null = null;

  /**
   * `resume` : reprendre APRÈS une partie déjà vérifiée — `entries` reçus, dont le dernier a
   * l'empreinte `headHash`. Le premier reçu poussé doit alors porter la position
   * `entries + 1` et nommer `headHash` ; la règle de genèse ne s'applique qu'à un départ
   * de zéro. C'est la vérification par ÉTAPES (journal §5.35) : elle ne voit pas une
   * modification de la partie déjà vérifiée, que seule la vérification complète voit.
   */
  constructor(
    private readonly organization: OrganizationId,
    resume?: { entries: number; headHash: string },
  ) {
    if (resume) {
      this.entries = resume.entries;
      this.previousHash = resume.headHash;
      this.start = resume.entries;
    }
  }

  /** Le nombre de reçus déjà vérifiés avant ce passage (0 pour une vérification complète). */
  private readonly start: number = 0;

  push(receipt: StoredReceipt): void {
    const index = this.entries;
    this.entries += 1;
    if (this.content !== null) return;

    const recomputed = receiptEntryHash(this.organization, receipt);
    if (receipt.entryHash !== recomputed) {
      this.content = {
        index,
        reason: `content: the content of receipt "${receipt.receiptId}" has changed since it was written`,
      };
      return;
    }

    if (this.link === null) {
      const reason = this.linkDefect(index, receipt);
      if (reason !== null) this.link = { index, reason };
    }
    this.previousHash = recomputed;
  }

  private linkDefect(index: number, receipt: StoredReceipt): string | null {
    const expectedSeq = index + 1;
    if (receipt.entrySeq !== expectedSeq) {
      return (
        `sequence: receipt "${receipt.receiptId}" carries position ${String(receipt.entrySeq)} ` +
        `where ${expectedSeq} was expected — a receipt was removed, inserted or moved`
      );
    }
    if (index === 0 && this.start === 0) {
      if (receipt.prevHash !== null) {
        return `genesis: the first receipt "${receipt.receiptId}" names a predecessor`;
      }
      return null;
    }
    if (receipt.prevHash === null) {
      return `genesis: receipt "${receipt.receiptId}" names no predecessor`;
    }
    if (receipt.prevHash !== this.previousHash) {
      return `link: receipt "${receipt.receiptId}" does not name its predecessor's hash`;
    }
    return null;
  }

  verdict(): ReceiptChainVerdict {
    if (this.entries === 0 || (this.start > 0 && this.entries === this.start)) {
      /* Rien de nouveau depuis le point de reprise : la tête reste celle qu'il nommait. */
      if (this.start > 0) return { ok: true, entries: this.entries, headHash: this.previousHash, brokenAt: null, reason: null };
      return { ok: true, entries: 0, headHash: null, brokenAt: null, reason: null };
    }
    const defect = this.content ?? this.link;
    if (defect !== null) {
      return { ok: false, entries: this.entries, headHash: null, brokenAt: defect.index, reason: defect.reason };
    }
    return { ok: true, entries: this.entries, headHash: this.previousHash, brokenAt: null, reason: null };
  }
}
