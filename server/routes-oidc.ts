/**
 * LES DEUX ROUTES DU SSO, et ce qu'elles refusent.
 *
 *   GET /api/auth/sso/start     → renvoie le navigateur chez le fournisseur
 *   GET /api/auth/sso/callback  → reçoit le retour, vérifie, ouvre une session
 *
 * ## Les deux routes sont PUBLIQUES par nécessité
 *
 * Quelqu'un qui se connecte n'a pas encore de session — exiger un credential rendrait la
 * connexion inatteignable. C'est la même nécessité que `/api/auth/login`.
 *
 * Ce qui les protège n'est donc pas un credential Oathrion mais quatre choses, et chacune
 * ferme une porte distincte :
 *
 *   1. **Le `state`**, à usage unique et expirant, émis par `/start` et exigé au retour.
 *      Il prouve que ce retour répond à une demande d'Oathrion. Sans lui, un attaquant
 *      envoie la victime directement sur `/callback?code=…` avec SON code, et la victime
 *      se retrouve connectée AU COMPTE DE L'ATTAQUANT — le CSRF de connexion, qui est
 *      sous-estimé parce que « être connecté chez l'attaquant » a l'air inoffensif
 *      jusqu'à ce qu'on y saisisse quelque chose.
 *   2. **Le `nonce`**, porté par le jeton et vérifié dedans. Il prouve que ce jeton a été
 *      émis pour cette demande-là, et pas capturé ailleurs.
 *   3. **La vérification du jeton** (`identity/oidc-token.ts`) : signature, émetteur,
 *      audience, fraîcheur, et l'attestation d'authentification forte quand elle est
 *      exigée.
 *   4. **La correspondance d'utilisateur** : l'adresse du jeton doit désigner un
 *      utilisateur de console existant. Le provisionnement automatique est désactivé par
 *      défaut — sans ce refus, tout l'annuaire du client aurait un accès à la console de
 *      gouvernance.
 *
 * ## Ce que les réponses ne disent jamais
 *
 * Les refus se ressemblent tous du dehors : un motif générique, et le détail dans les
 * journaux du serveur. Distinguer « cette adresse n'a pas de compte » de « la signature
 * est fausse » donnerait à qui sonde un oracle d'énumération de comptes — le même
 * raisonnement que la page de connexion par mot de passe applique déjà.
 */

import { setSessionCookie } from "./session-cookie";
import type { Express, Request, RequestHandler, Response } from "express";

import { ensureConfiguredPrincipals, loginThrottled, openSession } from "./auth";
import {
  authorizationUrl,
  discover,
  exchangeCode,
  jwksFor,
  oidcConfigFor,
  SSO_CALLBACK_PATH,
  SSO_CLAIM_PATH,
  SSO_START_PATH,
  SSO_STATUS_PATH,
  startLogin,
  stateFingerprint,
  takeLogin,
  type OidcConfig,
} from "./identity/oidc";
import { verifyIdToken } from "./identity/oidc-token";
import { userStore } from "./repositories/users";
import { organizationStore } from "./repositories/organizations";
import { ssoIdentityStore } from "./repositories/sso-identities";
import { issueHandoff, takeHandoff } from "./identity/sso-handoff";

export interface OidcRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
}

/**
 * L'étranglement par adresse, le MÊME que celui de la page de connexion par mot de passe.
 *
 * Pas le limiteur de débit général : `loginThrottled` compte par ADRESSE et son compteur
 * est partagé entre instances, ce qui est ce qu'il faut contre une attaque par force sur
 * une route publique. Réutiliser celui de la connexion plutôt qu'en ajouter un second
 * garde une seule politique d'étranglement à régler.
 */
async function throttled(req: Request, res: Response): Promise<boolean> {
  if (!(await loginThrottled(req.ip ?? "unknown"))) return false;
  res.status(429).json({ error: "login_throttled", message: "Too many attempts. Try again in a minute." });
  return true;
}

/** Le cookie qui lie le retour au navigateur qui a demandé la connexion. */
const STATE_COOKIE = "oathrion_sso_state";

/**
 * L'empreinte de mot de passe d'un compte créé par le SSO.
 *
 * Ce n'est pas une empreinte : c'est une valeur qui n'a pas la forme d'une enveloppe
 * scrypt, donc que `verifyPassword` refuse toujours. Un compte provisionné par le SSO
 * n'a ainsi aucun credential local, et le texte le dit à qui lit la base.
 */
const SSO_ONLY_PASSWORD_HASH = "sso-only:aucun-mot-de-passe-local";

/**
 * Pourquoi un cookie EN PLUS du `state` en mémoire.
 *
 * Le `state` en mémoire prouve qu'Oathrion a émis cette tentative. Le cookie prouve que
 * c'est LE MÊME NAVIGATEUR qui revient. Les deux sont nécessaires : sans le cookie, un
 * attaquant qui obtient un `state` valide — en déclenchant lui-même `/start` et en lisant
 * l'URL — peut faire suivre le lien de retour à la victime.
 *
 * `SameSite=Lax` et pas `Strict` : le retour vient du domaine du fournisseur, et `Strict`
 * n'enverrait pas le cookie sur cette navigation — la connexion échouerait toujours.
 * `Lax` l'envoie sur une navigation de premier niveau, qui est exactement ce cas.
 */
function setStateCookie(res: Response, state: string, secure: boolean): void {
  const parts = [
    `${STATE_COOKIE}=${state}`,
    "Path=/api/auth/sso",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearStateCookie(res: Response, secure: boolean): void {
  const parts = [`${STATE_COOKIE}=`, "Path=/api/auth/sso", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function readStateCookie(req: Request): string | null {
  const header = req.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE) {
      const value = rest.join("=").trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** Le même texte pour tous les refus. Le détail va dans les journaux. */
const REFUSAL = {
  error: "sso_refused",
  message:
    "This sign-in could not be completed. If it should work, ask " +
    "your operator to check the server logs: the exact reason is there.",
} as const;

function refuse(res: Response, reason: string, status = 400): void {
  console.warn(`[sso] sign-in refused: ${reason}`);
  res.status(status).json(REFUSAL);
}

/**
 * INTERDIRE LE STOCKAGE DE CES DEUX RÉPONSES, et c'est un défaut corrigé, pas une
 * précaution décorative.
 *
 * Le rappel SSO est un **GET qui renvoie un jeton de session dans son corps**. Une
 * réponse à un GET est cacheable PAR DÉFAUT : le navigateur peut la garder, et un
 * mandataire d'entreprise placé devant Oathrion — il y en a un dans la plupart des réseaux
 * où Oathrion sera installé — peut la garder aussi. Un jeton de session dans un cache
 * partagé est un jeton que la requête suivante de quelqu'un d'autre peut recevoir.
 *
 * `/start` en a besoin pour une autre raison : sa redirection porte le `state` et le
 * `nonce` dans l'URL. Une redirection mise en cache rejouerait un `state` déjà consommé
 * — donc une connexion refusée sans raison visible — et conserverait un `nonce` qui doit
 * vivre le temps d'une tentative.
 *
 * Posé À L'ENTRÉE du gestionnaire, pour que TOUTES les sorties le portent : les refus,
 * les 404, les 503 et le succès. Un en-tête posé seulement sur le chemin heureux est un
 * en-tête qu'on oublie le jour où l'on ajoute une sortie.
 *
 * `no-store` plutôt que `no-cache` : `no-cache` autorise le stockage et impose seulement
 * une revalidation, ce qui laisse le jeton sur le disque. `private` et `max-age=0` sont
 * là pour les intermédiaires qui ne comprennent pas `no-store`, et `Pragma` pour ceux
 * qui parlent encore HTTP/1.0.
 */
function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  /*
   * `Referrer-Policy: no-referrer` N'EST PAS POSÉ ICI, et c'est délibéré : `security.ts`
   * le pose pour toutes les réponses. Une seconde écriture au même en-tête laisserait
   * croire que cette route a un besoin particulier, et le jour où la valeur globale
   * change, deux endroits en désaccord.
   *
   * L'en-tête compte pourtant beaucoup pour cette route précise — l'URL du rappel porte
   * le code d'autorisation, qu'un `Referer` emporterait vers la page suivante. Le test
   * `oidc-flow` l'affirme donc sur cette réponse-là, quel que soit l'endroit qui le pose.
   */
}

export function registerOidcRoutes(app: Express, deps: OidcRouteDeps): void {
  const { handle } = deps;

  /**
   * GET /api/auth/sso/start — ouvre une tentative et renvoie chez le fournisseur.
   *
   * Rend un 302 pour un navigateur. Le client de console peut aussi lire l'URL en JSON
   * (`?format=json`) quand il préfère piloter la redirection lui-même — ce qui évite
   * qu'une interface à page unique perde son état sur une navigation.
   */
  app.get(
    SSO_START_PATH,
    handle(async (req, res) => {
      noStore(res);
      if (await throttled(req, res)) return undefined;
      let config: OidcConfig | null;
      try {
        config = oidcConfigFor();
      } catch (error) {
        /*
         * Une configuration fausse ne devrait pas arriver ici : `runtimeConfigProblems`
         * refuse le démarrage. Si elle y arrive quand même, on refuse l'appel plutôt que
         * de lever — un 500 sur la page de connexion ressemble à une panne d'Oathrion.
         */
        refuse(res, error instanceof Error ? error.message : String(error), 503);
        return undefined;
      }
      if (!config) {
        /* 404 : sans configuration, cette fonctionnalité n'existe pas. */
        return res.status(404).json({ error: "not_found", message: "SSO is not configured." });
      }

      let resolved: OidcConfig;
      try {
        resolved = await discover(config);
      } catch (error) {
        refuse(res, `discovery failed — ${error instanceof Error ? error.message : String(error)}`, 503);
        return undefined;
      }

      const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
      const login = startLogin(returnTo);
      const secure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
      setStateCookie(res, login.state, secure);

      const url = authorizationUrl(resolved, login);
      if (req.query.format === "json") return res.json({ url });
      return res.redirect(302, url);
    }),
  );

  /**
   * GET /api/auth/sso/callback — le retour du fournisseur.
   *
   * L'ORDRE DES CONTRÔLES EST LA SÉCURITÉ : le `state` et le cookie AVANT tout appel
   * réseau. Échanger le code d'abord ferait de cette route un moyen de faire appeler le
   * fournisseur par Oathrion avec n'importe quel code, autant de fois qu'on veut.
   */
  app.get(
    SSO_CALLBACK_PATH,
    handle(async (req, res) => {
      noStore(res);
      if (await throttled(req, res)) return undefined;
      const secure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
      let config: OidcConfig | null;
      try {
        config = oidcConfigFor();
      } catch (error) {
        refuse(res, error instanceof Error ? error.message : String(error), 503);
        return undefined;
      }
      if (!config) {
        return res.status(404).json({ error: "not_found", message: "SSO is not configured." });
      }

      /*
       * Le fournisseur peut revenir avec une erreur plutôt qu'un code — l'utilisateur a
       * annulé, ou l'IdP a refusé l'authentification forte. On le journalise et on refuse
       * proprement : ce n'est pas une attaque, c'est un parcours qui n'a pas abouti.
       */
      if (typeof req.query.error === "string") {
        clearStateCookie(res, secure);
        refuse(res, `the provider answered with an error: ${req.query.error.slice(0, 120)}`);
        return undefined;
      }

      const state = typeof req.query.state === "string" ? req.query.state : "";
      const cookie = readStateCookie(req);
      if (state === "" || cookie === null || cookie !== state) {
        /*
         * LE REFUS LE PLUS IMPORTANT DE CETTE ROUTE. Sans lui, un attaquant envoie la
         * victime sur `/callback?code=<son code>` et la victime se retrouve connectée au
         * compte de l'attaquant.
         */
        clearStateCookie(res, secure);
        refuse(res, "the URL's `state` does not match this browser's cookie");
        return undefined;
      }

      const login = takeLogin(state);
      clearStateCookie(res, secure);
      if (!login) {
        refuse(res, "the `state` is unknown, expired, or already used");
        return undefined;
      }

      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (code === "") {
        refuse(res, "the callback carries no code");
        return undefined;
      }

      let resolved: OidcConfig;
      let idToken: string;
      try {
        resolved = await discover(config);
        idToken = (await exchangeCode(resolved, code)).idToken;
      } catch (error) {
        refuse(res, `exchange failed — ${error instanceof Error ? error.message : String(error)}`, 503);
        return undefined;
      }

      /*
       * La vérification, avec une seule refetch du trousseau en cas de `kid` inconnu :
       * c'est la rotation de clé, pas une attaque, et refuser sans réessayer ferait
       * tomber toutes les connexions jusqu'à l'expiration du cache. Une seule, parce
       * qu'un `kid` inconnu qui déclencherait un appel réseau à chaque tentative
       * donnerait un moyen de faire marteler le fournisseur depuis Oathrion.
       */
      const verifyWith = async (force: boolean) =>
        verifyIdToken(idToken, {
          issuer: resolved.issuer,
          audience: resolved.clientId,
          nonce: login.nonce,
          keys: await jwksFor(resolved, process.env, force),
          requiredAcr: resolved.requiredAcr,
          requiredAmr: resolved.requiredAmr,
          requireVerifiedEmail: resolved.requireVerifiedEmail,
        });

      let verdict;
      try {
        verdict = await verifyWith(false);
        if (!verdict.ok && verdict.refusal === "unknown_key") verdict = await verifyWith(true);
      } catch (error) {
        refuse(res, `trousseau indisponible — ${error instanceof Error ? error.message : String(error)}`, 503);
        return undefined;
      }

      if (!verdict.ok) {
        refuse(res, `token refused (${verdict.refusal}): ${verdict.detail} [state ${stateFingerprint(state)}]`);
        return undefined;
      }

      /* ---------------- l'utilisateur de console derrière cette adresse ---------------- */

      /*
       * L'ADOPTION D'ABORD. Les comptes de `OATHRION_CONSOLE_USERS` n'existent en base
       * qu'après la résolution de la configuration : sans cet appel, la première connexion
       * SSO après un démarrage était refusée pour « aucun utilisateur de console » — et,
       * avec le provisionnement automatique, elle aurait créé un DOUBLON au rôle le plus
       * faible pour une adresse qui désigne un administrateur configuré.
       */
      ensureConfiguredPrincipals();

      /*
       * L'IDENTITÉ EST `(issuer, sub)`, ET L'ADRESSE N'EST QU'UN ATTRIBUT.
       *
       * La première version de cette route faisait `findByEmail(verdict.email)` et rien
       * d'autre. C'est le raccourci naturel, et son mode de défaillance ne se voit pas en
       * recette : une adresse électronique est RÉATTRIBUABLE dans un annuaire
       * d'entreprise. Un départ, une homonymie, un alias repris par le service
       * informatique — et la nouvelle personne hérite silencieusement du compte de
       * console de l'ancienne, avec son rôle, son organisation et ses approbations en
       * attente. Rien dans les journaux ne le signale, puisque du point de vue d'Oathrion
       * c'est la même adresse qui revient.
       *
       * Le `sub` d'un jeton d'identité est stable et ne se réattribue jamais : c'est ce
       * que la spécification lui demande d'être. On le consulte donc d'abord, et
       * l'adresse ne sert plus qu'à la PREMIÈRE liaison.
       */
      const byEmail = userStore.findByEmail(verdict.email);
      const identity = ssoIdentityStore.resolve(
        resolved.issuer,
        verdict.claims.sub,
        byEmail?.id ?? null,
        verdict.email,
      );

      if (identity.kind === "conflict") {
        /*
         * LE REFUS QUI JUSTIFIE TOUTE LA TABLE. L'adresse désigne un compte déjà lié à un
         * AUTRE `sub` chez le même émetteur : c'est exactement la réattribution
         * d'adresse. Suivre l'adresse donnerait le compte au nouveau venu ; suivre le
         * `sub` créerait un doublon. Les deux sont des décisions d'identité, et aucune
         * n'appartient à du code.
         */
        refuse(
          res,
          `identity conflict: ${verdict.email} points to an account already linked to another ` +
            `provider identity. An administrator must decide — this address has ` +
            `probably changed hands.`,
          403,
        );
        return undefined;
      }

      let user = identity.kind === "bound" ? userStore.findById(identity.userId) : byEmail;

      if (identity.kind === "bound" && identity.emailChangedFrom !== null) {
        /*
         * Un changement d'adresse sur un `sub` connu est légitime — un mariage, un
         * changement de nom. On le suit, et on le JOURNALISE : c'est précisément ce
         * qu'on voudrait pouvoir relire le jour où une question se pose sur ce compte.
         */
        console.warn(
          `[sso] the address of identity ${verdict.claims.sub.slice(0, 8)}… has changed ` +
            `(account ${identity.userId})`,
        );
      }

      if (identity.kind === "bound" && !user) {
        /*
         * La liaison désigne un compte qui n'existe plus : il a été supprimé sans que la
         * liaison le soit. On refuse plutôt que de retomber sur la recherche par
         * adresse — ce repli rouvrirait exactement la porte que la table ferme.
         */
        refuse(res, `the identity is linked to a deleted account (${identity.userId})`, 403);
        return undefined;
      }

      if (!user && resolved.jitProvisioning) {
        /*
         * Le provisionnement à la première connexion, et il est DÉSACTIVÉ PAR DÉFAUT.
         *
         * Avec lui, toute personne de l'annuaire du client obtient un accès à la console
         * de gouvernance — comptes de prestataires et de services compris. L'exploitant
         * qui l'active choisit le rôle, et ce rôle ne peut pas être `admin` : la
         * configuration le refuse.
         *
         * L'utilisateur est créé SANS mot de passe utilisable : il n'y a pas de credential
         * local à deviner, et la seule façon d'entrer reste le fournisseur.
         */
        const organizations = organizationStore.list();
        if (organizations.length !== 1) {
          refuse(
            res,
            `provisioning impossible: ${String(organizations.length)} organizations exist and ` +
              `a token does not say which one. Create the user by hand.`,
          );
          return undefined;
        }
        const created = userStore.ensure({
          email: verdict.email,
          name: typeof verdict.claims.name === "string" ? verdict.claims.name : verdict.email,
          /*
           * AUCUN MOT DE PASSE UTILISABLE, et c'est obtenu par construction plutôt que
           * par une règle à retenir.
           *
           * `verifyPassword` n'accepte qu'une enveloppe `scrypt$N$r$p$sel$empreinte` ;
           * cette valeur n'en est pas une, donc AUCUN mot de passe ne peut jamais la
           * vérifier. Il n'y a pas de credential local à devenir, à deviner ou à
           * réinitialiser : la seule porte d'entrée de ce compte reste le fournisseur.
           *
           * L'alternative — un mot de passe aléatoire — serait un secret de plus à
           * stocker, et un secret qu'un administrateur pourrait réinitialiser en croyant
           * rendre service.
           */
          passwordHash: SSO_ONLY_PASSWORD_HASH,
          passwordSource: "user",
        });
        userStore.grant(organizations[0]!.id, created.id, resolved.jitRole);
        user = created;
        console.warn(
          `[sso] user provisioned on first sign-in: ${verdict.email} ` +
            `(role ${resolved.jitRole})`,
        );
      }

      if (!user) {
        /*
         * Le refus par défaut. Le message rendu est le même que tous les autres : dire
         * « cette adresse n'a pas de compte » donnerait un oracle d'énumération.
         */
        refuse(
          res,
          `no console user for ${verdict.email}. Create one, or enable ` +
            `\`jitProvisioning\` knowingly.`,
          403,
        );
        return undefined;
      }
      if (user.status !== "active") {
        refuse(res, `the user ${verdict.email} is suspended`, 403);
        return undefined;
      }

      /*
       * LA LIAISON EST ÉCRITE ICI, après tous les refus et avant l'ouverture de session.
       *
       * L'ordre compte dans les deux sens. Après les refus, parce qu'une liaison écrite
       * pour un compte suspendu serait une liaison qu'aucune connexion ne pourra plus
       * jamais rafraîchir. Avant la session, parce qu'une session ouverte sans liaison
       * écrite laisserait la connexion SUIVANTE repasser par l'adresse — et le défaut
       * serait revenu, une connexion sur deux.
       */
      ssoIdentityStore.bind({
        issuer: resolved.issuer,
        subject: verdict.claims.sub,
        userId: user.id,
        organizationId: null,
        email: verdict.email,
      });

      /* ---------------- le passage au navigateur, par un ticket ---------------- */

      /*
       * AUCUNE SESSION N'EST CRÉÉE ICI, et c'est le point de la conception.
       *
       * Le fournisseur ramène le navigateur par une NAVIGATION. À cet instant, la console
       * — une application à page unique qui garde son jeton en mémoire — n'existe pas
       * encore : la navigation vient de détruire sa mémoire. Il faut donc remettre le
       * jeton à du JavaScript qui n'est pas encore chargé.
       *
       * La première version rendait le jeton en JSON. Le navigateur affichait alors une
       * page de JSON brut portant un jeton de session : l'utilisateur le voyait, pouvait
       * le copier, et l'URL restait dans son historique. Le mettre dans le fragment
       * (`/#token=…`) n'aurait pas été mieux — c'est littéralement un jeton de session
       * dans une URL.
       *
       * Ce qui voyage dans l'URL est donc un TICKET : opaque, 60 secondes, consommable
       * une fois. C'est exactement ce qu'est un code d'autorisation OAuth, et pour la
       * même raison. Un ticket resté dans l'historique est un ticket déjà dépensé.
       *
       * Et la session naît à l'ÉCHANGE : un onglet fermé entre les deux étapes ne laisse
       * aucune session ouverte derrière lui.
       */
      const ticket = issueHandoff(user.id, login.returnTo);

      if (req.query.format === "json") {
        /*
         * Le mode JSON existe pour les tests et pour un client qui pilote lui-même sa
         * navigation. Il rend le TICKET, jamais un jeton — la seule différence avec le
         * navigateur est qui exécute la redirection.
         */
        return res.json({ handoff: ticket, returnTo: login.returnTo });
      }

      /*
       * Le séparateur dépend de ce que `returnTo` porte déjà. Il est garanti relatif et
       * commençant par `/` par `startLogin`, mais il peut porter une chaîne de requête.
       */
      const target = login.returnTo.includes("?")
        ? `${login.returnTo}&sso_handoff=${encodeURIComponent(ticket)}`
        : `${login.returnTo}?sso_handoff=${encodeURIComponent(ticket)}`;
      return res.redirect(302, target);
    }),
  );

  /**
   * POST /api/auth/sso/claim — échange un ticket contre un jeton de session.
   *
   * UN POST, et pas un GET, pour trois raisons qui tiennent ensemble : la réponse porte
   * un jeton et ne doit pas être cacheable par défaut ; le ticket ne doit pas se
   * retrouver dans une URL une seconde fois ; et un GET serait déclenchable par une
   * balise `<img>` d'un autre site.
   *
   * Le ticket est consommé AVANT l'ouverture de session. Si l'ouverture échoue — compte
   * suspendu dans l'intervalle, organisation désactivée — le ticket est perdu quand
   * même : il n'y a rien à rejouer.
   */
  app.post(
    SSO_CLAIM_PATH,
    handle(async (req, res) => {
      noStore(res);
      if (await throttled(req, res)) return undefined;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = typeof body.handoff === "string" ? body.handoff : "";
      const handoff = takeHandoff(ref);
      if (!handoff) {
        refuse(res, "sign-in ticket unknown, expired, or already exchanged");
        return undefined;
      }

      const user = userStore.findById(handoff.userId);
      if (!user || user.status !== "active") {
        /*
         * Le compte a disparu ou a été suspendu entre le rappel et l'échange. Soixante
         * secondes suffisent à une suspension d'urgence, et c'est exactement le cas où
         * elle doit porter.
         */
        refuse(res, `the account ${handoff.userId} is no longer usable`, 403);
        return undefined;
      }

      const result = openSession(user);
      if (!result.session) {
        refuse(res, `session refused: ${result.failure ?? "unknown"}`, 403);
        return undefined;
      }

      /*
       * Le jeton part dans le CORPS d'un POST — le même chemin que la connexion par mot
       * de passe. Un second mécanisme de transport serait un second endroit où se
       * tromper.
       */
      /* Le même cookie protégé que la connexion par mot de passe (`server/session-cookie.ts`). */
      setSessionCookie(req, res, result.session.token, result.session.expiresAt);
      return res.json({
        token: result.session.token,
        expiresAt: result.session.expiresAt,
        identity: result.session.identity,
        returnTo: handoff.returnTo,
      });
    }),
  );

  /**
   * GET /api/auth/sso/status — le SSO est-il configuré ?
   *
   * L'écran de connexion a besoin de le savoir pour décider d'afficher un bouton. Sans
   * cette route il devrait sonder `/start`, c'est-à-dire ouvrir une tentative de
   * connexion pour répondre à une question d'affichage.
   *
   * Ce que la route divulgue : qu'un SSO est configuré. Pas l'émetteur, pas le client,
   * pas les portées — un nom d'émetteur dirait à un visiteur anonyme quel annuaire
   * l'entreprise emploie.
   */
  app.get(
    SSO_STATUS_PATH,
    handle(async (_req, res) => {
      noStore(res);
      let configured = false;
      try {
        configured = oidcConfigFor() !== null;
      } catch {
        /*
         * Une configuration présente mais invalide compte comme ABSENTE pour l'écran de
         * connexion : afficher un bouton qui mène à un 503 est pire que ne rien
         * afficher. Le démarrage, lui, a déjà refusé — cette branche couvre une
         * configuration changée à chaud.
         */
        configured = false;
      }
      return res.json({ configured });
    }),
  );
}
