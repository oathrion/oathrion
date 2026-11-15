# Pilote — recette par des personnes qui n'ont pas construit Oathrion

**Statut : NON RÉALISÉE.** Aucune personne extérieure n'a encore suivi ce parcours. Une
répétition par l'équipe (`docs/STRESS-TEST-LOG.md` §5.5) a trouvé et fait corriger un
blocage à l'étape 8 ; une séance à blanc de ce kit (§5.15) en a trouvé deux autres, aux
étapes 4 et 8, corrigés et revérifiés dans un navigateur. Une répétition (même procédure, mêmes écrans) ne vaut pas recette :
elle trouve des blocages, elle ne prouve pas qu'un client s'en sort seul.

Ce document est le **kit de séance** : préparer une fois, puis une séance de 45 minutes
par testeur, trois à cinq testeurs, puis une synthèse et une décision. Il ne demande ni
instance hébergée ni domaine : sans eux, la recette se fait **sur le poste de
l'exploitant**, le testeur au clavier (ou en partage d'écran avec prise de contrôle).

---

## 1. Une fois, avant la première séance

| # | À faire | Pourquoi |
|---|---|---|
| 1 | **Reconstruire l'instance locale** sur le code à éprouver, une révision qui contient les correctifs de la séance à blanc (§5.15). Une pile `placet-local` appartient au dossier qui l'a lancée, et `pilot:up` refuse de démarrer si le port est déjà pris — **y compris par la pile elle-même**. Donc : depuis le dossier qui l'a lancée, `npm run pilot:down` (les données sont conservées) ; puis, depuis le dossier du code à éprouver, `npm run pilot:up` (ou `OATHRION_PILOT_PORT=5055 npm run pilot:up`). Noter la révision. | Une image ancienne n'a pas les correctifs. Relevé le 21 octobre : la pile locale tournait sur `74422a2`, sans les correctifs des étapes 4 et 8 de la séance à blanc. Recetter une vieille version mesure une vieille version. |
| 2 | Vérifier : `curl -s http://127.0.0.1:<port>/api/ready` répond `200`. | « C'est parti » n'est pas « ça marche ». |
| 3 | **Dépôt GitHub de test** : celui de `PILOTE-VALIDATION-CONNECTEURS.md` §1 convient (`<compte>/placet-essai`), plus un **second dépôt** du même compte, que le testeur ne doit PAS choisir — c'est sur lui que l'action interdite est tentée. | L'étape 6 exige un dépôt « hors périmètre » réel. |
| 4 | **Un jeton GitHub par séance**, à portée fine, limité à ces deux dépôts, permission *Issues : Read and write*, expiration 1 jour. Créé par l'exploitant juste avant la séance, révoqué juste après. | Le testeur ne crée pas de compte ; un jeton par personne, jamais réutilisé. |
| 5 | **Un agent** : Cursor (`cursor-agent` ou l'éditeur) — seul client MCP vérifié. Sans Cursor : la commande `curl` de l'étape 4 de la console, imprimée. Ne **pas** proposer Claude Desktop : non vérifié. | On ne fait pas éprouver au testeur une compatibilité qu'on n'a pas éprouvée soi-même. |
| 6 | **Recruter trois à cinq testeurs** : des personnes qui pourraient avoir à brancher un agent d'IA dans une équipe (responsable technique, développeur, chef de produit technique), qui n'ont **jamais vu** Oathrion, et au moins une qui n'est pas développeur. | Un seul profil ne dit rien des autres. |
| 7 | **Un observateur** par séance, distinct de l'animateur si possible. Il ne touche pas au clavier. | Noter et aider sont deux rôles incompatibles. |
| 8 | Imprimer, par testeur : la consigne (§3), une grille vierge (§5) et le questionnaire SUS (§6). | — |

---

## 2. Chaque séance — la liste de l'animateur

**Avant** (10 min, sans le testeur) :

1. Créer le jeton GitHub de la séance (§1, ligne 4) ; le garder hors de l'écran.
2. Fermer les onglets et applications inutiles (le navigateur garde d'autres comptes
   connectés ; le testeur ne doit voir qu'Oathrion).
3. Créer l'espace du testeur et son lien d'invitation — **un espace par testeur**, numéroté,
   **depuis le dossier qui a lancé la pile** :

   ```bash
   docker compose -p placet-local -f deploy/docker-compose.local.yml --env-file deploy/placet.local.env \
     exec -e OATHRION_PUBLIC_URL=http://127.0.0.1:<port> placet \
     node dist/workspace-create.cjs --org "Recette 1" --email <adresse du testeur>
   ```

   `-e OATHRION_PUBLIC_URL=…` est **obligatoire** dans la pile locale : sans lui, le lien vise
   le port 5000 du conteneur, pas le port publié sur la machine (`5055` si vous l'avez
   changé) — le testeur tomberait sur une page morte.
4. Ouvrir le lien dans un **onglet neuf**, sans le valider. Démarrer un chronomètre.

**Pendant** (30 min) : §4. **Après** (8 min avec le testeur, 10 min seul) : §6, §7 et §8.

---

## 3. La consigne remise au testeur (une page, rien d'autre)

> Vous avez reçu un lien. Votre but : qu'un agent d'IA puisse lire les issues du dépôt
> GitHub `<compte>/placet-essai`, proposer une issue seulement avec votre accord, et ne
> jamais toucher à un autre dépôt. Le jeton GitHub vous sera donné quand vous le
> demanderez. Vous avez trente minutes. Pensez à voix haute ; si vous êtes bloqué plus de
> deux minutes, dites-le.
>
> Après chaque étape, l'observateur vous demandera une note de facilité de 1 à 7 ; à la
> fin, dix courtes questions. Il n'y a pas de bonne réponse : c'est Oathrion qu'on évalue,
> pas vous.

---

## 4. L'animation — ce qu'on dit, et ce qu'on ne dit pas

**Accueil (2 min), mot pour mot :**

> « Merci. Ce n'est pas vous qu'on teste, c'est le produit : tout ce qui vous bloque est
> un défaut de notre côté. Pensez à voix haute. Je ne vous aiderai pas tout de suite —
> c'est voulu : si vous restez bloqué plus de deux minutes, dites-le et on verra. On note
> ce que vous dites et ce que vous faites, pas qui vous êtes. D'accord ? »

**Relances autorisées** (neutres, n'apportent aucune information) : « Qu'est-ce que vous
cherchez ? » · « Qu'est-ce que vous vous attendiez à voir ? » · « Qu'est-ce que cet écran
vous dit ? »

**Le jeton GitHub** est remis quand le testeur le demande ou arrive à l'étape « Vos
outils ». Le lui remettre n'est pas une aide.

**Ce qui compte comme quoi** (l'observateur note la phrase exacte) :

| Niveau | Définition | Exemple |
|---|---|---|
| **seul** | aucune intervention | — |
| **indice** | une relance autorisée a suffi | « Qu'est-ce que cet écran vous dit ? » |
| **aide** | on a donné une information du produit | « Il faut cocher le dépôt. » |
| **échec** | l'étape n'a pas abouti, même aidé, ou après 8 minutes | — |

Après deux minutes de blocage annoncé : d'abord une relance ; une minute plus tard,
l'aide minimale qui débloque, notée mot pour mot.

---

## 5. Les huit étapes, et la grille de l'observateur

| # | Le testeur doit… | Réussi si | Écran |
|---|---|---|---|
| 1 | ouvrir l'invitation | la page nomme l'espace, l'adresse, le rôle | `/bienvenue` |
| 2 | se connecter à l'espace prévu | il arrive dans le démarrage guidé de **cet** espace, connecté | démarrage, étape 1 |
| 3 | connecter l'outil de test | « Connecté » s'affiche après vérification par GitHub ; une erreur, s'il y en a, dit quoi faire | étape 2 « Vos outils » |
| 4 | régler une politique | `placet-essai` choisi, l'autre dépôt **non** ; écritures « sur approbation » ; la règle apparaît sur l'écran Politiques | étape 3 |
| 5 | brancher l'agent | clé copiée ; configuration MCP (Cursor) ou `curl` collée ; l'agent voit les outils | étape 4 |
| 6 | faire agir l'agent | une lecture, une création d'issue, une action sur l'**autre** dépôt — par l'agent, ou par le scénario de l'étape 5 | Cursor / étape 5 |
| 7 | voir les trois décisions | « Autorisé », « Approbation requise », « Bloqué » ; il approuve la création dans la page | étape 5, Approbations |
| 8 | retrouver le reçu véridique | l'exécution de l'issue créée : décision, approbateur, lien vers GitHub ; celle bloquée : « non tentée » | Exécutions → détail |

Testeur n° ___ · profil ________________ · date ________ · révision Oathrion ________ · observateur ________

| # | Résultat (seul / indice / aide / échec) | Durée | Cible | Facilité (1–7) | Ce qui a débloqué (mot pour mot) | Défaut à corriger (gravité 0–4) |
|---|---|---|---|---|---|---|
| 1 | | | 1 min | | | |
| 2 | | | 2 min | | | |
| 3 | | | 5 min | | | |
| 4 | | | 5 min | | | |
| 5 | | | 10 min | | | |
| 6 | | | 5 min | | | |
| 7 | | | 3 min | | | |
| 8 | | | 3 min | | | |

**La note de facilité (SEQ)**, posée juste après chaque étape, telle quelle : « Sur une
échelle de 1 (très difficile) à 7 (très facile), cette étape a été… ? ». Noter le chiffre,
sans commentaire de l'animateur. Une étape réussie mais notée 3 est un défaut à part
entière : elle *paraît* difficile.

**La gravité d'un défaut**, de 0 à 4 (échelle de Nielsen) : 0 pas un problème · 1 cosmétique ·
2 mineur (hésitation, mot mal compris) · 3 majeur (une aide a été nécessaire) · 4 bloquant
(étape en échec).

**À surveiller en particulier** — observations de la répétition, non corrigées faute de
mesure (`STRESS-TEST-LOG` §5.5) ; noter si elles gênent, et comment :

- l'écran de détail d'une exécution est en anglais, le démarrage en français ;
- l'étape 5 du démarrage ne passe jamais à « fait » ;
- les résultats du scénario disparaissent après un rechargement ;
- ~~un rechargement complet déconnecte~~ : **corrigé** le 27 octobre 2026, la session est
  gardée dans un cookie protégé (`server/session-cookie.ts`). Noter si un rechargement
  déconnecte encore, c'est un défaut ;
- relevé à la séance à blanc (§5.15) : un délai dépassé chez GitHub s'affiche « Autorisée,
  mais le service a refusé » — un délai n'est pas un refus ; la durée affichée dans
  Exécutions (« 36 ms ») ne reflète pas l'attente réelle du service (15 s) ; le « Motif
  technique » est en anglais ; l'introduction de l'étape 5 parle de « préparer une tâche »
  même quand seul GitHub est connecté.

---

## 6. Le questionnaire SUS (3 min, avant le débriefing)

Dix affirmations, toujours dans cet ordre, notées de **1 (pas du tout d'accord)** à
**5 (tout à fait d'accord)**. C'est l'échelle d'utilisabilité la plus utilisée au monde : elle
se compare d'un produit à l'autre et d'une version à l'autre.

1. Je pense que j'aimerais utiliser Oathrion fréquemment.
2. J'ai trouvé Oathrion inutilement complexe.
3. J'ai trouvé Oathrion facile à utiliser.
4. Je pense que j'aurais besoin de l'aide d'une personne technique pour utiliser Oathrion.
5. J'ai trouvé que les différentes fonctions d'Oathrion étaient bien intégrées.
6. J'ai trouvé qu'il y avait trop d'incohérences dans Oathrion.
7. J'imagine que la plupart des gens apprendraient à utiliser Oathrion très rapidement.
8. J'ai trouvé Oathrion très lourd à utiliser.
9. Je me suis senti(e) en confiance en utilisant Oathrion.
10. J'ai eu besoin d'apprendre beaucoup de choses avant de pouvoir utiliser Oathrion.

**Le calcul** : pour les questions impaires, note − 1 ; pour les paires, 5 − note ; additionner
les dix, multiplier par 2,5. Le score va de 0 à 100.
**Lecture** : < 50 inacceptable · 50–67 passable · **68 = moyenne du marché** · ≥ 80 excellent.
La question 4 se lit aussi seule : c'est elle qui dit si une personne non technique s'y
sent capable.

---

## 7. Le débriefing (5 min, avec le testeur)

Cinq questions, dans cet ordre, réponses notées mot pour mot :

1. « En une phrase, qu'est-ce qu'Oathrion a fait pendant ces trente minutes ? »
2. « À quel moment avez-vous été le moins sûr de ce qui se passait ? »
3. « Si l'agent avait touché à l'autre dépôt, comment l'auriez-vous su ? »
4. « Qu'est-ce qui vous empêcherait de l'utiliser dans votre équipe la semaine prochaine ? »
5. « Une chose à changer en premier ? »

La question 1 vérifie que le testeur a compris le **modèle** (une décision avant chaque
action, un reçu après) et pas seulement les écrans ; la 3, qu'il fait confiance à la preuve
pour une raison.

---

## 8. Après chaque séance (10 min, sans le testeur)

1. **Révoquer le jeton GitHub de la séance** (GitHub → Settings → Developer settings →
   Personal access tokens). Vérifier qu'il n'apparaît plus.
2. Fermer les issues créées dans `placet-essai` pendant la séance.
3. Recopier la grille et le débriefing dans `docs/recette/seance-<n>.md` (un fichier par
   séance, jamais réécrit). Pas de nom du testeur : son profil suffit.
4. Ne rien corriger entre deux séances d'une même série, sauf un **blocage** (une étape en
   « échec ») — et le dire dans la synthèse : les séances suivantes ne mesurent plus le même
   produit.

L'espace « Recette n » reste en base : il est la trace de la séance. Pour repartir d'une
base vide après la série : `npm run pilot:destroy` — irréversible, et c'est la base de
l'exploitant ; à décider explicitement.

---

## 9. La synthèse et la décision

Tableau à remplir après la série :

| Étape | T1 | T2 | T3 | T4 | T5 | Défauts relevés (gravité) |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |

Gravité d'un défaut : **bloquant** (une étape en échec) · **majeur** (une aide a été
nécessaire) · **mineur** (indice, hésitation, mot mal compris).

**Les chiffres de la série**, par étape :

| Étape | Réussite seul ou indice (%) | Durée médiane / cible | Facilité moyenne (1–7) |
|---|---|---|---|
| 1 … 8 | | | |

Et pour la série : **SUS moyen** ___ /100 · SUS de la personne non technique ___ /100 ·
note moyenne à la question 4 ___ /5.

**Ce qu'il faut corriger d'abord, sans débat** : pour chaque défaut,
`priorité = gravité (0–4) × part des testeurs touchés (0–1) × poids de l'étape`, avec un poids
de 2 pour les étapes 3, 5, 7 et 8 (connecter, brancher l'agent, décider, prouver) et de 1
ailleurs. On corrige dans l'ordre décroissant de ce score. Une étape dont la facilité moyenne
est sous 5,5, ou la réussite sous 80 %, entre dans la liste même sans défaut nommé : il faut
alors revoir la séance pour trouver lequel.

**Critère de recette** : les huit étapes « seul » ou « indice », sans aucune « aide » sur les
étapes 3, 7 et 8 (connecter, décider, prouver). **Cibles chiffrées**, ajoutées le 27 octobre
2026 : SUS moyen ≥ 68, facilité moyenne ≥ 5,5 sur chaque étape, réussite ≥ 80 % par étape.
Elles ne remplacent pas le critère : elles disent de combien on en est loin.

**Décision** :

- **Recette passée** si au moins **trois** testeurs, dont un non-développeur, remplissent le
  critère, et qu'aucun défaut bloquant n'est ouvert.
- **Recette à refaire** sinon : corriger les défauts bloquants et majeurs **dans les écrans
  existants**, puis une nouvelle série d'au moins trois testeurs **nouveaux** (un testeur
  qui a déjà vu Oathrion ne mesure plus la première fois).
- Dans les deux cas, consigner la série dans `docs/FINAL-PILOT-READINESS.md` (ligne « Usage
  humain ») : date, révision, nombre de testeurs, résultat par étape, défauts ouverts.

Ce que la recette ne prouve pas, et qu'il faut écrire à côté du résultat : la connexion en
un clic (OAuth), l'instance hébergée, et tout client MCP autre que Cursor.
