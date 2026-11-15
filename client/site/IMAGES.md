# Les images du site

Quatre photographies et une image d'aperçu. Elles vivent dans `client/public/img/`, donc
Vite les copie telles quelles dans `dist/public/img/` et le serveur les sert à `/img/…`.

## Ce qu'elles sont, et pourquoi elles le sont

Le brief écartait « illustrations génériques, photos de banque d'images, robots humanoïdes,
cerveaux numériques, images IA génériques, simples dégradés ». Ces quatre-là ne sont pas
employées comme **sujet** — aucune ne raconte quoi que ce soit, aucune ne peut donc promettre
quelque chose qu'Oathrion ne fait pas. Elles sont employées comme **matière** : une surface
sombre et hors foyer, derrière le contenu, qui donne au fond une profondeur qu'un dégradé CSS
n'atteint pas. Le composant `Backdrop` dans `components/Shell.tsx` impose les trois règles qui
les rendent inoffensives, et `shell.css` les explique.

| fichier       | ce que c'est                          | où elle sert                           |
| ------------- | ------------------------------------- | -------------------------------------- |
| `ribs.jpg`    | nervures bleu-sarcelle, lumière rasante | Hero de l'accueil                    |
| `mesh.jpg`    | maille filaire très sombre            | section « Governance lifecycle »       |
| `sphere.jpg`  | sphère de particules sur noir         | section « join »                       |
| `stage.jpg`   | une membrane de treillis dans le vide | Hero de `/pricing`                     |
| `core.jpg`    | un noyau lumineux qui émet un faisceau | Hero de `/developers`                 |
| `held.jpg`    | une action suspendue, et quelqu'un qui la regarde | Hero de `/pilot` et `/product` |
| `vault.jpg`   | des structures sombres et fermées     | Hero de `/use-cases`                   |
| `chain.jpg`   | une chaîne dont un maillon est rompu  | Hero de `/security`                    |
| `void.jpg`    | la membrane, minuscule, très loin     | Hero de `/about` et la page 404        |
| `horizon.jpg` | une file de polyèdres vers l'horizon  | Hero de `/roadmap`                     |
| `field.jpg`   | un champ de points lumineux           | Hero de `/waitlist`                    |
| `flow.jpg`    | schéma du trajet, **réparé ici**      | figure d'ouverture de `/how-it-works`  |
| `og.jpg`      | **fabriquée ici**, pas téléchargée    | `og:image` / `twitter:image`           |

`violet.jpg` a été supprimée. C'était le « simple dégradé » que le brief refusait, et elle
a été remplacée par `field.jpg` sur `/waitlist`. C'est la seule image qu'on ait jamais
retirée du site, et elle avait été signalée comme la plus faible dès son arrivée.

## La variante `--left` ne sert presque jamais

Elle concentre l'image en haut à GAUCHE. Or **tous** les Heros du site ont leur titre à
gauche : employer `--left` revient à poser la matière exactement sous le texte. Le voile
directionnel protège encore la lisibilité, mais la structure se bat avec les lettres, et
cela se voit immédiatement à l'écran. Elle n'est juste que lorsque le contenu est à droite
— ce qui, aujourd'hui, n'arrive sur aucune page. Constaté sur `/security` et `/use-cases`,
en regardant, pas en lisant le code.

## Provenance et licence

Les quatre photographies viennent d'**Unsplash**, sous la [licence
Unsplash](https://unsplash.com/license) : usage commercial permis, aucune attribution exigée.
Les images **Unsplash+** (`plus.unsplash.com/premium_photo-…`) ont été délibérément exclues du
choix — elles sont payantes et n'ont pas la même licence.

| fichier      | identifiant Unsplash              |
| ------------ | --------------------------------- |
| `ribs.jpg`   | `photo-1734832360215-acbe837f2353` |
| `mesh.jpg`   | `photo-1714548529197-537c1f0b6aa7` |
| `sphere.jpg` | `photo-1645262748907-6827d43215d4` |

## Les rendus générés

`stage`, `core`, `held`, `vault`, `chain`, `void` viennent de la même séance de rendu que
le film de lancement, avec la même caméra et la même lumière — c'est pour cela qu'elles
vont ensemble sans retouche. `horizon` et `field` ont été générées séparément.

Deux images reçues dans la même livraison ont été **écartées** : des rendus de produit sur
un socle, avec sol réfléchissant et halo de néon. Elles sont bien faites, mais elles
n'appartiennent pas au monde du site — pas de socle, pas de sol, pas de reflet nulle part
ailleurs. Les employer aurait introduit un deuxième langage visuel à côté du premier.

## `og.jpg` — fabriquée, pas trouvée

Un aperçu de lien doit ressembler à la page qu'il annonce. `og.jpg` est donc un recadrage
1200 × 630 de `ribs.jpg`, voilé depuis la gauche, sur lequel sont cuits le mot-marque, le titre
de l'accueil et une ligne qui ne promet rien de plus que ce que le produit fait.

Le titre est composé dans **Bricolage Grotesque** — la vraie fonte d'affichage du site, pas un
substitut : un aperçu composé dans une autre fonte donne au lecteur une première impression
qui ne correspond à aucune page. Le fichier `.ttf` a été récupéré depuis Google Fonts le temps
de cuire l'image et **n'est pas livré dans le dépôt** ; pour refaire l'image il faut le
reprendre. La recette complète est dans l'historique du commit qui ajoute ce fichier.

## Remplacer une image

Déposer le fichier dans `client/public/img/`, puis changer le `src` dans la page concernée.
Rien d'autre : le cadrage, le voile, le fondu vers le fond et la variante mobile sont dans
`shell.css`, pas dans le fichier. Garder le même format — très sombre, hors foyer, sans sujet
reconnaissable — sinon le voile ne suffira plus à protéger le texte.

## `flow.jpg` — fournie, puis réparée

Ce schéma a été fourni tel quel. Il portait trois défauts qu'aucun recadrage ne corrige,
et dont le premier est disqualifiant pour une page publique :

1. **Le nom du produit était mal orthographié.** Le A de PLACET n'avait pas de barre : cela
   se lisait « PLΛCET ». Les A de « AI AGENT », juste à côté, étaient corrects — c'était
   donc bien un défaut de l'image, pas un parti pris typographique.
2. **« AI AGENT » apparaissait trois fois** : en titre, en légende sous l'orbe, et une
   troisième fois en très petit.
3. **Trois des contrôles nommés autour du noyau étaient des doublons** — POLICY, MANDATE et
   RISK répétés. Sur une page qui affirme « huit contrôles, dans cet ordre », montrer
   quatre contrôles dont trois en double est une imprécision que le produit ne se permet
   nulle part ailleurs.

Le mot-marque a été recomposé dans **Bricolage Grotesque**, les deux libellés en trop
effacés, et les trois pastilles **renommées** plutôt que supprimées : EXECUTION, APPROVAL
et AUDIT. L'image nomme désormais sept des huit contrôles — le huitième, DECISION, est déjà
écrit à droite comme résultat.

Les zones effacées ne sont pas remplies d'un aplat : un aplat laisse un rectangle visible
dès que le fond varie, et il varie partout. Chaque zone est reconstruite en prolongeant le
dégradé qui l'entoure. Le style des pastilles redessinées — remplissage, bord, hauteur de
capitale, couleurs — a été relevé au pixel sur les pastilles d'origine, et leur texte est
composé en **Geist**, la fonte de texte du site.

Le script complet est dans l'historique du commit qui ajoute ce fichier. Pour refaire
l'opération il faut reprendre les deux `.ttf` depuis Google Fonts : ils ne sont pas livrés.

C'est une **figure**, pas un fond : elle contient du texte, donc elle est encadrée, à pleine
opacité, jamais voilée, et son `alt` répète ce qu'elle dit — sinon un lecteur d'écran perd
les sept contrôles nommés et la décision rendue.
