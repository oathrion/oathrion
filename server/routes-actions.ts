/**
 * The HTTP surface of the action authorization plane (Phase 10).
 *
 * FOUR CALLS, AND WHY THE SECOND ONE IS NOT OPTIONAL
 * --------------------------------------------------
 *   POST /api/v1/actions/authorize          → decision + grant id (no execution)
 *   POST /api/v1/actions/execute            → Oathrion performs the action, returns a receipt
 *   POST /api/v1/actions/grants/:id/approve → a human binds their approval to one action
 *   GET  /api/v1/actions/receipts/:id       → proof of what was executed
 *
 * `authorize` deliberately does NOT return anything the caller can act on by
 * itself. It returns a grant id, and a grant id is only usable by handing it back
 * to `execute`, which is where Oathrion makes the downstream call. A caller who
 * receives ALLOW and then calls Stripe directly has left the governed path — and
 * the API is shaped so that doing so gains them nothing, because the credential
 * that reaches Stripe lives in Oathrion's destination configuration and never in the
 * response.
 *
 * WHAT THE BODY MAY CONTAIN
 * -------------------------
 * The intent, and nothing about identity or verdicts. `assertNoAuthoritativeFields`
 * refuses `tenantId`, `agentId`, `actionHash`, `decision`, `grantId` (in the
 * authorize body) and `actor` outright rather than ignoring them: an integration
 * that believes it is pinning the agent id should be told it is not.
 *
 * PATHS: registered under `/api/actions/...`, and therefore reachable as
 * `/api/v1/actions/...` too — `applyApiVersioning` rewrites `/api/v1/X` to
 * `/api/X` before the auth gate, so registering the versioned path here would
 * have produced a route no request can reach. Nothing reuses a Phase 9 path, so
 * no existing endpoint changes behaviour.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { actionRequestSchema } from "@shared/action/envelope";
import { ConstraintError, parseConstraints } from "@shared/policy/constraints";
import { McpDestinationError } from "./gateway/tools/mcp-destination";
import { assertNoAuthoritativeFields, ActionCanonicalizationError, buildActionEnvelope } from "./action/canonical";
import { authorityFor } from "./authority";
import { ReceiptChainVerifier, receiptEntryHash, type ReceiptChainVerdict } from "./authority/receipt-chain";
import { listDestinationsFor } from "./authority/destinations";
import { IdempotencyConflict } from "./authority/store";
import { requireIdentity } from "./auth";
import { increment } from "./observability/metrics";

/**
 * The helpers this module borrows from `server/routes.ts`.
 *
 * Passed in rather than imported to avoid a cycle, and rather than reimplemented
 * because `actingAgent` is the agent-binding chokepoint: a second copy of it is a
 * second place the credential binding could be forgotten, which is precisely what
 * `agent-binding-single-path.test.ts` exists to prevent.
 */
export interface ActionRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  fail: (res: Response, status: number, message: string, code?: string) => void;
  param: (req: Request, name: string) => string;
  actingAgent: (req: Request, res: Response, requested: string | null) => string | null;
  rejectsClientActor: (req: Request, res: Response) => boolean;
  requireCapability: (capability: "read" | "execute" | "approve" | "manage") => RequestHandler;
  ensureCapability: (req: Request, res: Response, capability: "read" | "execute" | "approve" | "manage") => boolean;
  decisionRateLimit: RequestHandler;
  writeRateLimit: RequestHandler;
}

const executeSchema = actionRequestSchema.extend({
  grantId: z.string().min(1).max(200),
});

const approveSchema = z.strictObject({
  /**
   * The hash of the action the approver was shown. REQUIRED.
   *
   * This is the field that makes §15 work. Without it, "approve grant X" means
   * "approve whatever grant X currently says", and an approver who reviewed a
   * 75 EUR refund would be authorizing whatever the row holds at the moment the
   * click lands. With it, the approval names its subject, and a mismatch is
   * refused. It is not a client-supplied *decision* — it is a client-supplied
   * assertion about what was reviewed, and it can only ever narrow authority.
   */
  actionHash: z.string().regex(/^[0-9a-f]{64}$/, "actionHash must be a 64-character sha256 hex digest."),
  note: z.string().max(500).optional(),
});

const rejectSchema = z.strictObject({ reason: z.string().max(500).optional() });

const policySchema = z.strictObject({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(200),
  action: z.string().min(1).max(120),
  destinationId: z.string().min(1).max(64).nullable().default(null),
  effect: z.enum(["ALLOW", "BLOCK", "APPROVAL_REQUIRED"]),
  constraints: z.array(z.unknown()).default([]),
  priority: z.number().int().min(0).max(1_000_000).default(0),
  status: z.enum(["active", "disabled"]).default("active"),
});

export function registerActionRoutes(app: Express, deps: ActionRouteDeps): void {
  const { handle, fail, param, actingAgent, rejectsClientActor } = deps;

  /** Shared prologue: refuse forged fields, resolve the agent, build the envelope. */
  function prepare(
    req: Request,
    res: Response,
    body: unknown,
  ): { envelope: ReturnType<typeof buildActionEnvelope>; identityName: string } | null {
    const identity = requireIdentity(req);
    try {
      assertNoAuthoritativeFields(body, "an action request");
    } catch (error) {
      fail(res, 400, (error as Error).message, "authoritative_field_supplied");
      return null;
    }

    const parsed = actionRequestSchema.safeParse(body);
    if (!parsed.success) {
      fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid action.", "invalid_action");
      return null;
    }

    /*
     * The credential's binding wins over anything the caller asserts, and a
     * contradiction is refused rather than overwritten. Same helper every Phase 9
     * route uses, deliberately: a second implementation of this rule is a second
     * place it can be forgotten, which is what
     * `agent-binding-single-path.test.ts` checks for textually.
     */
    const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
    if (agentId === null) return null;

    try {
      return {
        envelope: buildActionEnvelope({
          tenantId: String(identity.organizationId),
          agentId,
          request: parsed.data,
        }),
        identityName: identity.name,
      };
    } catch (error) {
      if (error instanceof ActionCanonicalizationError) {
        fail(res, 400, error.message, "action_not_canonicalizable");
        return null;
      }
      throw error;
    }
  }

  /* ------------------------------- authorize ------------------------------ */

  app.post(
    "/api/actions/authorize",
    deps.requireCapability("execute"),
    deps.decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;
      const prepared = prepare(req, res, req.body);
      if (!prepared) return;

      const { authorization } = authorityFor(requireIdentity(req).organizationId);
      let outcome;
      try {
        outcome = await authorization.authorize(prepared.envelope);
      } catch (error) {
        if (error instanceof IdempotencyConflict) {
          // 409: the key is a claim about identity and the claim conflicts with a
          // recorded one. Not a 400 — the request is well-formed, it is the
          // history that refuses it.
          return fail(res, 409, error.message, "idempotency_conflict");
        }
        throw error;
      }

      /*
       * Compté ici et non dans `AuthorizationService.authorize`, qui a quatre chemins
       * de retour (rejeu idempotent, BLOCK, et les deux issues avec grant). Un
       * compteur par chemin finit par en oublier un ; la route n'en a qu'un.
       */
      increment("oathrion_action_decisions_total", { decision: outcome.decision.toLowerCase() });

      res.json({
        decision: outcome.decision,
        reason: outcome.reason,
        actionId: outcome.action.id,
        // Returned so a caller can verify Oathrion hashed what they meant. Informational:
        // Oathrion never reads a hash back from a client.
        actionHash: outcome.action.actionHash,
        policyId: outcome.policyId,
        grantId: outcome.grant?.id ?? null,
        grantState: outcome.grant?.state ?? null,
        expiresAt: outcome.grant?.expiresAt ?? null,
        approvalId: outcome.approvalId,
        // Deliberate: on BLOCK there is no grant, so there is nothing to present
        // and no execution is reachable.
        executable: outcome.grant?.state === "issued",
      });
    }),
  );

  /* -------------------------------- execute ------------------------------- */

  app.post(
    "/api/actions/execute",
    deps.requireCapability("execute"),
    deps.decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsedExecute = executeSchema.safeParse(body);
      if (!parsedExecute.success) {
        return fail(res, 400, parsedExecute.error.issues[0]?.message ?? "Invalid body.", "invalid_action");
      }
      const { grantId, ...intent } = parsedExecute.data;

      /*
       * The intent is re-canonicalised and re-hashed here from what the caller
       * sent NOW. That is the point of the endpoint: if anything changed since
       * authorization — an amount, a currency, a recipient — the recomputed hash
       * differs from the grant's and the enforcement point refuses. Trusting a
       * hash from the body would make the whole mechanism decorative.
       */
      const prepared = prepare(req, res, intent);
      if (!prepared) return;

      const identity = requireIdentity(req);
      const { enforcement } = authorityFor(identity.organizationId);
      const result = await enforcement.execute({
        grantId,
        envelope: prepared.envelope,
        presentedBy: identity.name,
      });

      if (!result.ok) {
        /*
         * 403 for every refusal, with a machine-readable code.
         *
         * Not 404 for a missing grant, and that is deliberate: a 404 that only
         * appears for grant ids that do not exist turns this endpoint into an
         * oracle for probing which ids DO exist in another tenant. One status for
         * all refusals says nothing about why beyond what the caller is entitled
         * to know.
         */
        return fail(res, 403, result.reason, result.code.toLowerCase());
      }

      res.json({
        executed: true,
        receiptId: result.receipt.receiptId,
        grantId: result.grant.id,
        actionHash: result.receipt.actionHash,
        destinationId: result.receipt.destinationId,
        outcome: result.receipt.outcome,
        downstream: { ok: result.downstream.ok, text: result.downstream.text },
        executedAt: result.receipt.executedAt,
      });
    }),
  );

  /* -------------------------------- approve ------------------------------- */

  app.post(
    "/api/actions/grants/:id/approve",
    deps.requireCapability("approve"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;
      const parsed = approveSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid body.", "invalid_body");
      }
      const identity = requireIdentity(req);
      const { authorization } = authorityFor(identity.organizationId);
      const result = await authorization.approve({
        grantId: param(req, "id"),
        expectedActionHash: parsed.data.actionHash,
        // Attribution comes from the credential, never the body.
        approvedBy: identity.name,
      });
      if (!result.ok) return fail(res, 409, result.reason, "grant_not_approvable");
      res.json({
        approved: true,
        grantId: result.grant?.id ?? null,
        state: result.grant?.state ?? null,
        expiresAt: result.grant?.expiresAt ?? null,
        approvedBy: result.grant?.approvedBy ?? null,
      });
    }),
  );

  app.post(
    "/api/actions/grants/:id/reject",
    deps.requireCapability("approve"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;
      const parsed = rejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid body.", "invalid_body");
      }
      const identity = requireIdentity(req);
      const { authorization } = authorityFor(identity.organizationId);
      const result = await authorization.reject({
        grantId: param(req, "id"),
        rejectedBy: identity.name,
        reason: parsed.data.reason,
      });
      if (!result.ok) return fail(res, 409, result.reason, "grant_not_rejectable");
      res.json({ rejected: true, grantId: result.grant?.id ?? null, state: result.grant?.state ?? null });
    }),
  );

  /* ----------------------------- introspection ---------------------------- */

  app.get(
    "/api/actions/grants/:id",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const { store } = authorityFor(requireIdentity(req).organizationId);
      const grant = await store.findGrant(param(req, "id"));
      if (!grant) return fail(res, 404, "No such grant.", "not_found");
      res.json({ grant });
    }),
  );

  app.get(
    "/api/actions/receipts",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const { store } = authorityFor(requireIdentity(req).organizationId);
      res.json({ receipts: await store.listReceipts(100) });
    }),
  );

  /*
   * DÉCLARÉE AVANT `/:id`, et ce n'est pas un détail de style : Express retient la
   * PREMIÈRE route qui correspond. Placée après, « verify » serait avalé comme un
   * identifiant de reçu et cette route ne s'exécuterait jamais — en rendant un 404
   * parfaitement plausible.
   */
  app.get(
    "/api/actions/receipts/verify",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const organization = requireIdentity(req).organizationId;
      const { store } = authorityFor(organization);
      const now = new Date().toISOString();
      /*
       * DEUX MODES.
       *
       * `full` (par défaut, le contrat d'origine) relit toute la chaîne, par lots — la
       * mémoire ne suit pas sa longueur (§ 5.13), mais le temps, si : ~13 s par million de
       * reçus (§ 5.34).
       *
       * `?mode=incremental` reprend au point de la dernière vérification réussie (migration
       * 29) et ne relit que ce qui a été écrit depuis. Il vérifie aussi que l'ANCRE — le
       * reçu à la position du point — est toujours celle qui a été vérifiée. Il ne voit PAS
       * une modification plus ancienne que l'ancre : seule une vérification complète la voit,
       * et la réponse dit quand la dernière a eu lieu. Sans point de reprise, il fait une
       * vérification complète, et le dit.
       */
      const requested = req.query.mode === "incremental" ? "incremental" : "full";
      const checkpoint = requested === "incremental" ? await store.chainCheckpoint() : null;
      const mode: "full" | "incremental" = checkpoint ? "incremental" : "full";
      let verdict: ReceiptChainVerdict;
      let lastSeq: number | null = checkpoint ? checkpoint.entrySeq : null;
      if (checkpoint) {
        const anchor = await store.findReceiptBySeq(checkpoint.entrySeq);
        if (!anchor || anchor.entryHash !== checkpoint.entryHash || receiptEntryHash(organization, anchor) !== checkpoint.entryHash) {
          verdict = {
            ok: false,
            entries: checkpoint.entries,
            headHash: null,
            brokenAt: checkpoint.entries - 1,
            reason:
              `checkpoint: the receipt at position ${String(checkpoint.entrySeq)} is no longer the one verified on ` +
              `${checkpoint.verifiedAt} — the already verified part has changed; run a full verification`,
          };
        } else {
          const verifier = new ReceiptChainVerifier(organization, { entries: checkpoint.entries, headHash: checkpoint.entryHash });
          for await (const batch of store.receiptChainBatchesAfter(checkpoint.entrySeq)) {
            for (const receipt of batch) {
              verifier.push(receipt);
              if (receipt.entrySeq !== null) lastSeq = receipt.entrySeq;
            }
          }
          verdict = verifier.verdict();
        }
      } else {
        const verifier = new ReceiptChainVerifier(organization);
        for await (const batch of store.receiptChainBatches()) {
          for (const receipt of batch) {
            verifier.push(receipt);
            if (receipt.entrySeq !== null) lastSeq = receipt.entrySeq;
          }
        }
        verdict = verifier.verdict();
      }
      if (verdict.ok && verdict.headHash !== null && lastSeq !== null) {
        await store.advanceChainCheckpoint({ entries: verdict.entries, entrySeq: lastSeq, entryHash: verdict.headHash, at: now, full: mode === "full" });
      }
      /*
       * Sans étiquette de locataire : la métrique dit QU'UNE chaîne est rompue dans ce
       * déploiement, pas laquelle. C'est suffisant pour réveiller quelqu'un, et le
       * verdict nominatif reste dans la réponse que le client lit lui-même.
       */
      increment("oathrion_receipt_chain_verifications_total", { result: verdict.ok ? "ok" : "broken" });
      /*
       * 200 même quand la chaîne est rompue : la requête a réussi, et c'est son
       * RÉSULTAT qui est négatif. Un 4xx ferait croire à un appel mal formé, et un 5xx à
       * une panne — or une chaîne cassée n'est ni l'un ni l'autre, c'est une information
       * que le client doit pouvoir lire, archiver et montrer.
       */
      /*
       * Et ce que la chaîne ne peut pas voir : les autorisations consommées dont le reçu
       * n'a jamais été écrit (`ActionAuthorityStore.consumedWithoutReceipt`).
       */
      const orphans = await store.consumedWithoutReceipt();
      res.json({
        ...verdict,
        mode,
        /* Les reçus déjà vérifiés avant ce passage, et donc NON relus (0 en mode complet). */
        verifiedFrom: checkpoint ? checkpoint.entries : 0,
        lastFullVerification: mode === "full" ? (verdict.ok ? now : null) : checkpoint?.fullVerifiedAt ?? null,
        consumedWithoutReceipt: orphans.count,
        consumedWithoutReceiptSample: orphans.grants,
      });
    }),
  );

  app.get(
    "/api/actions/receipts/:id",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const { store } = authorityFor(requireIdentity(req).organizationId);
      const receipt = await store.findReceipt(param(req, "id"));
      if (!receipt) return fail(res, 404, "No such receipt.", "not_found");
      res.json({ receipt });
    }),
  );

  app.get(
    "/api/actions/destinations",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const identity = requireIdentity(req);
      try {
        // Origins are shown to an operator who may already configure them; no
        // credential is stored in or derived from this registry. Only the
        // destinations THIS tenant may use are listed: another tenant's
        // destination is not acknowledged to exist.
        res.json({
          destinations: listDestinationsFor(String(identity.organizationId)).map((entry) => ({
            id: entry.id,
            label: entry.label,
            origin: entry.destination.origin,
            kind: entry.destination.kind,
          })),
        });
      } catch (error) {
        if (error instanceof McpDestinationError) {
          return fail(res, 500, error.message, "destination_registry_invalid");
        }
        throw error;
      }
    }),
  );

  /* --------------------------- action policy rules ------------------------ */

  app.get(
    "/api/action-policies",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const { store } = authorityFor(requireIdentity(req).organizationId);
      res.json({ policies: await store.listPolicies() });
    }),
  );

  app.put(
    "/api/action-policies",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;
      const parsed = policySchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid rule.", "invalid_policy");
      }
      const identity = requireIdentity(req);
      const { store } = authorityFor(identity.organizationId);
      const now = new Date().toISOString();
      try {
        const saved = await store.savePolicy({
          id: parsed.data.id ?? `apol_${now.replace(/\D/g, "")}`,
          name: parsed.data.name,
          action: parsed.data.action,
          destinationId: parsed.data.destinationId,
          effect: parsed.data.effect,
          // Validated by the constraint language itself, so an unevaluatable rule
          // is refused at write time rather than failing open at decision time.
          constraints: parseConstraints(parsed.data.constraints),
          priority: parsed.data.priority,
          status: parsed.data.status,
          createdAt: now,
          updatedAt: now,
        });
        res.json({ policy: saved });
      } catch (error) {
        if (error instanceof ConstraintError) {
          return fail(res, 400, error.message, "invalid_constraint");
        }
        throw error;
      }
    }),
  );
}
