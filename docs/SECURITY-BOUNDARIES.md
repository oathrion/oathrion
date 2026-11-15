# Limites de sécurité — ce qui est protégé, ce qui ne l'est pas

Ce document existe pour qu'une entreprise sache exactement ce qu'elle achète. Il ne
contient aucune affirmation qu'une commande de ce dépôt ne vérifie pas.

---

## 1. Les trois modes, et ils ne sont pas interchangeables

| Mode | Garantie | Ce que ce n'est pas |
|---|---|---|
| **A — Oathrion sur le chemin** : passerelle MCP, `/api/execute`, pare-feu HTTP | Une action refusée **n'atteint pas** l'outil. Ce n'est pas une politique, c'est une propriété du chemin | Conditionné : voir §2 |
| **B — Wrapper dans le code** : `withOathrion`, `placet.requireAllow()` | L'outil **enrobé** ne tourne pas sans ALLOW. Oathrion injoignable lève ; APPROVAL_REQUIRED ne passe pas | **Pas** une interception transparente. Rien n'empêche d'appeler l'original |
| **C — Avis consultatif** : `/api/evaluate` | La décision est autoritative, enregistrée, infalsifiable | **Pas** inévitable. Un client peut ignorer la réponse |

> B et C ne doivent jamais être présentés comme une interception impossible à contourner.

---

## 2. La condition qui porte tout le mode A

> **Le credential du service cible doit vivre dans Oathrion, et nulle part ailleurs.**

Un agent qui détient son propre jeton Stripe appelle `api.stripe.com` directement. Oathrion
ne le voit pas, et **aucun logiciel ne peut l'en empêcher depuis l'intérieur de ce
processus**. Le pare-feu injecte le credential précisément pour que l'agent n'ait rien à
présenter sans passer par lui.

C'est une propriété de **votre déploiement**, pas une garantie du logiciel. Pour la
renforcer :

1. retirer le credential de l'agent et le mettre dans le coffre d'Oathrion — le levier
   principal, disponible aujourd'hui ;
2. restreindre la clé côté fournisseur (GitHub : un jeton à portée fine sur un seul dépôt) ;
3. refuser l'egress de l'agent sauf vers Oathrion — cela appartient à votre VPC.

---

## 3. Chemins qui atteignent un outil, et leur statut

| Chemin | Statut | Vérifié par |
|---|---|---|
| `POST /api/mcp` → `tools/call` | **contrôlé** — un seul chemin vers un outil | `mcp-single-path.test.ts`, `conformance` |
| `POST /api/execute` | **contrôlé** | `gateway.test.ts`, `connector-control-point.test.ts` |
| `POST /api/v1/intercept/…` | **contrôlé** | `verify:intercept` 41/41 |
| `POST /api/actions/*` (grants) | **contrôlé** | `verify:mcp` 37/37 |
| `POST /api/evaluate` | **consultatif** | — |
| `withOathrion` | **contrôlé si l'appel y passe** | 76 tests |
| Appel direct de l'agent à l'API | **non couvert** | — |

Un outil n'est atteignable que par `Tool.execute()`, atteignable seulement par
`AgentGateway.dispatch()`, après un ALLOW. L'ensemble des appelants est **clos et
énuméré** par trois tests qui relisent toutes les sources de `server/` :
`mcp-single-path.test.ts`, `connector-single-path.test.ts`. Une entrée de plus fait
échouer la suite et oblige à écrire pourquoi.

---

## 4. Credentials

| | |
|---|---|
| Au repos | AES-256-GCM, un DEK par valeur, KEK depuis l'environnement. Le locataire est **dans le contexte authentifié** : une enveloppe déplacée dans la ligne d'un autre client ne déchiffre pas |
| Déchiffrement | **un seul appelant**, dans `Tool.run()`, donc **après un ALLOW**. Une requête bloquée ne fait déchiffrer aucun secret |
| Vers le frontend | jamais. Seuls six caractères de SHA-256 du jeton sont affichés |
| Dans les journaux | rédigés (`log-redaction.ts`) |
| Dans l'audit | absents — vérifié par `verify:intercept` et `verify:github` |
| Révocation locale | immédiate, l'enveloppe est écrasée |
| Révocation distante | **impossible** pour un jeton personnel. L'API le dit (`remoteStillValid: true`) |
| `OATHRION_INTERCEPT_KEY_*` | **en clair dans l'environnement**, valable pour tout le déploiement. Plus faible que le coffre ; repli assumé |

---

## 5. Ce qui n'est pas persisté, délibérément

| Donnée | Où elle vit |
|---|---|
| Corps de la requête interceptée, en ALLOW | en mémoire, reprise **une fois**, écrite nulle part |
| Corps d'une requête **en attente d'approbation** | **chiffré** dans `pending_interceptions`, à usage unique, expirant avec l'approbation. Le seul endroit où ce produit persiste un corps, et c'est ce qui rend l'approbation humaine utilisable au-delà d'une minute |
| Corps de la réponse du fournisseur | **idem** — c'était une fuite, trouvée et fermée pendant cette mission |
| Credential du fournisseur | coffre chiffré, jamais dans `toolResult` ni dans l'audit |
| Prompts de l'agent | Oathrion ne les reçoit pas |

Ce qui **est** persisté : verbe, cible, montant évalué, devise, décision, politique, règle
de pare-feu, statut du fournisseur, `responseBytes`, horodatage, identifiant de
corrélation. C'est-à-dire ce sur quoi la décision a porté — et rien d'autre.

---

## 5bis. Le rayon d'explosion d'un agent compromis

Oathrion **borne** les dégâts, il ne les supprime pas. Un agent retourné par une injection
de prompt agit dans les limites qu'on lui a laissées :

```
dégâts maximum = plafond × débit autorisé × temps avant qu'un humain regarde
```

Plafond 500, débit par défaut (300 décisions/min) → **150 000 par minute** sur les routes
déclarées. Personne ne regarde pendant une heure → 9 millions.

Ce chiffre doit être calculé et écrit **avant** le pilote. Les leviers : un seuil
d'`APPROVAL_REQUIRED` bas (le seul qui met un humain dans la boucle),
`maxTransactionAmount` sur le mandat, et `RATE_LIMIT_DECISION` abaissé pour la durée du
pilote.

Ce qu'Oathrion garantit en revanche : l'agent **ne peut pas** choisir le verbe qui le
gouverne (il est extrait de la requête), **ni** la destination (liée à la règle), **ni**
les en-têtes au-delà de ce que la règle autorise, **ni** rejouer une approbation.

## 5ter. L'authentification de la console : mot de passe ou SSO

Deux façons d'obtenir une session, **une seule façon de l'avoir**. Le SSO remplace la
vérification d'identité ; tout ce qui suit — quelle organisation, appartenance suspendue,
TTL, empreinte de credential, signature du jeton — passe par `auth.openSession()`, la même
fonction dans les deux cas.

C'est la propriété qui compte : il n'existe pas deux implémentations de « qui a le droit
d'ouvrir une session et dans quel locataire ». Une session SSO se liste, se révoque et
expire comme les autres, et `oidc-flow.test.ts` le vérifie en la révoquant.

### Ce qui protège les deux routes publiques du SSO

`/api/auth/sso/start` et `/api/auth/sso/callback` ne peuvent pas exiger de credential :
quelqu'un qui se connecte n'en a pas encore. Quatre contrôles les protègent, et chacun
ferme une porte distincte.

| contrôle | ce qu'il empêche |
|---|---|
| **`state` à usage unique + cookie `HttpOnly`** | le **CSRF de connexion** : un attaquant envoie la victime sur `/callback?code=<son code>` et la victime se retrouve connectée AU COMPTE DE L'ATTAQUANT. Sous-estimé parce que ça a l'air inoffensif jusqu'à ce qu'elle y saisisse quelque chose |
| **`nonce` dans le jeton** | le rejeu d'un jeton capturé ailleurs |
| **la vérification du jeton** | `alg: none`, la confusion d'algorithme, un autre émetteur, une autre audience, un jeton périmé ou daté du futur, un `kid` inconnu |
| **la correspondance d'utilisateur** | sans elle, **tout l'annuaire du client** aurait un accès à la console de gouvernance |
| **`Cache-Control: no-store` + le ticket de passage** | le rappel est un **GET**, et une réponse à un GET est cacheable PAR DÉFAUT. Il rendait un jeton de session dans son corps : le navigateur pouvait le garder sur disque, et un mandataire d'entreprise placé devant Oathrion pouvait le garder **pour tout le monde**. Ce qui voyage est désormais un ticket à usage unique de 60 s, et la réponse interdit son stockage |
| **`azp` quand `aud` est multiple** | un jeton émis **à la demande d'une autre application** du même fournisseur, où Oathrion ne figure que comme destinataire secondaire. L'appartenance à `aud` est satisfaite, et pourtant ce n'est pas notre jeton |

Les six sont éprouvés par mutation : retirer l'un fait tomber le test qui porte sa
propriété, et `oidc-token.test.ts` fabrique de vrais jetons tordus avec de vraies clés —
pour les **neuf** algorithmes annoncés, pas pour deux d'entre eux.

### L'IDENTITÉ EST `(issuer, sub)`, ET L'ADRESSE N'EST QU'UN ATTRIBUT

La correspondance d'utilisateur se faisait par **adresse électronique**, et par elle
seule. C'est le raccourci naturel, et son mode de défaillance ne se voit pas en recette :
une adresse est **réattribuable** dans un annuaire d'entreprise — un départ, une
homonymie, un alias repris par le service informatique.

Le jour où cela arrive, la nouvelle personne héritait **silencieusement** du compte de
console de l'ancienne : son rôle, son organisation, ses approbations en attente. Rien ne
le signalait, puisque du point de vue d'Oathrion c'est la même adresse qui revient.

Le `sub` d'un jeton d'identité est stable et ne se réattribue jamais — c'est ce que la
spécification lui demande d'être. La paire `(issuer, sub)` est donc la clé, et trois
situations deviennent distinguables au lieu d'une :

| situation | ce qu'Oathrion fait |
|---|---|
| `sub` connu, adresse changée | suit le `sub`, **journalise** le changement. C'est un mariage, pas une attaque |
| adresse connue, `sub` inconnu, compte déjà lié | **REFUSE.** C'est la réattribution d'adresse, et trancher serait un choix arbitraire sur une question d'identité |
| liaison vers un compte supprimé | **REFUSE**, sans repli sur l'adresse — ce repli rouvrirait la porte exactement le jour où l'on y tient le moins |

Les deux unicités — une identité ne désigne qu'un compte, un compte n'a qu'une identité
chez un émetteur — sont posées par la **base** et non par l'application : deux connexions
simultanées lisent toutes les deux « aucune liaison » avant que l'une ait écrit.

### L'EXCEPTION HTTP EST BORNÉE À LA BOUCLE LOCALE, ET REFUSÉE EN PRODUCTION

`OATHRION_OIDC_ALLOW_HTTP=1` levait bien plus que son nom n'annonce : il sautait la
validation de destination **en bloc** et posait `allowPrivate: true` sur l'échange de code
— l'appel qui transporte le `clientSecret`. Un `issuer` en `http://169.254.169.254`, le
service de métadonnées des hébergeurs, suffisait à faire d'Oathrion un client HTTP pointé
sur le réseau interne, **porteur d'un secret**.

Trois bornes désormais : l'hôte doit être la boucle locale (`127.0.0.0/8` en entier), la
décision est prise sur la **cible réelle de chaque appel** et non sur la présence du
drapeau, et `NODE_ENV=production` avec ce drapeau **refuse le démarrage** — refus posé
avant l'analyse de la configuration, pour qu'une autre faute ne le masque pas.

### LE MFA N'EST PAS IMPLÉMENTÉ PAR OATHRION, IL EST EXIGÉ

C'est le fournisseur qui fait l'authentification forte. Oathrion peut en demander la preuve
(`acr`/`amr`) et **refuser sans elle**. Dire « nous avons le MFA » en se contentant
d'accepter ce que l'IdP envoie serait le faux statut que ce document refuse partout
ailleurs ; exiger l'attestation est vérifiable, et un fournisseur muet fait refuser
l'accès.

### Ce qu'Oathrion NE GARDE PAS du fournisseur

Ni le jeton d'accès, ni le jeton de rafraîchissement. Oathrion n'appelle aucune API au nom
de l'utilisateur : il lui faut une preuve d'identité, une fois. Les garder serait stocker
un credential sans usage — un risque sans bénéfice.

Un compte créé par le provisionnement automatique n'a **aucun mot de passe utilisable** :
sa valeur stockée n'a pas la forme d'une enveloppe scrypt, donc aucun mot de passe ne peut
la vérifier. La seule porte d'entrée de ce compte reste le fournisseur.

### Limites assumées

**Un utilisateur appartenant à plusieurs organisations ne peut pas se connecter par SSO**
sans dire laquelle : un jeton ne porte pas le locataire, et deviner placerait quelqu'un
dans le mauvais. Il se connecte par mot de passe, où le choix est explicite.

**L'état d'une tentative vit en mémoire.** Derrière deux instances sans affinité de
session, le retour du fournisseur peut atterrir sur l'instance qui n'a pas émis l'état, et
la connexion est refusée. C'est le sens sûr — un état inconnu ne doit jamais être accepté
— mais c'est une contrainte de déploiement, pas un détail.

---

## 6. Sortie réseau

Tout appel sortant passe par **un seul** transport (`sendGuarded`) :

* allowlist de destinations explicite — pas de proxy ouvert ;
* règles d'adresse anti-SSRF appliquées **au niveau de la socket**, le seul endroit qu'une
  réattribution DNS ne peut pas gagner ;
* **les redirections ne sont pas suivies** : un hôte validé répondant `302 Location:
  http://169.254.169.254/` n'atteint pas le service de métadonnées ;
* réponse bornée en taille ;
* **les en-têtes relayés sont une liste d'AUTORISATION par règle** (défaut `content-type`,
  `accept`). C'était une liste de refus, et `Stripe-Account: acct_autre` permettait donc à
  un agent d'**agir sur un autre compte Stripe Connect** sans qu'aucune règle le voie ;
* `authorization`, `cookie`, `host`, `accept-encoding` et les en-têtes de transport sont
  refusés **même quand une règle les nomme** — le serveur refuse de démarrer et le dit ;
* le corps part **brut**, octet pour octet : le re-sérialiser cassait les API
  form-encoded (Stripe) et perdait l'ordre des clés et la précision numérique.

Une destination d'interception doit être déclarée dans `OATHRION_DESTINATIONS` et visible
pour ce locataire. Une route qu'aucune règle ne reconnaît est **refusée**, pas transmise.

---

## 7. Limites connues, en clair

1. **Un agent avec ses propres credentials n'est pas gouverné.** §2.
2. **`/api/evaluate` ne force rien.**
3. **Le trafic refusé à la porte du pare-feu est compté, pas tracé ligne à ligne** —
   il n'atteint pas le moteur, donc il n'y a pas de décision à enregistrer.
4. **Oathrion ne résout pas l'injection de prompt.** Aucune couche d'autorisation ne le
   fait. Il borne le rayon d'action : un plafond de remboursement tient que l'agent ait
   été trompé ou non.
5. **La vérification de schéma MCP compare des noms, pas des types.**
6. **Un serveur MCP sans `tools/list` n'est pas vérifiable** — le reçu le dit.
7. **Pas de déduplication chez le fournisseur** : un grant consommé une fois n'est pas un
   effet tiers exactement une fois. Si la réponse se perd, Oathrion voit un échec là où
   l'effet a eu lieu.
8. **Le pare-feu traite JSON, form-encoded, multipart et les flux.** Tous relayés
   **bruts** et testés — y compris un corps binaire octet pour octet (§3quater de
   `firewall.md`). La contrainte qui reste : un corps multipart n'est pas ANALYSÉ, donc la
   cible d'une telle règle doit venir de l'URL, de la chaîne de requête ou d'un en-tête.
9. **Le SSO par OIDC existe** (§5ter). Ce qui n'existe pas : **SAML**, qu'exigent encore
   certains grands comptes. Le **consentement OAuth dans le navigateur** existe pour les
   connecteurs **Slack et Linear** (`server/connectors/oauth-install.ts`), à condition que
   l'exploitant ait enregistré les applications ; il n'existe ni pour GitHub (jeton à
   portée fine), ni pour la voie pare-feu, dont le **rafraîchissement OAuth** part d'un
   jeton obtenu hors d'Oathrion et **n'a jamais été éprouvé contre un vrai fournisseur**.
10. **La révocation distante n'existe que pour Slack et pour une connexion Linear OAuth.**
    « Déconnecter » appelle `auth.revoke` (Slack) ou `/oauth/revoke` (Linear) et ne dit
    « neutralisé » que si le service l'a confirmé. Un jeton GitHub, une clé Linear
    personnelle ou une clé de destination du pare-feu restent valides chez le fournisseur.

---

## 8. Ce qu'un auditeur peut vérifier lui-même

```bash
npm run conformance -- --mutants   # 27 propriétés, 25 mutants qui les mordent
npm run verify:intercept           # le pare-feu, devant une API qui compte ce qu'elle reçoit
npm run verify:prod-config         # 41 configurations dangereuses, refusées une par une
npm run verify:erasure             # l'effacement emporte le coffre
```

Le kit de conformité est la pièce qui compte : **une propriété n'est tenue que si son
mutant la fait tomber.** Vingt-cinq mutants, tous attrapés — c'est-à-dire que les
vingt-sept propriétés mordent vraiment.
