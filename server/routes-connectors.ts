/**
 * Les routes des connecteurs : connecter, tester, décrire, révoquer.
 *
 * ## CE QUE CES ROUTES NE FONT PAS, ET C'EST LA PROPRIÉTÉ CENTRALE
 *
 * Aucune d'elles n'exécute une action d'agent. Elles configurent, et c'est tout. Un
 * `github.issue.create` ne passe jamais par ici : il passe par `POST /api/execute` ou par
 * `POST /api/mcp`, donc par `AgentGateway.dispatch()`, donc après une décision.
 *
 * Exposer une route « exécuter cette opération du connecteur » serait le second chemin
 * que tout ce dépôt existe pour ne pas avoir : la politique, le mandat, la file
 * d'approbation, la revendication atomique de l'exécution et la chaîne d'audit
 * s'appliqueraient aux appelants de la passerelle et pas à ceux-là.
 * `server/test/connector-single-path.test.ts` le vérifie en relisant ce fichier.
 *
 * ## Le jeton entre et ne ressort pas
 *
 * `POST /api/connectors/:id/connect` est la seule route qui reçoit un secret. Elle le
 * vérifie CONTRE LE SERVICE, puis le scelle. Aucune autre route n'accepte un secret, et
 * aucune — y compris celle-ci — ne rend un jeton, une enveloppe, ni même sa longueur.
 *
 * ## `manage` partout, y compris pour tester
 *
 * Tester une connexion consomme le quota du jeton du client chez le fournisseur et
 * révèle le compte auquel il appartient. Ce n'est pas une lecture : c'est une action
 * d'administration qui se sert du credential. La capacité `read` ne suffit pas.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireIdentity } from "./auth";
import { listDestinationsFor, resolveDestination } from "./authority/destinations";
import { fingerprintOf, lookupConnector, VaultUnavailableError } from "./connectors";
import type { ConnectorPlane } from "./connectors";
import {
  guardrailPolicies,
  guardrailShape,
  GuardrailError,
  readSelection,
} from "./connectors/guardrails";
import {
  CONNECTOR_OAUTH_CALLBACK_PATH,
  exchangeCode,
  oauthConfigProblems,
  oauthProviderFor,
  startInstall,
  takeInstall,
  writeOAuthSecret,
} from "./connectors/oauth-install";
import type { AgentRepository, PolicyRepository } from "./repositories/types";
import type { EmitInput } from "./notifications";
import { reconcileAlert, reconcileOnce } from "./connectors/reconcile";
import { CONNECTOR_CATALOG } from "./connectors";
import { doorsVerdict, type Door } from "@shared/agent-doors";
import { lookupAction } from "@shared/policy/actions";
import type { Agent } from "@shared/types";
import type { OrganizationId } from "@shared/tenancy";

export interface ConnectorRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  fail: (res: Response, status: number, message: string, code?: string) => void;
  param: (req: Request, name: string) => string;
  requireCapability: (capability: "read" | "execute" | "approve" | "manage") => RequestHandler;
  writeRateLimit: RequestHandler;
  /** Le plan des connecteurs du locataire de la requête. */
  planFor: (req: Request) => ConnectorPlane;
  /**
   * Le plan d'une organisation NOMMÉE. Seul le retour OAuth s'en sert : la requête de
   * retour n'est pas authentifiée, l'organisation vient du `state` émis par une session
   * qui, elle, l'était.
   */
  planForOrganization: (organizationId: OrganizationId) => ConnectorPlane;
  /** Les politiques du locataire de la requête : le choix des ressources y est écrit. */
  policiesFor: (req: Request) => PolicyRepository;
  /** Les agents du locataire de la requête : les portes appartiennent à l'un d'eux. */
  agentsFor: (req: Request) => AgentRepository;
  /** Cette exécution existe-t-elle DANS l'organisation de la requête ? (réconciliation) */
  executionExists: (req: Request, executionId: string) => Promise<boolean>;
  /** Émet une notification sur les canaux de l'exploitant (webhook, Slack). */
  notify: (input: EmitInput) => void;
  /** Le nom d'une organisation, pour une alerte lisible par l'exploitant. */
  organizationName: (organizationId: OrganizationId) => string;
}

/** Le cookie qui lie le retour OAuth au navigateur qui a cliqué « Connecter ». */
const INSTALL_COOKIE = "oathrion_connector_state";

function setInstallCookie(res: Response, state: string, secure: boolean): void {
  const parts = [`${INSTALL_COOKIE}=${state}`, `Path=${CONNECTOR_OAUTH_CALLBACK_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=600"];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearInstallCookie(res: Response, secure: boolean): void {
  const parts = [`${INSTALL_COOKIE}=`, `Path=${CONNECTOR_OAUTH_CALLBACK_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function readInstallCookie(req: Request): string | null {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === INSTALL_COOKIE) {
      const value = rest.join("=").trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/**
 * Le retour OAuth répond selon QUI appelle.
 *
 * Le fournisseur renvoie le NAVIGATEUR (navigation de premier niveau, `Accept: text/html`) :
 * il reçoit une redirection vers la console, avec une phrase lisible. Un client d'API — un
 * test, une sonde, un script — reçoit du JSON : la même information, sans page HTML à
 * analyser. `["json", "html"]` dans cet ordre : un `Accept` « tout type » choisit le JSON,
 * un navigateur (html en q=1, tout type en q=0.8) choisit la page.
 */
function answerReturn(req: Request, res: Response, connectorId: string, result: "connected" | "error", reason = ""): void {
  if (req.accepts(["json", "html"]) === "html") {
    res.redirect(302, consoleReturn(connectorId, result, reason));
    return;
  }
  res.status(result === "connected" ? 200 : 400).json({ connector: connectorId, result, ...(reason ? { reason } : {}) });
}

function isSecure(req: Request): boolean {
  return req.protocol === "https" || req.get("x-forwarded-proto") === "https";
}

/**
 * La page de la console où le retour atterrit, avec un résultat lisible. Relative : un
 * paramètre de redirection fourni par la requête ferait de cette route une redirection
 * ouverte.
 */
function consoleReturn(connectorId: string, result: "connected" | "error", reason = ""): string {
  const query = new URLSearchParams({ connector: connectorId, result, ...(reason ? { reason } : {}) });
  return `/console#/onboarding?${query.toString()}`;
}

/** Ce qu'une personne lit quand le fournisseur ou l'échange a échoué. Jamais un jeton. */
function installFailure(provider: string, error: string): string {
  if (error === "access_denied") return `You refused the authorisation in ${provider}. Nothing was connected.`;
  if (error === "invalid_code" || error === "invalid_grant" || error === "bad_redirect_uri") {
    return `${provider} refused the exchange (${error}). Start the connection again; if it happens again, the deployment's ${provider} app is misconfigured.`;
  }
  return `${provider} did not authorise the connection (${error.slice(0, 80)}). Start again.`;
}

/*
 * Les deux schémas du choix de périmètre. `writes` a un défaut délibéré : l'approbation.
 * Un client qui ne choisit rien obtient « chaque écriture attend un humain », jamais
 * « tout passe ».
 */
const selectionSchema = z.strictObject({
  resources: z.array(z.string().trim().min(1).max(200)).max(25),
  writes: z.enum(["approval", "block", "allow"]).default("approval"),
});

/*
 * `strictObject` : un champ inconnu est refusé. Ici cela compte plus qu'ailleurs — un
 * client qui enverrait `organizationId` ou `status` en croyant les choisir doit
 * l'apprendre par un 400, pas découvrir que le serveur les a jetés en silence.
 */
const checkCredentialSchema = z.strictObject({
  secret: z.string().min(1).max(4000),
  /* Facultatif : l'agent dont c'était l'ancienne clé. Le résultat est alors enregistré sur ses portes. */
  agentId: z.string().min(1).max(200).optional(),
});

const declareDoorSchema = z.strictObject({ declared: z.enum(["none", "revoked"]) });

/**
 * Les outils d'un agent : les connecteurs dont au moins un verbe exige une permission que
 * l'agent détient. Lu sur l'agent ENREGISTRÉ, jamais sur la requête.
 */
function agentTools(agent: Agent): { id: string; label: string }[] {
  const granted = new Set(agent.permissions.filter((p) => p.granted).map((p) => p.scope as string));
  return CONNECTOR_CATALOG.filter((c) =>
    c.actions.some((verb) => {
      const scope = lookupAction(verb)?.requiredScope;
      return scope !== null && scope !== undefined && granted.has(scope);
    }),
  ).map((c) => ({ id: c.id, label: c.label }));
}

async function doorsPayload(plane: ConnectorPlane, agent: Agent) {
  const tools = agentTools(agent);
  const records = await plane.doors.list(agent.id);
  const byTool: Record<string, Door> = {};
  for (const record of records) {
    byTool[record.connectorId] =
      record.declared === "none" ? { declared: "none" } : { declared: "revoked", check: record.check ? { state: record.check.state, detail: record.check.detail } : null };
  }
  return {
    agentId: agent.id,
    tools,
    doors: records.filter((r) => tools.some((t) => t.id === r.connectorId)),
    verdict: doorsVerdict(byTool, tools.map((t) => t.id)),
  };
}

const connectSchema = z.strictObject({
  /*
   * 4 000 caractères : largement au-dessus de tout jeton réel (un `github_pat_` fait
   * ~93 caractères) et assez bas pour qu'un corps aberrant soit refusé avant d'atteindre
   * le scellement. Pas de borne minimale au-delà de 1 : décider qu'un jeton est « trop
   * court pour être valide » reviendrait à deviner le format du fournisseur, et c'est au
   * service de le dire.
   */
  secret: z.string().min(1).max(4000),
  /** Optionnel : un libellé pour l'humain. Le compte réel vient du service. */
  account: z.string().trim().max(200).optional(),
});

/**
 * Le credential d'une DESTINATION du pare-feu.
 *
 * Le même schéma que pour un connecteur, sans `account` : il n'y a pas de service pour
 * nommer le compte joint, et un libellé que l'exploitant choisirait lui-même ressemblerait
 * à une information venue du fournisseur.
 */
const destinationCredentialSchema = z.strictObject({
  secret: z.string().min(1).max(4000),
});

export function registerConnectorRoutes(app: Express, deps: ConnectorRouteDeps): void {
  const { handle, fail, param, planFor } = deps;

  /**
   * GET /api/connectors — le catalogue, avec l'état RÉEL de chacun.
   *
   * `read` suffit : rien ici n'utilise un credential ni n'en révèle un. Un opérateur doit
   * pouvoir voir qu'un connecteur est en erreur sans détenir `manage`.
   */
  app.get(
    "/api/connectors",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const described = await planFor(req).describe();
      /*
       * `oauth.available` dit si le bouton « Connecter » en un clic est offert. Le motif
       * d'une indisponibilité (quelles variables manquent) n'est PAS rendu : c'est une
       * information d'exploitant, et la console d'un client n'a pas à lister des noms de
       * variables d'environnement. La documentation de déploiement les nomme.
       */
      res.json(
        described.map((entry) => {
          const provider = oauthProviderFor(entry.id);
          return {
            ...entry,
            oauth: provider
              ? { available: oauthConfigProblems(provider, process.env).length === 0, permissions: provider.permissions }
              : { available: false, permissions: [] },
          };
        }),
      );
    }),
  );

  /**
   * POST /api/connectors/:id/oauth/start — ouvre une tentative et rend l'URL du fournisseur.
   *
   * POST et non GET : c'est un changement d'état (une tentative est créée), et la console
   * l'appelle avec sa session. Le navigateur suit ensuite l'URL rendue.
   */
  app.post(
    "/api/connectors/:id/oauth/start",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      const provider = connector ? oauthProviderFor(connector.id) : undefined;
      if (!connector || !provider) return fail(res, 404, "This service does not connect through authorisation.", "connector_oauth_unknown");
      if (oauthConfigProblems(provider, process.env).length > 0) {
        return fail(
          res,
          409,
          `One-click connection to ${provider.label} is not enabled on this deployment. ` +
            `Use the token connection, or ask your operator to enable it.`,
          "connector_oauth_unavailable",
        );
      }
      const identity = requireIdentity(req);
      const { state, url } = startInstall(provider, identity.organizationId as OrganizationId, identity.name, process.env);
      setInstallCookie(res, state, isSecure(req));
      res.setHeader("Cache-Control", "no-store");
      res.json({ url });
    }),
  );

  /**
   * GET /api/connectors/oauth/callback — le retour du fournisseur. PUBLIQUE par
   * nécessité ; les quatre contrôles sont décrits dans `connectors/oauth-install.ts`.
   *
   * Toutes les sorties redirigent vers la console avec un résultat lisible : une page
   * JSON brute au milieu d'un parcours guidé serait une impasse pour un non-technicien.
   */
  app.get(
    CONNECTOR_OAUTH_CALLBACK_PATH,
    handle(async (req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private, max-age=0");
      const secure = isSecure(req);
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const cookie = readInstallCookie(req);
      clearInstallCookie(res, secure);

      /* 1. Le state est connu, frais, et consommé maintenant. */
      const attempt = state === "" ? null : takeInstall(state);
      if (!attempt) {
        console.warn("[connectors] OAuth return refused: unknown, expired or already used attempt");
        return answerReturn(req, res, "", "error", "This connection attempt expired. Start again from Oathrion.");
      }
      /* 2. Le même navigateur. */
      if (cookie === null || cookie !== state) {
        console.warn("[connectors] OAuth return refused: the state does not match this browser's cookie");
        return answerReturn(req, res, attempt.connectorId, "error", "This connection was not started from this browser. Start again from Oathrion.");
      }
      const provider = oauthProviderFor(attempt.connectorId);
      const connector = lookupConnector(attempt.connectorId);
      if (!provider || !connector) {
        return answerReturn(req, res, attempt.connectorId, "error", "Unknown service.");
      }
      if (typeof req.query.error === "string") {
        return answerReturn(req, res, connector.id, "error", installFailure(provider.label, req.query.error));
      }
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (code === "") {
        return answerReturn(req, res, connector.id, "error", installFailure(provider.label, "missing_code"));
      }

      /* 3. L'organisation vient de la tentative, pas de la requête. */
      const plane = deps.planForOrganization(attempt.organizationId);
      const context = plane.contextFor(connector.id);
      if (!context) return answerReturn(req, res, connector.id, "error", "Unknown service.");

      let token;
      try {
        token = await exchangeCode(provider, code, process.env);
      } catch (error) {
        console.warn(`[connectors] OAuth exchange with ${provider.label} impossible: ${error instanceof Error ? error.message : String(error)}`);
        return answerReturn(req, res, connector.id, "error", `${provider.label} is unreachable. Try again in a moment.`);
      }
      if ("error" in token) {
        return answerReturn(req, res, connector.id, "error", installFailure(provider.label, token.error));
      }

      /* 4. Le jeton obtenu fonctionne-t-il vraiment ? */
      const secret = writeOAuthSecret(token);
      const probe = await connector.verify(secret, {}, context.env);
      if (!probe.ok) {
        return answerReturn(req, res, connector.id, "error", probe.detail);
      }
      try {
        await plane.vault.store({
          connectorId: connector.id,
          secret,
          account: probe.account,
          scopes: probe.scopes,
          connectedBy: attempt.by,
          verified: true,
        });
      } catch (error) {
        if (error instanceof VaultUnavailableError) {
          console.warn(`[connectors] ${error.message}`);
          return answerReturn(req, res, connector.id, "error", "Oathrion cannot save a connection: the encrypted vault is not configured. Contact your operator.");
        }
        throw error;
      }
      await plane.refresh();
      return answerReturn(req, res, connector.id, "connected");
    }),
  );

  /**
   * GET /api/connectors/:id/resources — les dépôts, canaux ou équipes que CETTE connexion
   * atteint, pour que le client choisisse. `manage` : la réponse vient d'un appel au
   * service avec le credential du client.
   */
  app.get(
    "/api/connectors/:id/resources",
    deps.requireCapability("manage"),
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");
      const context = planFor(req).contextFor(connector.id);
      if (!context || !connector.resources) return fail(res, 404, "This service offers no choice of resources.", "connector_resources_unknown");
      const listed = await connector.resources(context);
      if (!listed.ok) return res.status(422).json(listed);
      res.json(listed);
    }),
  );

  /** GET /api/connectors/:id/selection — le choix en vigueur, relu dans les politiques. */
  app.get(
    "/api/connectors/:id/selection",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector || !guardrailShape(connector.id)) return fail(res, 404, "Unknown connector.", "connector_unknown");
      res.json(readSelection(connector.id, await deps.policiesFor(req).list()));
    }),
  );

  /**
   * PUT /api/connectors/:id/selection — écrit le choix sous forme de deux politiques.
   *
   * Les ressources choisies doivent figurer dans ce que le SERVICE a listé pour cette
   * connexion : sinon un client pourrait « choisir » un dépôt que son jeton n'atteint pas
   * et croire son agent limité à quelque chose qui n'existe pas pour lui.
   */
  app.put(
    "/api/connectors/:id/selection",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector || !guardrailShape(connector.id)) return fail(res, 404, "Unknown connector.", "connector_unknown");
      const parsed = selectionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid selection.", "connector_selection_invalid");
      }

      if (parsed.data.resources.length > 0) {
        const context = planFor(req).contextFor(connector.id);
        const listed = context && connector.resources ? await connector.resources(context) : null;
        if (!listed || !listed.ok) {
          return res.status(422).json({
            error: "connector_resources_unavailable",
            message: listed && !listed.ok ? listed.detail : "Could not check the resources with the service.",
          });
        }
        const reachable = new Set(listed.resources.map((r) => r.target.toLowerCase()));
        const unknown = parsed.data.resources.filter((r) => !reachable.has(r.trim().toLowerCase()));
        if (unknown.length > 0) {
          return fail(
            res,
            422,
            `This connection does not reach: ${unknown.join(", ")}. Choose among the listed resources.`,
            "connector_resource_unreachable",
          );
        }
      }

      let policies;
      try {
        policies = guardrailPolicies(connector.id, parsed.data.resources, parsed.data.writes);
      } catch (error) {
        if (error instanceof GuardrailError) return fail(res, 400, error.message, "connector_selection_invalid");
        throw error;
      }
      const repository = deps.policiesFor(req);
      for (const policy of policies) {
        const existing = await repository.findById(policy.id);
        if (existing) await repository.update(policy.id, { ...policy, triggeredCount: existing.triggeredCount });
        else await repository.create(policy);
      }
      res.json({ selection: readSelection(connector.id, await repository.list()), policies: policies.map((p) => p.id) });
    }),
  );

  /**
   * POST /api/connectors/:id/connect — vérifier D'ABORD, stocker ENSUITE.
   *
   * L'ordre est la propriété. Stocker puis vérifier produirait exactement l'écran que ce
   * chantier remplace : une console qui affiche « connecté » parce qu'une ligne a été
   * écrite. Ici, un jeton refusé par le service ne laisse AUCUNE trace dans le coffre.
   */
  app.post(
    "/api/connectors/:id/connect",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");

      const parsed = connectSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(
          res,
          400,
          parsed.error.issues[0]?.message ?? "Invalid connector credential.",
          "connector_credential_invalid",
        );
      }

      const plane = planFor(req);
      const identity = requireIdentity(req);
      const context = plane.contextFor(connector.id);
      if (!context) return fail(res, 404, "Unknown connector.", "connector_unknown");

      const probe = await connector.verify(
        parsed.data.secret,
        { account: parsed.data.account },
        context.env,
      );

      if (!probe.ok) {
        /*
         * 422 et non 400 : le corps était bien formé, c'est le SERVICE qui a refusé. Un
         * 400 ferait chercher l'erreur dans la requête. Le code et le détail viennent du
         * fournisseur, jamais d'une supposition.
         */
        return res.status(422).json({
          connected: false,
          code: probe.code,
          detail: probe.detail,
        });
      }

      try {
        const status = await plane.vault.store({
          connectorId: connector.id,
          secret: parsed.data.secret,
          account: probe.account,
          scopes: probe.scopes,
          connectedBy: identity.name,
          /* Une sonde du fournisseur a réussi juste au-dessus : l'état « connecté » est mérité. */
          verified: true,
        });
        await plane.refresh();
        return res.status(201).json({ connected: true, code: probe.code, detail: probe.detail, status });
      } catch (error) {
        if (error instanceof VaultUnavailableError) {
          /*
           * 503 : la configuration du déploiement manque, la requête était correcte. Le
           * message nomme `OATHRION_KEK`. Oathrion ne stocke pas le credential en clair en
           * attendant mieux — c'est le seul repli qui serait pire que l'échec.
           */
          return fail(res, 503, error.message, "connector_vault_unavailable");
        }
        throw error;
      }
    }),
  );

  /**
   * POST /api/connectors/:id/check-credential — « l'ancienne clé de mon agent est-elle
   * vraiment morte ? »
   *
   * L'étape « fermez les autres portes » de l'ajout d'un agent existant. Un agent qui
   * garde sa propre clé du service a une seconde route : Oathrion ne voit rien passer. La
   * personne révoque cette clé chez le fournisseur, puis la présente ici UNE fois ; le
   * SERVICE dit si elle fonctionne encore (`Connector.credentialAlive`, sans filtre de
   * forme). La clé n'est ni scellée, ni journalisée (le journal ne garde que les
   * réponses, et celle-ci ne la contient pas), ni rendue.
   *
   * Si c'est la clé qu'Oathrion garde lui-même, le service n'est pas appelé : la réponse
   * le dit, pour qu'on ne révoque pas la bonne.
   */
  app.post(
    "/api/connectors/:id/check-credential",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");
      if (!connector.credentialAlive) {
        return fail(res, 422, `${connector.label} does not allow checking an old key.`, "connector_check_unsupported");
      }
      const parsed = checkCredentialSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid credential.", "connector_credential_invalid");
      }
      const context = planFor(req).contextFor(connector.id);
      if (!context) return fail(res, 404, "Unknown connector.", "connector_unknown");

      /*
       * L'agent et l'outil sont validés AVANT toute question au service : une demande qui
       * sera refusée n'a pas à présenter une clé à un tiers.
       */
      let agentId: string | null = null;
      if (parsed.data.agentId) {
        const agent = await deps.agentsFor(req).findById(parsed.data.agentId);
        if (!agent) return fail(res, 404, "No such agent.", "agent_not_found");
        if (!agentTools(agent).some((t) => t.id === connector.id)) {
          return fail(res, 422, `${agent.name} does not use ${connector.label}.`, "agent_tool_mismatch");
        }
        agentId = agent.id;
      }

      const presented = parsed.data.secret.trim();
      /*
       * Par l'EMPREINTE, que le coffre garde en clair : rien n'est déchiffré pour
       * comparer. Six caractères ne prouvent pas l'identité — une collision reste
       * possible —, et c'est pourquoi l'écran ne compte jamais « c'est la clé d'Oathrion »
       * comme une porte fermée (`client/src/lib/agent-doors.ts`).
       */
      const stored = await context.vault.describe(connector.id).catch(() => null);
      /* Un credential révoqué garde son empreinte, mais Oathrion ne le détient plus. */
      if (stored && stored.state !== "revoked" && stored.fingerprint && stored.fingerprint === fingerprintOf(presented)) {
        return res.json({
          state: "placet",
          detail:
            `This is the key Oathrion keeps for ${connector.label}: it is not another door. ` +
            "Do not revoke it — Oathrion acts through it.",
        });
      }
      const liveness = await connector.credentialAlive(presented, context.env);
      /*
       * Le résultat est écrit ICI, et seulement ici : c'est la réponse du service, pas une
       * affirmation de la page. Une clé d'Oathrion présentée par erreur (plus haut) ne
       * s'enregistre pas comme une vérification.
       */
      let recorded = false;
      if (agentId) {
        await planFor(req).doors.recordCheck(agentId, connector.id, liveness, requireIdentity(req).name);
        recorded = true;
      }
      return res.json({ state: liveness.state, detail: liveness.detail, recorded });
    }),
  );

  /**
   * POST /api/connectors/:id/reconcile — ce qui s'est passé chez le service SANS Oathrion.
   *
   * Le connecteur liste les écritures que le service a enregistrées depuis la connexion
   * de l'outil à Oathrion ; la route les classe :
   *
   *   · marque d'Oathrion ET exécution connue dans l'organisation → « via Oathrion » ;
   *   · marque d'une exécution INCONNUE → alerte (marque recopiée, ou venue d'ailleurs) ;
   *   · sans marque, sous l'identité même d'Oathrion → alerte « hors Oathrion » : une autre
   *     clé du même compte, ou une personne — c'est précisément une porte restée ouverte ;
   *   · sans marque, sous un autre compte → compté, jamais jugé (un collègue sur GitHub).
   *
   * Ne bloque rien : la réconciliation arrive APRÈS. Elle rend visible. Un appel de
   * configuration (comme `test`), réservé à `manage`.
   */
  app.post(
    "/api/connectors/:id/reconcile",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");
      const outcome = await reconcileOnce({
        connector,
        plane: planFor(req),
        policies: await deps.policiesFor(req).list(),
        executionExists: (id) => deps.executionExists(req, id),
        trigger: "manual",
      });
      if (!outcome.ok) {
        if (outcome.status === 502) return res.status(502).json({ ok: false, code: outcome.code, detail: outcome.detail });
        return fail(res, outcome.status, outcome.detail, outcome.code);
      }
      /* Une écriture n'alerte qu'une fois, qu'elle soit vue par ce bouton ou par la tâche. */
      if (outcome.fresh.length > 0) {
        const organizationId = requireIdentity(req).organizationId;
        deps.notify(reconcileAlert(organizationId, deps.organizationName(organizationId), connector, outcome.fresh));
      }
      return res.json({ ...outcome.report, newFindings: outcome.fresh.length });
    }),
  );

  /**
   * GET /api/connectors/:id/reconcile — ce que la réconciliation a déjà établi, sans
   * relancer : le dernier passage (bouton ou tâche périodique), et les écritures vues hors
   * d'Oathrion depuis la connexion, chacune avec la date où elle a été vue la première fois.
   */
  app.get(
    "/api/connectors/:id/reconcile",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");
      const store = planFor(req).reconciliations;
      return res.json({ lastRun: await store.lastRun(connector.id), findings: await store.findings(connector.id) });
    }),
  );

  /**
   * GET /api/agents/:id/doors — l'agent a-t-il encore une route qui contourne Oathrion ?
   *
   * Pour chacun de ses outils : ce qui a été déclaré, ce que le service a répondu, et le
   * verdict d'ensemble (`shared/agent-doors.ts`), calculé ici et non par la page.
   */
  app.get(
    "/api/agents/:id/doors",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const agent = await deps.agentsFor(req).findById(param(req, "id"));
      if (!agent) return fail(res, 404, "No such agent.", "agent_not_found");
      return res.json(await doorsPayload(planFor(req), agent));
    }),
  );

  /**
   * PUT /api/agents/:id/doors/:connector — la DÉCLARATION d'une personne : « l'agent
   * n'avait pas de clé » ou « je l'ai révoquée ». Ne pose jamais un résultat de
   * vérification : seule la route `check-credential` le fait, depuis la réponse du service.
   */
  app.put(
    "/api/agents/:id/doors/:connector",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const parsed = declareDoorSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, 'declared must be "none" or "revoked".', "door_declaration_invalid");
      const agent = await deps.agentsFor(req).findById(param(req, "id"));
      if (!agent) return fail(res, 404, "No such agent.", "agent_not_found");
      const connectorId = param(req, "connector");
      if (!agentTools(agent).some((t) => t.id === connectorId)) {
        return fail(res, 422, `${agent.name} does not use this tool.`, "agent_tool_mismatch");
      }
      const plane = planFor(req);
      await plane.doors.declare(agent.id, connectorId, parsed.data.declared, requireIdentity(req).name);
      return res.json(await doorsPayload(plane, agent));
    }),
  );

  /**
   * POST /api/connectors/:id/test — un appel RÉEL au service, maintenant.
   *
   * Le résultat est écrit dans le coffre (`recordCheck`), donc la console affiche la
   * dernière vérité connue et sa date, et non un état figé à la connexion. Un échec ne
   * révoque pas : une coupure réseau n'est pas une révocation.
   */
  app.post(
    "/api/connectors/:id/test",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");

      const plane = planFor(req);
      const context = plane.contextFor(connector.id);
      if (!context) return fail(res, 404, "Unknown connector.", "connector_unknown");

      const existing = await plane.vault.describe(connector.id);
      if (!existing) {
        return fail(res, 409, "This connector is not configured.", "connector_not_configured");
      }

      const probe = await connector.test(context);
      const status = await plane.vault.recordCheck(connector.id, {
        ok: probe.ok,
        detail: probe.detail,
        account: probe.ok ? probe.account : undefined,
        scopes: probe.ok ? probe.scopes : undefined,
      });
      await plane.refresh();
      res.json({ ok: probe.ok, code: probe.code, detail: probe.detail, status });
    }),
  );

  /**
   * GET /api/connectors/:id/capabilities — ce que CE credential peut faire.
   *
   * `manage`, parce que répondre demande un appel au service avec le jeton du client.
   * Une capacité indisponible est rendue avec son motif : `available: true` par défaut
   * serait un mensonge commode.
   */
  app.get(
    "/api/connectors/:id/capabilities",
    deps.requireCapability("manage"),
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");
      const plane = planFor(req);
      const context = plane.contextFor(connector.id);
      if (!context) return fail(res, 404, "Unknown connector.", "connector_unknown");
      res.json({ connector: connector.id, capabilities: await connector.capabilities(context) });
    }),
  );

  /**
   * DELETE /api/connectors/:id — Oathrion oublie le jeton.
   *
   * La réponse porte `remoteStillValid`, et ce champ est le plus important de cette
   * route : pour un jeton d'accès personnel GitHub, Oathrion ne peut PAS l'invalider chez
   * le fournisseur. Répondre « déconnecté » tout court laisserait croire que le jeton est
   * mort, et c'est l'exploitant qui doit aller le supprimer.
   */
  app.delete(
    "/api/connectors/:id",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const connector = lookupConnector(param(req, "id"));
      if (!connector) return fail(res, 404, "Unknown connector.", "connector_unknown");
      const plane = planFor(req);
      const context = plane.contextFor(connector.id);
      if (!context) return fail(res, 404, "Unknown connector.", "connector_unknown");

      const revocation = await connector.revoke(context, requireIdentity(req).name);
      await plane.refresh();
      if (!revocation.ok) {
        return fail(res, 409, revocation.detail, "connector_not_configured");
      }
      res.json({
        revoked: true,
        remoteStillValid: revocation.remoteStillValid,
        detail: revocation.detail,
        status: await plane.vault.describe(connector.id),
      });
    }),
  );

  /* ------------------------- LES DESTINATIONS DU PARE-FEU ------------------------- */

  /**
   * GET /api/destinations — ce que le pare-feu peut atteindre, et AVEC QUELLE CLÉ.
   *
   * ## Le champ qui compte est `credential.shared`
   *
   * Le relais cherche le credential dans le coffre du locataire, PUIS retombe sur
   * `OATHRION_INTERCEPT_KEY_<DESTINATION>` — une variable d'environnement qui vaut pour
   * TOUT LE DÉPLOIEMENT. Sur une installation mutualisée, deux organisations clientes
   * partagent donc la même clé du fournisseur, et rien ne le disait.
   *
   * Cette route le dit. `shared: true` signifie « cette destination utilise la clé du
   * déploiement, commune à tous les locataires ». C'est correct pour un déploiement par
   * client — la forme actuelle — et c'est exactement ce qu'un exploitant doit voir avant
   * d'en héberger deux.
   *
   * `read` suffit : aucun secret, aucune enveloppe, aucune longueur. L'empreinte est six
   * caractères de SHA-256, assez pour reconnaître une clé, inutile pour la reconstituer.
   */
  app.get(
    "/api/destinations",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const organizationId = requireIdentity(req).organizationId as OrganizationId;
      const plane = planFor(req);
      const listed = listDestinationsFor(organizationId);
      const statuses = await Promise.all(listed.map((entry) => plane.vault.describe(entry.id)));

      res.json(
        listed.map((entry, index) => {
          const status = statuses[index];
          const own = status !== null && status.state !== "revoked" && status.state !== "not_configured";
          const envName = `OATHRION_INTERCEPT_KEY_${entry.id.replace(/-/g, "_").toUpperCase()}`;
          const fallback = (process.env[envName] ?? "").trim() !== "";
          return {
            id: entry.id,
            label: entry.label,
            /* L'origine, jamais le credential. Un exploitant doit pouvoir vérifier OÙ ça part. */
            origin: entry.destination.url.origin,
            credential: {
              /* Le coffre du locataire : chiffré, révocable, à lui. */
              tenant: own ? { state: status.state, fingerprint: status.fingerprint, connectedAt: status.connectedAt } : null,
              /*
               * `shared` est la divulgation honnête : sans credential propre, la clé
               * injectée est celle du déploiement.
               */
              shared: !own && fallback,
              /* Ni l'un ni l'autre : Oathrion n'injectera rien, et le relais le DIT dans sa réponse. */
              none: !own && !fallback,
            },
          };
        }),
      );
    }),
  );

  /**
   * PUT /api/destinations/:id/credential — la clé d'un locataire pour une destination.
   *
   * ## AUCUNE SONDE, ET C'EST DIT DANS LA RÉPONSE
   *
   * Pour un connecteur du catalogue, `connect` vérifie le jeton CONTRE le service avant
   * de le sceller. Ici il n'y a pas de service connu : Oathrion ne sait pas comment Stripe,
   * Jira ou une API interne valident une clé. Le credential est donc scellé et
   * **jamais annoncé comme vérifié** — l'état est `stored_unverified`, et la première
   * preuve qu'il est bon viendra du premier appel relayé.
   *
   * Inventer un `connected` ici serait le faux statut « protégé » que ce dépôt refuse.
   *
   * ## La destination doit être ENREGISTRÉE pour ce locataire
   *
   * `resolveDestination` porte la portée par organisation et les règles d'adresse. Sans
   * cette vérification, cette route serait un magasin de secrets à clé arbitraire — et
   * une destination d'un AUTRE locataire pourrait recevoir un credential.
   */
  app.put(
    "/api/destinations/:id/credential",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const organizationId = requireIdentity(req).organizationId as OrganizationId;
      const id = param(req, "id");
      try {
        resolveDestination(id, process.env, organizationId);
      } catch (error) {
        return fail(
          res,
          404,
          `${error instanceof Error ? error.message : String(error)} Oathrion seals a ` +
            `credential only for a registered destination: otherwise this route would be a ` +
            `free-for-all secret store.`,
          "destination_unknown",
        );
      }

      const parsed = destinationCredentialSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(
          res,
          400,
          parsed.error.issues[0]?.message ?? "Invalid credential.",
          "destination_credential_invalid",
        );
      }

      try {
        const status = await planFor(req).vault.store({
          connectorId: id,
          secret: parsed.data.secret,
          /* Aucun service n'a nommé de compte et aucune portée n'a été confirmée. */
          account: "",
          scopes: [],
          connectedBy: requireIdentity(req).name,
          verified: false,
        });
        return res.status(201).json({
          stored: true,
          state: status.state,
          fingerprint: status.fingerprint,
          /*
           * Le détail est rendu à l'appelant plutôt que laissé à la documentation : c'est
           * la réponse que lira l'exploitant, et elle ne doit pas lui laisser croire
           * qu'une vérification a eu lieu.
           */
          detail:
            "Credential sealed for this tenant. NO check was made with " +
            "the provider: Oathrion does not know its validation method. The first " +
            "relayed call will tell whether the key is good — and its status will be the provider's.",
        });
      } catch (error) {
        if (error instanceof VaultUnavailableError) {
          return fail(res, 503, error.message, "connector_vault_unavailable");
        }
        throw error;
      }
    }),
  );

  /**
   * DELETE /api/destinations/:id/credential — révoquer la clé du locataire.
   *
   * `remoteStillValid` est toujours vrai et la réponse le dit : Oathrion ne peut pas
   * invalider une clé chez un fournisseur qu'il ne connaît pas. Répondre « révoqué » tout
   * court laisserait croire que la clé est morte.
   *
   * ET LE CHAMP QUI SUIT EST LE PLUS IMPORTANT : si la variable du déploiement existe, le
   * relais y RETOMBE. Révoquer la clé du locataire ne coupe donc pas l'injection — elle
   * la remplace par celle du déploiement. Le taire ferait croire à une coupure.
   */
  app.delete(
    "/api/destinations/:id/credential",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const organizationId = requireIdentity(req).organizationId as OrganizationId;
      const id = param(req, "id");
      try {
        resolveDestination(id, process.env, organizationId);
      } catch {
        return fail(res, 404, "Unknown destination.", "destination_unknown");
      }

      const plane = planFor(req);
      /*
       * L'état est lu AVANT : `vault.revoke` écrit sur la ligne quel que soit son état et
       * rend « vrai » même pour une ligne déjà révoquée. Répondre 200 à une seconde
       * révocation ferait croire qu'il y avait quelque chose à couper.
       */
      const current = await plane.vault.describe(id);
      if (current === null || current.state === "revoked" || current.state === "not_configured") {
        return fail(
          res,
          409,
          "This destination has no active tenant credential.",
          "destination_not_configured",
        );
      }
      await plane.vault.revoke(id, requireIdentity(req).name);
      const envName = `OATHRION_INTERCEPT_KEY_${id.replace(/-/g, "_").toUpperCase()}`;
      const fallsBack = (process.env[envName] ?? "").trim() !== "";
      res.json({
        revoked: true,
        remoteStillValid: true,
        fallsBackToDeploymentKey: fallsBack,
        detail: fallsBack
          ? `This tenant's credential is revoked. WARNING: ${envName} is set, ` +
            `so the relay will now inject the DEPLOYMENT key, shared by all ` +
            `tenants. Remove the variable too so that this destination injects nothing any more.`
          : "This tenant's credential is revoked. No deployment key takes " +
            "over: Oathrion will inject nothing more for this destination, and the relay will say so " +
            "in its answer. The key stays valid at the provider; delete it there.",
        status: await plane.vault.describe(id),
      });
    }),
  );
}
