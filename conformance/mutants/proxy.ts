/**
 * Les mutants — la moitié du kit qui prouve que l'autre moitié mord.
 *
 * ## Pourquoi un proxy et non un faux serveur
 *
 * La spécification décrivait chaque mutant comme « un service HTTP minimal qui répond
 * correctement SAUF sur une propriété ». Écrire cela demande de réimplémenter un plan de
 * contrôle conforme — des semaines, pour du code jetable, et dont la correction de base
 * ne serait prouvée par rien.
 *
 * Un proxy inverse devant l'implémentation RÉELLE donne « correct sauf sur un point »
 * gratuitement : la correction de base vient du produit, et la mutation est une
 * transformation de quelques lignes. C'est un écart assumé par rapport à SPEC.md, et
 * c'est un meilleur dessin.
 *
 * ## La règle que ces mutants font respecter
 *
 * Une propriété n'est tenue que si son mutant la fait tomber. Une suite de conformité
 * qui passe contre tout ne prouve rien — et on ne s'en aperçoit que des mois plus tard,
 * le jour où elle aurait dû attraper quelque chose.
 *
 * ## Ce qui n'a PAS de mutant, dit plutôt que tu
 *
 * Les groupes **grant** (C10 à C16) et **approbation** (C18 à C22) n'en ont aucun ici.
 * Leur violation est un changement d'ÉTAT côté serveur — rejouer un grant consommé doit
 * réellement livrer une seconde fois — et un proxy qui réécrit des réponses ne peut pas
 * le simuler sans mentir aussi sur le compteur de livraisons, c'est-à-dire sans
 * fabriquer un mutant qui se fait attraper pour la mauvaise raison. Les écrire demande
 * des mutations dans le code du produit, sur le modèle de `script/mutation-audit.ts`.
 * Tant que ce n'est pas fait, ces propriétés sont vérifiées mais **non éprouvées**, et le
 * rapport doit le dire.
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Mutant {
  /** Les propriétés que cette mutation DOIT faire tomber. */
  readonly breaks: readonly string[];
  readonly describe: string;
  /** Rendre une réponse ici court-circuite l'implémentation réelle. */
  intercept?(ctx: MutationContext): { status: number; body: unknown } | null;
  /** Transformer la réponse réelle. */
  transform?(ctx: MutationContext, status: number, body: unknown): { status: number; body: unknown };
}

export interface MutationContext {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly requestBody: Record<string, unknown>;
  /** Les identifiants vus dans des réponses réussies, pour les mutants d'oracle. */
  readonly seen: Set<string>;
}

const KNOWN_VERBS = new Set(["stripe.refund", "customer.delete"]);

export const MUTANTS: Record<string, Mutant> = {
  /* ------------------------------------------------------------ décision */

  "defaut-permissif": {
    breaks: ["C4"],
    describe: "en l'absence de règle applicable, le moteur rend ALLOW",
    transform(ctx, status, body) {
      const action = ctx.requestBody.action;
      if (!ctx.path.endsWith("/actions/authorize") || typeof action !== "string") return { status, body };
      if (KNOWN_VERBS.has(action)) return { status, body };
      return { status: 200, body: { ...(body as object), decision: "ALLOW", grantId: `mutant_${Date.now()}` } };
    },
  },

  "champ-honore": {
    breaks: ["C6"],
    describe: "le champ `decision` du corps remplace la valeur dérivée",
    intercept(ctx) {
      if (!ctx.path.endsWith("/actions/authorize")) return null;
      if (ctx.requestBody.decision !== "ALLOW") return null;
      return { status: 200, body: { decision: "ALLOW", grantId: `mutant_${Date.now()}`, actionHash: "0".repeat(64) } };
    },
  },

  "anonyme-decide": {
    breaks: ["C8"],
    describe: "une demande sans credential est rattachée à une organisation par défaut, puis décidée",
    intercept(ctx) {
      if (!ctx.path.endsWith("/actions/authorize") || ctx.authorization) return null;
      return { status: 200, body: { decision: "ALLOW", grantId: `mutant_${Date.now()}` } };
    },
  },

  /* ----------------------------------------------------------- isolation */

  "oracle-403": {
    breaks: ["C27"],
    describe: "un objet d'un autre locataire répond 403, un identifiant inexistant 404",
    transform(ctx, status, body) {
      if (status !== 404) return { status, body };
      const last = ctx.path.split("/").filter(Boolean).pop() ?? "";
      // Seuls les identifiants DÉJÀ VUS dans une réponse réussie existent vraiment :
      // c'est exactement la différence observable que C27 interdit.
      if (!ctx.seen.has(last)) return { status, body };
      return { status: 403, body: { ...(body as object), code: "forbidden" } };
    },
  },

  /* ------------------------------------------------ honnêteté et contrat */

  "sans-drapeau": {
    breaks: ["C34"],
    describe: "l'inventaire des outils omet `simulated`",
    transform(ctx, status, body) {
      if (!ctx.path.endsWith("/api/tools") || !Array.isArray(body)) return { status, body };
      return {
        status,
        body: body.map((tool) => {
          const copy = { ...(tool as Record<string, unknown>) };
          delete copy.simulated;
          return copy;
        }),
      };
    },
  },

  "erreur-en-prose": {
    breaks: ["C35"],
    describe: "les erreurs ne portent que `message`",
    transform(_ctx, status, body) {
      if (status < 400 || typeof body !== "object" || body === null) return { status, body };
      const copy = { ...(body as Record<string, unknown>) };
      delete copy.code;
      return { status, body: copy };
    },
  },
};

/** Les identifiants qu'une réponse réussie révèle, pour le mutant d'oracle. */
function collectIds(body: unknown, into: Set<string>): void {
  if (Array.isArray(body)) {
    for (const entry of body) collectIds(entry, into);
    return;
  }
  if (typeof body !== "object" || body === null) return;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string" && /^(grantId|receiptId|executionId|id)$/.test(key)) into.add(value);
    else collectIds(value, into);
  }
}

export async function startMutantProxy(
  target: string,
  name: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const mutant = MUTANTS[name];
  if (!mutant) throw new Error(`mutant inconnu : "${name}". Connus : ${Object.keys(MUTANTS).join(", ")}`);

  const upstream = new URL(target);
  const seen = new Set<string>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawRequest = Buffer.concat(chunks).toString();
      let requestBody: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(rawRequest);
        if (parsed && typeof parsed === "object") requestBody = parsed as Record<string, unknown>;
      } catch {
        /* corps non-JSON : le mutant n'en a pas besoin */
      }

      const ctx: MutationContext = {
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?")[0]!,
        authorization: req.headers.authorization ?? null,
        requestBody,
        seen,
      };

      const short = mutant.intercept?.(ctx);
      if (short) {
        const payload = JSON.stringify(short.body);
        res.writeHead(short.status, { "Content-Type": "application/json" });
        res.end(payload);
        return;
      }

      const proxied = httpRequest(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: upstream.host },
        },
        (upstreamRes) => {
          const out: Buffer[] = [];
          upstreamRes.on("data", (c: Buffer) => out.push(c));
          upstreamRes.on("end", () => {
            const rawResponse = Buffer.concat(out).toString();
            let body: unknown = rawResponse;
            try {
              body = JSON.parse(rawResponse);
            } catch {
              /* laissé tel quel */
            }
            const status = upstreamRes.statusCode ?? 502;
            if (status >= 200 && status < 300) collectIds(body, seen);

            const mutated = mutant.transform?.(ctx, status, body) ?? { status, body };
            const payload = typeof mutated.body === "string" ? mutated.body : JSON.stringify(mutated.body);
            res.writeHead(mutated.status, { "Content-Type": "application/json" });
            res.end(payload);
          });
        },
      );
      proxied.on("error", () => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "proxy_error", message: "upstream unreachable" }));
      });
      if (rawRequest) proxied.write(rawRequest);
      proxied.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
