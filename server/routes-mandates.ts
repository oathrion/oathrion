/**
 * Les routes du mandat vérifiable (`server/mandates.ts`, `notes/CONCEPTION-MANDAT.md`, étape M2).
 *
 *   GET  /api/mandates                       les mandats de l'organisation, et la clé de signature de qui lit
 *   PUT  /api/mandates/signing-key           une personne enregistre la clé PUBLIQUE que son navigateur a créée
 *   POST /api/mandates                       créer un mandat (manage) — en attente des signatures
 *   GET  /api/mandates/:id                   un mandat, avec son document signé (à remettre à l'agent)
 *   POST /api/mandates/:id/sign              un signataire apporte SA signature, faite dans son navigateur
 *   POST /api/mandates/:id/revoke            révoquer (approve) : publié aussitôt dans la liste
 *   POST /api/mandates/:id/grants            l'agent du mandat demande l'autorisation d'UNE action
 *   POST /api/mandates/:id/receipts          l'agent rapporte le reçu que la contrepartie a signé (M4)
 *   GET  /api/mandates/:id/receipts          les reçus contresignés du mandat, et l'état de la chaîne
 *   GET  /api/mandates/:id/receipts/:grant   un reçu à double signature, vérifiable sans Oathrion
 *   GET  /.well-known/oathrion/mandates/:org/status
 *                                            la liste de révocation signée, PUBLIQUE : ce que relisent
 *                                            les contreparties (hors de `/api`, qui est fermé par défaut)
 *
 * Aucune route ne lit l'organisation dans la requête, sauf la liste publique, qui ne révèle que
 * des positions révoquées et n'existe que pour une organisation qui a des mandats.
 */
import type { Express, Request, RequestHandler, Response } from "express";

import type { MandateAction } from "@shared/mandate";
import type { Capability } from "@shared/roles";
import type { OrganizationId } from "@shared/tenancy";

import { MandateError, type CreateMandate, type MandateService } from "./mandates";

export interface MandateRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  fail: (res: Response, status: number, message: string) => unknown;
  param: (req: Request, name: string) => string;
  requireCapability: (capability: Capability) => RequestHandler;
  serviceFor: (req: Request) => MandateService;
  serviceForOrganization: (organization: OrganizationId) => MandateService | null;
  /** L'organisation et la personne de la requête, depuis le credential seulement. */
  identityOf: (req: Request) => { organizationId: OrganizationId; id: string; kind: string; agentId?: string | null };
  /** L'adresse publique de ce serveur, où les contreparties liront la liste de révocation. */
  publicBaseUrl: (req: Request) => string;
}

export function registerMandateRoutes(app: Express, deps: MandateRouteDeps): void {
  const { handle, fail, param, requireCapability } = deps;
  /* Une erreur du service porte son statut et une phrase pour la personne ; le reste remonte. */
  const guarded = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    handle(async (req, res) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof MandateError) return fail(res, error.status, error.message);
        throw error;
      }
    });

  app.get(
    "/api/mandates",
    requireCapability("read"),
    guarded(async (req, res) => {
      const service = deps.serviceFor(req);
      const identity = deps.identityOf(req);
      res.json({ me: identity.id, mandates: await service.list(), signingKey: await service.signerKey(identity.id) });
    }),
  );

  app.put(
    "/api/mandates/signing-key",
    requireCapability("read"),
    guarded(async (req, res) => {
      const identity = deps.identityOf(req);
      if (identity.kind !== "user") return fail(res, 403, "Only a person signs mandates.");
      const publicKey = typeof (req.body as { publicKey?: unknown })?.publicKey === "string" ? (req.body as { publicKey: string }).publicKey : "";
      await deps.serviceFor(req).registerSignerKey(identity.id, publicKey);
      res.json({ signingKey: publicKey });
    }),
  );

  app.post(
    "/api/mandates",
    requireCapability("manage"),
    guarded(async (req, res) => {
      const identity = deps.identityOf(req);
      const url = `${deps.publicBaseUrl(req)}/.well-known/oathrion/mandates/${identity.organizationId}/status`;
      res.status(201).json(await deps.serviceFor(req).create(req.body as CreateMandate, identity.id, url));
    }),
  );

  app.get(
    "/api/mandates/:id",
    requireCapability("read"),
    guarded(async (req, res) => {
      res.json(await deps.serviceFor(req).get(param(req, "id")));
    }),
  );

  app.post(
    "/api/mandates/:id/sign",
    requireCapability("approve"),
    guarded(async (req, res) => {
      const signature = typeof (req.body as { signature?: unknown })?.signature === "string" ? (req.body as { signature: string }).signature : "";
      res.json(await deps.serviceFor(req).sign(param(req, "id"), deps.identityOf(req).id, signature));
    }),
  );

  app.post(
    "/api/mandates/:id/revoke",
    requireCapability("approve"),
    guarded(async (req, res) => {
      res.json(await deps.serviceFor(req).revoke(param(req, "id"), deps.identityOf(req).id));
    }),
  );

  app.post(
    "/api/mandates/:id/grants",
    requireCapability("execute"),
    guarded(async (req, res) => {
      /* Seul un credential LIÉ à l'agent du mandat obtient une autorisation : jamais une session de la console. */
      const agentId = deps.identityOf(req).agentId;
      if (!agentId) return fail(res, 403, "Only the mandate's agent, with its own credential, asks for an authorization.");
      const action = (req.body as { action?: MandateAction })?.action;
      if (!action || typeof action.type !== "string") return fail(res, 400, "An action, with its type.");
      res.status(201).json(await deps.serviceFor(req).grant(param(req, "id"), agentId, action));
    }),
  );

  app.post(
    "/api/mandates/:id/receipts",
    requireCapability("execute"),
    guarded(async (req, res) => {
      const agentId = deps.identityOf(req).agentId;
      if (!agentId) return fail(res, 403, "Only the mandate's agent, with its own credential, reports a receipt.");
      res.status(201).json(await deps.serviceFor(req).recordReceipt(param(req, "id"), agentId, req.body as never));
    }),
  );

  app.get(
    "/api/mandates/:id/receipts",
    requireCapability("read"),
    guarded(async (req, res) => {
      const service = deps.serviceFor(req);
      const receipts = await service.receipts(param(req, "id"));
      res.json({ receipts, chain: await service.verifyReceiptChain() });
    }),
  );

  app.get(
    "/api/mandates/:id/receipts/:grant",
    requireCapability("read"),
    guarded(async (req, res) => {
      const service = deps.serviceFor(req);
      const id = param(req, "id");
      const found = (await service.receipts(id)).find((r) => r.grant.grant.id === param(req, "grant"));
      if (!found) return fail(res, 404, "No receipt for this authorization.");
      res.json({ mandate: (await service.get(id)).signed, grant: found.grant, countersigned: found.countersigned });
    }),
  );

  app.get(
    "/.well-known/oathrion/mandates/:org/status",
    guarded(async (req, res) => {
      const service = deps.serviceForOrganization(param(req, "org") as OrganizationId);
      if (!service || !(await service.hasMandates())) return fail(res, 404, "No mandate list here.");
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(await service.statusList());
    }),
  );
}
