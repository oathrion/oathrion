/**
 * Les mutants de SOURCE — ceux qu'un proxy ne pouvait pas écrire.
 *
 * ## Pourquoi ce fichier existe, et pourquoi il n'existait pas
 *
 * `mutants/proxy.ts` met un proxy inverse devant l'implémentation réelle : « correct sauf
 * sur un point », gratuitement. Ce dessin couvre tout ce qui est une **forme de réponse**
 * — un défaut permissif, un champ honoré, une erreur en prose.
 *
 * Il ne peut pas couvrir les groupes **grant** (C10–C16) et **approbation** (C18–C22),
 * et `REPORT.md` disait pourquoi : leur violation est un changement d'**état côté
 * serveur**. Rejouer un grant consommé doit *réellement* livrer une seconde fois, et un
 * proxy qui réécrit des réponses ne peut pas le simuler sans mentir aussi sur le compteur
 * de livraisons — c'est-à-dire sans fabriquer un mutant attrapé pour la mauvaise raison.
 *
 * Onze propriétés cœur étaient donc **vérifiées mais non éprouvées**. Ce fichier les
 * éprouve, par la seule voie honnête : des mutations dans le code du produit, sur le
 * modèle de `script/mutation-audit.ts`.
 *
 * ## Les noms viennent de la spécification
 *
 * `SPEC.md` nommait déjà chacun de ces mutants, propriété par propriété — `rejeu-livre`,
 * `hash-ignore`, `agent-ignore`… Ce fichier ne choisit rien : il implémente une liste
 * écrite avant lui, ce qui est la seule façon d'éviter de dessiner les mutants d'après le
 * code plutôt que d'après la promesse.
 *
 * ## Deux règles que ces mutations respectent
 *
 * **Une défense en profondeur se retire en entier.** Le dépôt vérifie l'agent et
 * l'empreinte d'action DEUX fois : une comparaison applicative dans
 * `enforcement-point.ts`, qui sert à *nommer* le défaut, et un prédicat dans l'`UPDATE`
 * de consommation, qui *décide*. Muter une seule couche produit une mutation
 * **équivalente** — le comportement ne change pas, aucun test ne peut tomber, et
 * « SURVÉCU » serait une fausse accusation contre le kit. Chaque mutation retire donc la
 * défense entière, via `also`.
 *
 * **Un paramètre lié ne disparaît jamais.** Les requêtes passent leurs valeurs
 * positionnellement : supprimer un `?` décale tout ce qui suit et produit une erreur SQL,
 * pas une violation de propriété. Les prédicats sont donc neutralisés par `OR 1=1`, qui
 * garde le `?` en place.
 *
 * ## Sécurité : pourquoi il y a un manifeste sur disque
 *
 * Exactement la leçon de `script/mutation-audit.ts`, et elle a été apprise de la pire
 * façon : ce script-là a été tué par un SIGKILL en pleine exécution et a laissé un
 * contournement de plafond de dépense dans l'arbre de travail, l'original n'existant plus
 * qu'en mémoire du processus mort.
 *
 * Les octets d'origine sont donc écrits dans `.mutation-backup/` **avant** la première
 * mutation, et toute exécution commence par vérifier ce manifeste. S'il existe et qu'un
 * fichier en diffère, on refuse de tourner : impossible de distinguer un reste de
 * mutation d'une édition légitime, et il ne faut écraser ni l'un ni l'autre.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BACKUP_DIR = path.join(ROOT, ".mutation-backup");

export interface SourceEdit {
  file: string;
  /** Doit apparaître EXACTEMENT une fois dans le fichier, sinon la mutation est périmée. */
  find: string;
  replace: string;
}

export interface SourceMutant {
  /** Les propriétés que cette mutation DOIT faire tomber. */
  readonly breaks: readonly string[];
  readonly describe: string;
  /** La mutation principale, plus celles qui retirent le reste de la défense. */
  readonly edits: readonly SourceEdit[];
}

const STORE = "server/authority/store.ts";
const POINT = "server/authority/enforcement-point.ts";
const CHAIN = "server/authority/receipt-chain.ts";
const ROLES = "shared/roles.ts";
const BINDING = "server/identity/agent-binding.ts";
const CONSTRAINTS = "shared/policy/constraints.ts";
const SERVICE = "server/authority/authorization-service.ts";

/**
 * LA LISTE. Un nom par propriété, pris de `SPEC.md`.
 *
 * Chaque `find` est choisi pour être unique dans son fichier — `assertEditsApply` le
 * vérifie et refuse de muter sinon, parce qu'une mutation qui ne s'applique plus laisse
 * le kit annoncer « attrapé » sans avoir rien cassé.
 */
export const SOURCE_MUTANTS: Record<string, SourceMutant> = {
  /* ------------------------- A. Decision et isolation ------------------------- */

  /*
   * Les cinq mutants ci-dessous eprouvent des proprietes qui etaient VERIFIEES mais non
   * PROUVEES : la suite passait, et rien ne garantissait qu'elle aurait echoue si le
   * produit avait cesse de tenir sa promesse. C'est exactement le reproche que le kit
   * adresse aux autres suites.
   */

  "plafond-sans-effet": {
    breaks: ["C1"],
    describe: "la comparaison numerique d'une contrainte ne compare plus : au-dessus du plafond cesse d'etre reconnu",
    edits: [
      {
        /*
         * La premiere version de ce mutant visait `shared/policy/rules.ts`, la regle de
         * plafond de transaction -- et elle a SURVECU. Mutation equivalente : le fixture
         * de conformite n'emploie pas cette regle, il ecrit ses deux seuils en
         * contraintes `gt` et `lte`. Je mutais du code que la suite n'execute jamais.
         *
         * Le kit a eu raison contre moi, et c'est precisement ce a quoi il sert : un
         * mutant qui survit accuse d'abord son auteur.
         */
        file: CONSTRAINTS,
        find: '    case "gt":\n      return actual > expected;',
        replace: '    case "gt":\n      return false;',
      },
    ],
  },

  "bloque-executable": {
    breaks: ["C3"],
    describe: "un grant dont la decision est BLOCK devient executable : l'action refusee atteint l'outil",
    edits: [
      {
        file: POINT,
        find: '    if (grant.decision === "BLOCK") {',
        replace: '    if ((false as boolean) && grant.decision === "BLOCK") {',
      },
      {
        // La seconde couche : le predicat SQL qui DECIDE. Sans lui, mutation equivalente
        // -- l'UPDATE refuserait encore et le compteur de livraisons ne bougerait pas.
        file: STORE,
        find: "          AND decision <> 'BLOCK'\n",
        replace: "          AND (decision <> 'BLOCK' OR 1=1)\n",
      },
      {
        /*
         * LA TROISIEME, sans laquelle les deux premieres ne servent a rien -- et c'est
         * pour l'avoir oubliee que ce mutant a d'abord survecu.
         *
         * Un BLOCK n'emet AUCUN grant : « No grant. Nothing to present, so nothing can
         * be executed. » Il n'y avait donc rien a presenter, la branche mutee etait
         * inatteignable, et le compteur de livraisons ne pouvait pas bouger. Pour que la
         * propriete tombe, il faut d'abord que le BLOCK emette un grant comme les autres.
         */
        file: SERVICE,
        find: '    if (verdict.decision === "BLOCK") {',
        replace: '    if ((false as boolean) && verdict.decision === "BLOCK") {',
      },
      {
        /*
         * LA QUATRIEME, ajoutee au produit APRES ce mutant (`f015101`) : `createGrant`
         * refuse d'ECRIRE un grant dont la decision est BLOCK. Sans cette couche-ci, le
         * mutant levait a l'autorisation, la reponse etait un 500, et c'est C1 (« la
         * decision suit la regle ») qui tombait -- avant que C3 ne s'execute. Le kit
         * comptait cela comme un echec d'attribution, depuis `c75406a`.
         *
         * Le produit etait donc MIEUX garde que ce que le mutant supposait. Le mutant,
         * lui, ne representait plus ce qu'il annonce : « l'action refusee atteint
         * l'outil ». Avec les quatre couches neutralisees, le BLOCK porte un grant, se
         * presente, se consomme et livre -- et c'est C3 qui doit le voir.
         */
        file: STORE,
        find: '    if (grant.decision === "BLOCK") {\n      throw new Error(',
        replace: '    if ((false as boolean) && grant.decision === "BLOCK") {\n      throw new Error(',
      },
    ],
  },

  "approbation-d-un-autre": {
    // Meme collateral que `execution-d-un-autre`, et pour la meme raison : la route
    // d'approbation lit le grant par son identifiant, donc rendre l'approbation
    // transfrontaliere exige d'abord de rendre la LECTURE transfrontaliere.
    breaks: ["C24", "C27"],
    describe: "le cadrage locataire disparait de l'approbation : B lit et approuve un grant de A",
    edits: [
      {
        file: STORE,
        find: "        WHERE organization_id = ?\n          AND id = ?\n          AND state = 'pending_approval'\n",
        replace: "        WHERE (organization_id = ? OR 1=1)\n          AND id = ?\n          AND state = 'pending_approval'\n",
      },
      {
        // La lecture qui precede : sans elle, B recoit GRANT_NOT_FOUND avant d'arriver
        // a l'UPDATE, et la mutation n'atteint jamais le code qu'elle vise.
        file: STORE,
        find: "`SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = ? AND id = ?`",
        replace: "`SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE (organization_id = ? OR 1=1) AND id = ?`",
      },
    ],
  },

  "execution-d-un-autre": {
    /*
     * Deux proprietes, et c'est inevitable. Pour que B consomme le grant de A, il faut
     * d'abord qu'il puisse le LIRE : sans la seconde edition, `findGrant` rend
     * `undefined`, l'appel s'arrete sur GRANT_NOT_FOUND et l'`UPDATE` mute n'est jamais
     * atteint -- mutation equivalente. Retirer le cadrage locataire de la lecture fait
     * donc tomber C27 (l'existence d'un objet de A ne doit pas etre revelee) en meme
     * temps que C26. Declarer les deux est la verite sur cette mutation ; n'en declarer
     * qu'une ferait passer la seconde pour une surprise.
     */
    breaks: ["C26", "C27"],
    describe: "le cadrage locataire disparait du chemin des grants : B lit et depense un grant de A",
    edits: [
      {
        file: STORE,
        find: "        WHERE organization_id = ?\n          AND id = ?\n          AND state = 'issued'\n",
        replace: "        WHERE (organization_id = ? OR 1=1)\n          AND id = ?\n          AND state = 'issued'\n",
      },
      {
        file: STORE,
        find: "`SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = ? AND id = ?`",
        replace: "`SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE (organization_id = ? OR 1=1) AND id = ?`",
      },
    ],
  },

  "listes-qui-fuient": {
    breaks: ["C28"],
    describe: "la liste des recus ne filtre plus le locataire : B voit les recus de A",
    edits: [
      {
        file: STORE,
        /*
         * Le motif porte la requete ENTIERE, et il a fallu deux echecs pour l'admettre.
         *
         * Ce fichier contient trois requetes qui s'ouvrent par les memes deux lignes, et
         * meme l'`ORDER BY` ne les separe pas : `SELECT entry_hash, entry_seq ... LIMIT 1`,
         * `SELECT entry_hash ... LIMIT 1` et celle-ci. Seul le couple `SELECT *` +
         * `LIMIT ?` est unique. Le garde a refuse les deux motifs trop courts, et c'est
         * exactement son role : muter la mauvaise requete aurait casse la verification de
         * chaine au lieu de l'isolation des listes -- un mutant attrape pour la mauvaise
         * raison, qui est pire qu'un mutant absent.
         *
         * DEPUIS `075c896`, cette requete n'existe plus : la tete de chaine est lue en deux
         * lectures indexees (`newestReceipts`), qui servent AUSSI l'ecriture de la chaine.
         * Le motif d'alors ne trouvait plus rien, et `--mutants` s'arretait sur ce mutant
         * sans que personne ne le voie (releve le 21 octobre, en deplacant les deux
         * mutants de la chaine). Muter `newestReceipts` ferait rater l'ajout d'un recu --
         * attrape pour la mauvaise raison, encore. La mutation porte donc sur
         * `listReceipts` SEUL : la liste lue par le client fuit, l'ecriture et la
         * verification restent intactes.
         */
        find: "  async listReceipts(limit = 100): Promise<ReceiptRecord[]> {\n",
        replace:
          "  async listReceipts(limit = 100): Promise<ReceiptRecord[]> {\n" +
          "    const leaked = await this.sql.all<Row>(\n" +
          "      `SELECT * FROM ${ACTION_RECEIPTS_TABLE}\n" +
          "        WHERE (organization_id = ? OR 1=1)\n" +
          "        ORDER BY entry_seq DESC NULLS LAST, executed_at DESC, receipt_id DESC\n" +
          "        LIMIT ?`,\n" +
          "      [this.org, limit],\n" +
          "    );\n" +
          "    if (true as boolean) return leaked.map(toReceipt);\n",
      },
    ],
  },

  /* ------------------------------- B. Grant ------------------------------- */

  "rejeu-livre": {
    breaks: ["C10"],
    describe: "un grant déjà consommé se consomme à nouveau : le rejeu livre une seconde fois",
    edits: [
      {
        file: STORE,
        find: "          AND state = 'issued'\n",
        replace: "          AND state IN ('issued', 'consumed')\n",
      },
      {
        /*
         * LA SECONDE COUCHE, et son absence a d'abord fait de ce mutant une mutation
         * ÉQUIVALENTE : il n'attrapait rien parce que `verify` refusait encore sur
         * `GRANT_ALREADY_CONSUMED` avant d'atteindre l'`UPDATE`. La doctrine `also` est
         * écrite en haut de ce fichier et je ne l'avais pas appliquée ici — le tableau
         * des mutants l'a dit en une ligne.
         */
        file: POINT,
        find: '    if (grant.state === "consumed") {',
        replace: '    if ((false as boolean) && grant.state === "consumed") {',
      },
    ],
  },

  "hash-ignore": {
    breaks: ["C11"],
    describe: "l'empreinte de l'action n'est plus liée au grant : un grant paie n'importe quel montant",
    edits: [
      {
        file: STORE,
        find: "          AND action_hash = ?\n          AND destination_id = ?\n",
        replace: "          AND (action_hash = ? OR 1=1)\n          AND destination_id = ?\n",
      },
      {
        // La couche applicative, qui nomme le défaut. Sans elle, mutation équivalente.
        file: POINT,
        find: "    if (grant.actionHash !== presented.envelope.actionHash) {",
        replace: "    if ((false as boolean) && grant.actionHash !== presented.envelope.actionHash) {",
      },
    ],
  },

  "agent-ignore": {
    breaks: ["C12"],
    describe: "l'agent n'est plus lié au grant : l'autorité devient transférable entre agents",
    edits: [
      {
        file: STORE,
        find: "          AND agent_id = ?\n          AND action_hash = ?\n",
        replace: "          AND (agent_id = ? OR 1=1)\n          AND action_hash = ?\n",
      },
      {
        file: POINT,
        find: "    if (grant.agentId !== presented.envelope.agentId) {",
        replace: "    if ((false as boolean) && grant.agentId !== presented.envelope.agentId) {",
      },
      {
        /*
         * LA TROISIÈME COUCHE, et c'est la découverte de ce mutant : **l'identifiant de
         * l'agent entre dans l'empreinte canonique de l'action**. Présenter le grant d'un
         * autre agent change donc l'empreinte, et le prédicat `action_hash` refuse — même
         * avec les deux contrôles d'agent neutralisés. Le mutant n'attrapait rien, et ce
         * n'était pas un trou du kit : la liaison d'agent est protégée trois fois, dont
         * une par un mécanisme qui ne la nomme pas.
         */
        file: POINT,
        find: "    if (grant.actionHash !== presented.envelope.actionHash) {",
        replace: "    if ((false as boolean) && grant.actionHash !== presented.envelope.actionHash) {",
      },
      {
        file: STORE,
        find: "          AND action_hash = ?\n          AND destination_id = ?\n",
        replace: "          AND (action_hash = ? OR 1=1)\n          AND destination_id = ?\n",
      },
    ],
  },

  "consomme-avant-controle": {
    breaks: ["C14"],
    describe: "le grant est consommé AVANT les contrôles : une présentation refusée brûle l'autorité d'autrui",
    edits: [
      {
        file: POINT,
        find: "    const failure = await this.verify(presented, now);\n    if (failure) return failure;",
        replace:
          "    const burned = await this.store.findGrant(presented.grantId);\n" +
          "    if (burned) {\n" +
          "      await this.store.consumeGrant({\n" +
          "        id: presented.grantId,\n" +
          "        agentId: burned.agentId,\n" +
          "        actionHash: burned.actionHash,\n" +
          "        destinationId: burned.destinationId,\n" +
          "        at: now.toISOString(),\n" +
          "        consumedBy: presented.presentedBy,\n" +
          "      });\n" +
          "    }\n" +
          "    const failure = await this.verify(presented, now);\n    if (failure) return failure;",
      },
    ],
  },

  "grant-a-la-volee": {
    breaks: ["C15"],
    describe: "un identifiant de grant inconnu est accepté : l'autorité se fabrique en la demandant",
    edits: [
      {
        /*
         * Un grant synthétique, issu de ce que l'appelant PRÉSENTE — c'est la forme
         * exacte de la faille : le serveur croit l'appelant sur la seule base de ce
         * qu'il affirme. Il faut aussi que la consommation réussisse sur une ligne
         * absente, d'où la seconde édition.
         */
        file: POINT,
        find: '      return refuse("GRANT_NOT_FOUND", `No grant "${presented.grantId}" exists for this tenant.`, null);',
        replace:
          "      return null;",
      },
      {
        file: STORE,
        find: "    const grant = await this.findGrant(input.id);\n    return { claimed: changes === 1, grant };\n  }\n\n  /** Any state → revoked. Used by the sweep and by an operator kill switch. */",
        replace:
          "    const grant = await this.findGrant(input.id);\n" +
          "    return {\n" +
          "      claimed: true,\n" +
          "      grant: grant ?? ({\n" +
          "        id: input.id, actionId: `act_${input.id}`, agentId: input.agentId,\n" +
          "        action: \"synthetique\", actionHash: input.actionHash, destinationId: input.destinationId,\n" +
          "        decision: \"ALLOW\", state: \"consumed\", requestId: null, idempotencyKey: null,\n" +
          "        policyId: null, createdAt: input.at, issuedAt: input.at,\n" +
          "        expiresAt: new Date(Date.parse(input.at) + 60_000).toISOString(),\n" +
          "        consumedAt: input.at, consumedBy: input.consumedBy, approvalId: null,\n" +
          "        approvedAt: null, approvedBy: null, revokedAt: null, revokedReason: null,\n" +
          "      } as GrantRecord),\n" +
          "    };\n  }\n\n  /** Any state → revoked. Used by the sweep and by an operator kill switch. */",
      },
    ],
  },

  "agent-du-corps": {
    breaks: ["C16"],
    describe: "l'agent déclaré dans le corps gagne sur la liaison du credential",
    edits: [
      {
        /*
         * `if (bound)` est l'endroit exact : c'est la branche où la liaison du credential
         * l'emporte. Neutralisée, l'exécution tombe dans le chemin « non lié », qui rend
         * l'agent DEMANDÉ — c'est-à-dire celui du corps de la requête.
         */
        /*
         * LE REFUS LUI-MÊME, remplacé par « l'agent demandé gagne ».
         *
         * Le premier jet neutralisait `if (bound)` tout entier : chaque credential
         * devenait non lié, et le kit n'arrivait plus à établir la prémisse de C16 — son
         * contrôle positif rendait `400 agent_not_declared` et la propriété SKIPPAIT. Un
         * mutant qui empêche la propriété de s'exécuter ne l'éprouve pas, il la masque :
         * « attrapé rien » était exact et ne disait rien.
         *
         * La mutation vise donc exactement la phrase que C16 énonce — la liaison du
         * credential fixe l'agent — en rendant l'agent du corps au lieu de refuser.
         */
        file: BINDING,
        find: "     * caller's own tenant's data and the caller supplied one of them.\n     */\n    return {",
        replace: "     * caller's own tenant's data and the caller supplied one of them.\n     */\n    return { ok: true, agentId: asked, bound: false };\n    return {",
      },
    ],
  },

  /* ---------------------------- C. Approbation ---------------------------- */

  "attente-executable": {
    breaks: ["C18"],
    describe: "un grant en attente d'approbation s'exécute : l'humain est contourné",
    edits: [
      {
        file: STORE,
        find: "          AND state = 'issued'\n",
        replace: "          AND state IN ('issued', 'pending_approval')\n",
      },
      {
        file: POINT,
        find: '    if (grant.state === "pending_approval") {',
        replace: '    if ((false as boolean) && grant.state === "pending_approval") {',
      },
    ],
  },

  "auto-approbation": {
    breaks: ["C20"],
    describe: "un agent approuve son propre grant : l'approbation humaine devient décorative",
    edits: [
      {
        /*
         * La matrice des capacités, source unique. `operator` est le rôle du credential
         * d'un agent : lui donner `approve`, c'est exactement « l'agent s'approuve
         * lui-même ».
         */
        file: ROLES,
        find: '  operator: ["read", "execute"],',
        replace: '  operator: ["read", "execute", "approve"],',
      },
    ],
  },

  "reapprobation-rearme": {
    breaks: ["C21"],
    describe: "approuver à nouveau réarme un grant déjà consommé",
    edits: [
      {
        file: STORE,
        find: "          AND state = 'pending_approval'\n          AND action_hash = ?",
        replace: "          AND state IN ('pending_approval', 'consumed')\n          AND action_hash = ?",
      },
    ],
  },

  "rejet-sans-effet": {
    breaks: ["C22"],
    describe: "un rejet ne change rien : le bouton « rejeter » mentirait",
    edits: [
      {
        file: STORE,
        find: "          SET state = 'revoked', revoked_at = ?, revoked_reason = ?, approved_by = ?\n        WHERE organization_id = ? AND id = ? AND state = 'pending_approval'",
        replace: "          SET revoked_at = ?, revoked_reason = ?, approved_by = ?\n        WHERE organization_id = ? AND id = ? AND state = 'pending_approval'",
      },
    ],
  },

  /* ------------------------------- E. Audit ------------------------------- */

  "approbation-livre": {
    breaks: ["C19"],
    describe: "approuver LIVRE : l'approbation déclenche l'effet au lieu de l'autoriser",
    edits: [
      {
        /*
         * L'approbation dépêche vers l'outil aval, en plus d'armer le grant.
         *
         * LE PREMIER JET SE TROMPAIT DE MÉCANISME : il passait l'état à `consumed`, ce qui
         * empêchait l'exécution ultérieure — donc C19 SKIPPAIT au lieu d'échouer. Un
         * mutant qui empêche la propriété de s'exécuter ne l'éprouve pas, il la masque.
         *
         * C19 mesure une LIVRAISON (Δ=0 à l'approbation), pas un état. Le grant reste donc
         * `issued` — le contrôle positif « puis exec → Δ=+1 » continue de fonctionner — et
         * c'est l'effet qui est avancé. C'est aussi la forme réelle de cette faute dans un
         * produit : confondre « autoriser » et « faire », ce qui retire à l'humain la
         * seule chose qu'il contrôlait — le moment de l'effet.
         *
         * Import dynamique : le service d'autorisation ne connaît pas la passerelle, et
         * c'est précisément la séparation que ce mutant viole.
         */
        file: "server/authority/authorization-service.ts",
        find: '    return { ok: true, reason: "Approved.", grant: result.grant ?? null };',
        replace:
          "    if (result.grant) {\n" +
          "      const { callDownstreamTool } = await import(\"../gateway/tools/mcp-client\");\n" +
          "      const { resolveDestination } = await import(\"./destinations\");\n" +
          "      try {\n" +
          "        await callDownstreamTool({\n" +
          "          tool: result.grant.action,\n" +
          "          arguments: {},\n" +
          "          executionId: `axn_approbation_${result.grant.id}`,\n" +
          "          destination: resolveDestination(result.grant.destinationId, this.env, String(this.org)).destination,\n" +
          "        });\n" +
          "      } catch {\n" +
          "        // L'effet a été TENTÉ : c'est ce que C19 doit voir.\n" +
          "      }\n" +
          "    }\n" +
          '    return { ok: true, reason: "Approved.", grant: result.grant ?? null };',
      },
    ],
  },

  /* ------------------------------- E. Audit ------------------------------- */

  "verification-globale": {
    breaks: ["C33"],
    describe: "la vérification n'est plus cadrée au locataire : chacun voit la chaîne de tous",
    edits: [
      {
        /*
         * Le prédicat de cloisonnement neutralisé, `OR 1=1` gardant le `?` en place : les
         * deux locataires lisent la même chaîne, donc la même tête, et C33 — qui exige
         * des têtes DIFFÉRENTES — tombe.
         *
         * La route lit la chaine PAR LOTS depuis le 21 octobre (`receiptChainBatches`) :
         * le motif vise la lecture des recus positionnes de cette methode -- et non celle,
         * semblable, de `newestReceipts`, qui sert l'ecriture de la chaine. Viser
         * l'ancienne lecture entiere (`listReceiptChain`, que la route n'appelle plus)
         * laissait ce mutant sans effet : `--mutants` l'a montre (« attrape rien »).
         */
        file: STORE,
        find: "          WHERE organization_id = ? AND entry_seq IS NOT NULL\n            ${afterSeq === null",
        replace: "          WHERE (organization_id = ? OR 1=1) AND entry_seq IS NOT NULL\n            ${afterSeq === null",
      },
    ],
  },

  /*
   * `sans-trace` — le mutant que la spec nomme pour C32 : aucune entrée écrite.
   *
   * La barre de C32 est basse et elle est réelle — « `entries: 0` ne passe pas ». Ce
   * mutant la mesure, en rendant une chaîne vide quoi qu'il arrive.
   */
  "sans-trace": {
    breaks: ["C32"],
    describe: "aucune trace n'est lue : la vérification rend une chaîne vide",
    edits: [
      {
        file: STORE,
        /* La route lit la chaîne par lots (`receiptChainBatches`) : c'est elle qu'on vide. */
        find: "  async *receiptChainBatches(size = 1000): AsyncGenerator<ReceiptRecord[]> {",
        replace: "  async *receiptChainBatches(size = 1000): AsyncGenerator<ReceiptRecord[]> {\n    if (true as boolean) return;",
      },
    ],
  },

  /*
   * `verificateur-complaisant` — LE SURVIVANT DÉCLARÉ, et ce n'est pas un aveu d'échec.
   *
   * `breaks: []` mesure une limite que `SPEC.md` énonçait avant que ce mutant existe,
   * dans la « limite assumée » de C32 : « le kit vérifie qu'une trace existe et se
   * vérifie. Il ne peut pas prouver qu'un vérificateur dit vrai — en boîte noire, un
   * vérificateur complaisant passerait. »
   *
   * Ce mutant rend `verifyReceiptChain` toujours favorable, et le kit le déclare
   * CONFORME. C'est exactement ce que la spec prédisait. Le garder dans la liste
   * transforme une phrase de documentation en résultat reproductible — et le jour où une
   * propriété saura l'attraper, ce `breaks` se remplira et ce commentaire devra changer.
   *
   * Pourquoi aucune propriété ne peut l'attraper : il faudrait que le kit FALSIFIE un
   * reçu, donc qu'il écrive dans la base du candidat, donc qu'il exige d'un implémenteur
   * tiers une interface d'altération. Le kit refuse de demander ça — ce serait exiger de
   * chaque candidat une porte que personne ne devrait avoir.
   */
  "verificateur-complaisant": {
    breaks: [],
    describe: "le vérificateur dit toujours oui — LIMITE DÉCLARÉE de C32, inattrapable en boîte noire",
    edits: [
      {
        file: CHAIN,
        /* Le vérificateur incrémental, celui de la route ET de `verifyReceiptChain`. */
        find: "  verdict(): ReceiptChainVerdict {\n",
        replace:
          "  verdict(): ReceiptChainVerdict {\n" +
          "    if (true as boolean) {\n" +
          "      return { ok: true, entries: this.entries, headHash: this.previousHash, brokenAt: null, reason: null };\n" +
          "    }\n",
      },
    ],
  },
};

/* --------------------------- application et retour ------------------------- */

function backupPathFor(file: string): string {
  return path.join(BACKUP_DIR, file.replace(/[/\\]/g, "__"));
}

/** Tous les fichiers que ce module peut toucher. */
export function trackedFiles(): string[] {
  const files = new Set<string>();
  for (const mutant of Object.values(SOURCE_MUTANTS)) {
    for (const edit of mutant.edits) files.add(edit.file);
  }
  return [...files].sort();
}

/**
 * Écrit le manifeste, ou vérifie qu'il concorde.
 *
 * Refuse si un fichier suivi diffère de sa copie d'origine : impossible de distinguer un
 * reste de mutation d'une édition légitime, et il ne faut écraser ni l'un ni l'autre.
 */
export function ensureManifest(): void {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    for (const file of trackedFiles()) copyFileSync(path.join(ROOT, file), backupPathFor(file));
    return;
  }
  const drifted = trackedFiles().filter((file) => {
    const backup = backupPathFor(file);
    if (!existsSync(backup)) return false;
    return readFileSync(path.join(ROOT, file), "utf8") !== readFileSync(backup, "utf8");
  });
  if (drifted.length > 0) {
    throw new Error(
      `.mutation-backup/ existe et ${drifted.length} fichier(s) en diffèrent :\n` +
        drifted.map((f) => `  ${f}`).join("\n") +
        `\n\nSoit une mutation est restée en place, soit ce sont des éditions légitimes — et` +
        `\nce script ne peut pas les distinguer. Restaurez (\`--restore-sources\`) ou videz` +
        `\n.mutation-backup/ en connaissance de cause.`,
    );
  }
  for (const file of trackedFiles()) {
    if (!existsSync(backupPathFor(file))) copyFileSync(path.join(ROOT, file), backupPathFor(file));
  }
}

/** Remet chaque fichier suivi dans son état d'origine, et efface le manifeste. */
export function restoreSources(): void {
  if (!existsSync(BACKUP_DIR)) return;
  for (const entry of readdirSync(BACKUP_DIR)) {
    const target = path.join(ROOT, entry.replace(/__/g, "/"));
    if (existsSync(target)) copyFileSync(path.join(BACKUP_DIR, entry), target);
  }
  rmSync(BACKUP_DIR, { recursive: true, force: true });
}

/**
 * Applique un mutant. Lève si un `find` n'apparaît pas exactement une fois.
 *
 * Ce contrôle est le garde contre le pire mode de panne de ce fichier : une mutation
 * périmée ne s'applique pas, le kit passe, et le tableau annonce « attrapé » pour une
 * propriété que rien n'a cassée. Un faux témoignage, exactement ce que ces mutants
 * existent pour empêcher.
 */
export function applySourceMutant(name: string): void {
  const mutant = SOURCE_MUTANTS[name];
  if (!mutant) {
    throw new Error(`mutant de source inconnu : "${name}". Connus : ${Object.keys(SOURCE_MUTANTS).join(", ")}`);
  }
  ensureManifest();
  for (const edit of mutant.edits) {
    const full = path.join(ROOT, edit.file);
    const text = readFileSync(full, "utf8");
    const count = text.split(edit.find).length - 1;
    if (count !== 1) {
      restoreSources();
      throw new Error(
        `mutant "${name}" : le motif cherché dans ${edit.file} apparaît ${count} fois, il en faut une.\n` +
          `  motif : ${JSON.stringify(edit.find.slice(0, 90))}\n` +
          `  La source a changé depuis l'écriture de ce mutant. Corrigez le motif — ne le\n` +
          `  supprimez pas : une mutation périmée laisse le kit annoncer « attrapé » sans\n` +
          `  avoir rien cassé.`,
      );
    }
    writeFileSync(full, text.replace(edit.find, edit.replace), "utf8");
  }
}
