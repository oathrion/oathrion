# Kit de conformité — rapport d'exécution

Légende : **PASS** = exécuté et vérifié ici · **SKIP** = non jugeable, avec sa raison ·
**NON ÉPROUVÉ** = vérifié mais sans mutant pour le prouver. Aucun SKIP n'est compté
comme un PASS.

Environnement : Node 22.23.2, SQLite, serveur Express réel sur port éphémère, serveur
MCP local réel derrière Placet.

---

## 1. Contre l'implémentation de référence

```
core      21 PASS · 0 FAIL · 0 SKIP
extended   6 PASS · 0 FAIL · 0 SKIP
VERDICT   CONFORME
```

### Il a d'abord dit INCOMPLET, et c'est ce qui a produit l'étape 1 du pilote

Au premier passage, C32 et C33 étaient en **SKIP** : le chemin d'autorité
(`/api/actions/authorize` → `/api/actions/execute`) rendait un `receiptId` et **ne
nommait aucun enregistrement vérifiable**. `GET /api/executions/:id/audit/verify` vérifie
une AUTRE chaîne, celle des exécutions, dans laquelle le plan d'autorité n'écrit pas.

Un client qui n'utilise que ce plan — le chemin recommandé — n'avait donc, par HTTP,
aucun moyen de vérifier la trace de ses propres actions. Pour un produit dont le journal
chaîné est l'argument principal, c'était le manque le plus coûteux.

La route `GET /api/actions/receipts/verify` a été ajoutée pour cela, avec
`server/test/receipt-chain-verify.test.ts` (11 tests) qui prouve qu'elle **détecte** les
altérations — contenu édité, lien réécrit, reçu retiré, reçus échangés — et pas seulement
qu'elle répond oui. Le verdict est passé de INCOMPLET à CONFORME parce que le produit a
changé, jamais parce que la barre a été baissée.

---

## 2. Les mutants — la moitié qui prouve que l'autre mord

Une propriété n'est tenue que si son mutant la fait tomber. **25 mutants, deux familles.**

### 2.1 Les mutants de proxy — une forme de réponse mutée

Un proxy inverse devant l'implémentation **réelle** : la correction de base vient du
produit, la violation tient en quelques lignes.

| Mutant | Cible | Attrapé | |
|---|---|---|---|
| `defaut-permissif` | C4 | C4 | ✓ |
| `champ-honore` | C6 | C6 | ✓ |
| `anonyme-decide` | C8 | C8, C35 | ✓ |
| `oracle-403` | C27 | C27 | ✓ |
| `sans-drapeau` | C34 | C34 | ✓ |
| `erreur-en-prose` | C35 | C35 | ✓ |

### 2.2 Les mutants de source — un état serveur muté

**Ce que ce rapport déclarait impossible par proxy, et qui est fait.** Les groupes grant
et approbation n'avaient aucun mutant : leur violation est un changement d'**état côté
serveur**, qu'un proxy ne peut pas simuler sans mentir aussi sur le compteur de
livraisons. Onze propriétés étaient **vérifiées mais non éprouvées**.

`conformance/mutants/source.ts` les éprouve par la seule voie honnête : des mutations dans
le code du produit, avec un manifeste sur disque pour qu'un SIGKILL ne laisse pas une
mutation dans l'arbre de travail. **Les noms viennent de `SPEC.md`**, qui les avait écrits
propriété par propriété avant que ce fichier existe — ce qui évite de dessiner les mutants
d'après le code plutôt que d'après la promesse.

| Mutant | Cible | Attrapé | |
|---|---|---|---|
| `rejeu-livre` | C10 | C10 | ✓ |
| `hash-ignore` | C11 | C11 | ✓ |
| `agent-ignore` | C12 | C11, C12, C14 | ✓ |
| `consomme-avant-controle` | C14 | C3, C5, C10, C11, C12, C14, C18, C26, C28, C32 | ✓ |
| `grant-a-la-volee` | C15 | C15 | ✓ |
| `agent-du-corps` | C16 | C16 | ✓ |
| `attente-executable` | C18 | C18 | ✓ |
| `approbation-livre` | C19 | C19 | ✓ |
| `auto-approbation` | C20 | C20 | ✓ |
| `reapprobation-rearme` | C21 | C21 | ✓ |
| `rejet-sans-effet` | C22 | C22 | ✓ |
| `sans-trace` | C32 | C32 | ✓ |
| `verification-globale` | C33 | C33 | ✓ |
| `verificateur-complaisant` | — | rien | **limite déclarée** |

`consomme-avant-controle` est le plus large, et c'est explicable : consommer le grant avant
tout contrôle fait tomber presque tout le plan d'autorité. Le runner n'exige que la cible,
donc un dommage collatéral explicable n'invalide rien.

### 2.3 Les quatre mutants qui ont d'abord survécu, et ce qu'ils ont appris

Aucun n'était un trou du produit. Trois étaient des défauts de **mes mutations**, un était
un défaut d'une **propriété**.

**`rejeu-livre` — ma propre doctrine, non appliquée.** Neutraliser le prédicat
`state = 'issued'` de l'`UPDATE` ne suffisait pas : la comparaison applicative refusait
encore sur `GRANT_ALREADY_CONSUMED`. Mutation **équivalente**, donc « attrapé rien » exact
et muet. La doctrine `also` — une défense en profondeur se retire en entier — était écrite
en haut du fichier et pas appliquée là.

**`agent-ignore` — une troisième couche que personne n'avait nommée.** Les deux contrôles
d'agent neutralisés, le mutant n'attrapait toujours rien : **l'identifiant de l'agent entre
dans l'empreinte canonique de l'action**. Présenter le grant d'un autre agent change donc
l'empreinte, et le prédicat `action_hash` refuse. La liaison d'agent est protégée **trois
fois**, dont une par un mécanisme qui ne la mentionne pas.

**`agent-du-corps` et `approbation-livre` — des mutations qui MASQUAIENT la propriété.**
La première rendait chaque credential non lié : le kit n'arrivait plus à établir la
prémisse de C16, qui SKIPPAIT. La seconde passait l'état à `consumed`, ce qui empêchait
l'exécution ultérieure et faisait SKIPPER C19. Un mutant qui empêche la propriété de
s'exécuter ne l'éprouve pas, il la cache. Les deux visent désormais exactement la phrase
que leur propriété énonce — rendre l'agent demandé au lieu de refuser, et **livrer** à
l'approbation plutôt que changer un état.

**`verification-globale` — une PROPRIÉTÉ trop faible, et c'est la trouvaille.** Le mutant
retire le cadrage par locataire de la lecture des reçus. Les deux locataires voient alors
les mêmes lignes — mais leurs têtes restent **différentes**, parce que la chaîne de A ne
part pas de la genèse de B : la vérification de B **échoue**, sa tête devient nulle, et
« têtes distinctes » était vrai. **C33 décrivait une fuite comme un cloisonnement.**

C33 exige désormais `ok: true` des deux côtés : un locataire qui ne peut plus vérifier sa
propre chaîne n'est pas cloisonné, il est cassé. C'est le kit qui a corrigé le kit, et
`SPEC.md` porte le renforcement.

### 2.4 La limite déclarée, devenue reproductible

`verificateur-complaisant` rend `verifyReceiptChain` toujours favorable, et le kit déclare
l'implémentation **CONFORME**. Son `breaks` est vide : ce n'est pas un échec, c'est la
mesure d'une limite que `SPEC.md` énonçait avant que ce mutant existe, dans la « limite
assumée » de C32 — *« le kit ne peut pas prouver qu'un vérificateur dit vrai ; en boîte
noire, un vérificateur complaisant passerait »*.

Pourquoi aucune propriété ne peut l'attraper : il faudrait que le kit **falsifie un reçu**,
donc qu'il écrive dans la base du candidat, donc qu'il exige d'un implémenteur tiers une
interface d'altération — une porte que personne ne devrait avoir. Le kit refuse de la
demander.

Garder ce mutant dans la liste transforme une phrase de documentation en **résultat
reproductible**. Le jour où une propriété saura l'attraper, son `breaks` se remplira.

### 2.5 Couverture par groupe

| Groupe | Propriétés | Éprouvées par un mutant |
|---|---|---|
| Décision | C1–C8 | C4, C6, C8 |
| Grant | C10–C16 | **toutes** — C10, C11, C12, C14, C15, C16 |
| Approbation | C18–C22 | **toutes** — C18, C19, C20, C21, C22 |
| Isolation | C24–C28 | C27 |
| Audit | C32–C33 | **toutes** — C32, C33 |
| Honnêteté | C34–C35 | C34, C35 |

Il reste **deux propriétés sans mutant** : C2 et C7, toutes deux de niveau étendu.

Elles étaient neuf — C1, C2, C3, C5, C7, C24, C26, C28, et C25 qui n'existe pas dans la
liste des propriétés et que ce rapport citait à tort. Cinq mutants les ont réduites à deux :
`plafond-sans-effet`, `bloque-executable`, `approbation-d-un-autre`, `execution-d-un-autre`
et `listes-qui-fuient`. C5 tombe désormais sous `consomme-avant-controle`, qui la **cible**
par construction — la consommation avant contrôle livre à l'autorisation.

**Deux de ces cinq mutants ont d'abord survécu**, et c'est la partie du travail qui vaut
d'être écrite. `plafond-sans-effet` visait la règle de plafond de `shared/policy/rules.ts`
— mutation équivalente : le fixture n'emploie pas cette règle, il écrit ses seuils en
contraintes `gt` et `lte`. La mutation portait sur du code que la suite n'exécute jamais.
`bloque-executable` rendait un grant BLOCK consommable — mais un BLOCK n'émet aucun grant,
donc la branche mutée était inatteignable ; il a fallu une troisième édition pour que le
BLOCK émette un grant et que la propriété puisse tomber.

Dans les deux cas le kit a eu raison contre l'auteur du mutant. C'est exactement ce à quoi
il sert : **un mutant qui survit accuse d'abord celui qui l'a écrit.**

## 3. Les erreurs du kit, attrapées par le kit

Elles méritent d'être écrites : dans les deux cas, le premier résultat ressemblait à un
verdict sur le produit alors qu'il portait sur l'outil de mesure.

**O1 comptait autre chose.** La première version additionnait `toolExecutionCount` de
`GET /api/tools`. Toutes les propriétés qui mesurent Δ ont échoué sur un **contrôle
positif** — Δ=0 là où une exécution légitime venait d'avoir lieu. Cause : le chemin
d'autorité dépêche en MCP vers une destination et ne passe pas par le registre d'outils
en mémoire. C'est la clause « un contrôle positif qui échoue rend la propriété FAIL » qui
a rendu l'erreur visible ; sans elle, le kit aurait annoncé que le produit ne livre rien.

**Les six mutants ont d'abord été déclarés « attrapé rien ».** Les processus enfants
étaient lancés avec `node` sur un fichier TypeScript : ils mouraient en silence, aucun
fichier de résultat n'était écrit, et le tableau affichait un faux négatif parfait —
exactement ce à quoi ressemblerait un kit creux.

---

## 4. Ce que le kit a trouvé dans le produit

**Un défaut, corrigé.** `GET /api/tools` n'exposait pas `simulated`, le catalogue MCP
portait un `simulated: true as const`, et le **type** `PlacetToolGovernance.simulated` était
le littéral `true` — le système de types encodait la fausse affirmation. Pendant ce temps
`docs/COMMERCIAL_READINESS.md` affirmait que la route « expose le drapeau ». Corrigé, avec
son test, dans le commit « produit: l'inventaire des outils dit enfin la vérité sur la
simulation (C34) ».

**Un manque, corrigé depuis.** Le chemin d'autorité ne nommait aucun enregistrement
vérifiable : `GET /api/actions/receipts/verify` a été ajoutée, avec les onze tests qui
prouvent qu'elle détecte les altérations (§ 1).

**Une limite, constatée et écrite.** Cette vérification ne détecte pas une queue
tronquée — supprimer le dernier reçu laisse le reste cohérent, et rien n'enregistre la
longueur attendue. Fermer cela demande une tête persistée par locataire, le même travail
que la chaîne des exécutions attend. Dans `docs/limitations.md`.

---

## 5. Reproduire

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm ci
npm run conformance              # contre l'implémentation de référence
npm run conformance -- --mutants # les 25 mutants, un processus par passe
```

Un mutant de source écrit dans l'arbre de travail, puis restaure. Si un passage est
interrompu par un SIGKILL, le manifeste `.mutation-backup/` survit et la commande suivante
**refuse de tourner** plutôt que d'écraser quoi que ce soit :

```bash
npm run conformance -- --restore-sources   # remet les fichiers, efface le manifeste
```

Le second est le seul qui ait de la valeur en continu : un kit qui passe contre la
référence ne prouve rien tant qu'on n'a pas montré qu'il échoue contre une implémentation
qui viole la propriété.

---

## 6. Travail restant, par ordre de valeur

1. **Les deux propriétés sans mutant** — C2 (toute décision est une réponse réussie) et C7
   (un champ d'autorité est refusé), toutes deux de niveau étendu. C'est le seul point qui
   empêche encore d'affirmer que le kit mord partout. Les sept autres ont été éprouvées ;
   voir plus haut, y compris les deux mutants qui ont d'abord survécu.
2. **Les neuf propriétés retirées de la v0.2** (C9, C13, C17, C23, C25, C29, C30, C31,
   C36) : elles exigent un état préparé plus riche — seconde destination par organisation,
   credential sacrifiable, TTL déclaré. Travail d'extension, pas de conception.
3. **Publier le kit** sous son propre nom, avec un driver d'exemple, pour qu'un tiers
   puisse l'exécuter contre sa propre implémentation. C'est le but du chantier : faire de
   ces propriétés la définition de « autorisation d'agent correcte » dans la catégorie.
   Le kit est sous **MIT** pour cela — un kit de vérification que seul son éditeur peut
   exécuter ne vérifie rien.

### Ce qui a quitté cette liste

Les deux premiers points de la version précédente sont **faits** : les onze propriétés des
groupes grant et approbation ont chacune leur mutant, et C32/C33 aussi. Le
`verificateur-complaisant` qui y était proposé existe, et il **survit** — non par défaut de
réalisation, mais parce que `SPEC.md` avait prédit qu'aucune propriété en boîte noire ne
peut l'attraper. Voir §2.4.
