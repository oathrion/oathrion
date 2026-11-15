/**
 * Un serveur d'outils MCP — celui que VOUS écrivez, derrière la passerelle.
 *
 * ## Ce que ce fichier est, et pourquoi il n'importe rien d'Oathrion
 *
 * Tout ce que le dépôt prouvait jusqu'ici sur le chemin aval passait par
 * `server/mcp-local/local-mcp-server.ts` — une fixture écrite par la même main que la
 * passerelle. Une mélecture partagée du protocole aurait donc passé les deux tests.
 * C'est l'argument que le dépôt fait lui-même à propos de `TestClient.baseUrl`, ajouté
 * en Phase 8 pour qu'un client tiers puisse viser la vraie passerelle.
 *
 * Ce fichier n'importe **rien** d'Oathrion : ni `server/`, ni `shared/`, ni une constante.
 * Il est écrit depuis la spécification MCP, avec `node:http` et rien d'autre, et c'est
 * exactement la situation de votre équipe le jour où elle branche ses outils.
 *
 * ## Les trois choses qu'il montre
 *
 * 1. **Le minimum protocolaire** : `initialize`, `tools/list`, `tools/call`. Un serveur
 *    MCP n'a pas besoin d'être plus gros que ça pour être utile.
 *
 * 2. **L'idempotence CÔTÉ FOURNISSEUR, qui est votre travail et non celui d'Oathrion.**
 *    Oathrion garantit qu'un grant n'est consommé qu'une fois — c'est prouvé, y compris
 *    sous concurrence multi-processus. Il ne peut PAS garantir qu'un effet chez votre
 *    fournisseur n'a lieu qu'une fois : si votre serveur répond et que la réponse se
 *    perd sur le réseau, Oathrion voit un échec là où vous avez déjà débité.
 *    `docs/COMMERCIAL_READINESS.md` le dit en toutes lettres : « Déduplication côté
 *    fournisseur : NON FAIT dans Oathrion ». La clé arrive dans l'en-tête
 *    `X-Oathrion-Execution-Id`, et aussi dans le `id` JSON-RPC. C'est à vous de la stocker.
 *
 * 3. **Comment signaler une erreur** : `isError: true` dans le résultat, et non une
 *    erreur de transport. Oathrion écrit alors un reçu `outcome: "failed"`, consomme le
 *    grant, et ne réessaie PAS tout seul — un nouvel essai est une nouvelle
 *    autorisation.
 *
 * ## Lancer
 *
 *   npx tsx examples/mcp-server/server.ts 7801
 *
 * puis, côté Oathrion :
 *
 *   OATHRION_LOCAL_MCP_URL=http://127.0.0.1:7801/
 *   OATHRION_LOCAL_MCP_ORGANIZATIONS=<identifiant opaque de votre locataire>
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** La révision du protocole qu'Oathrion annonce dans `MCP-Protocol-Version`. */
const PROTOCOL_VERSION = "2026-07-28";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/**
 * Ce que votre système a DÉJÀ fait, indexé par identifiant d'exécution.
 *
 * En production, ce n'est pas une Map : c'est une table avec une contrainte d'unicité
 * sur la clé, écrite dans la même transaction que l'effet. Une Map en mémoire perd sa
 * mémoire au redémarrage, ce qui est précisément le moment où la déduplication compte.
 */
const alreadyDone = new Map<string, { reference: string; amount: number }>();

/** Un compteur d'appels RÉELLEMENT exécutés — ce que la vérification observe. */
let executed = 0;

/**
 * Un compteur de `tools/call` REÇUS, rejeux dédupliqués compris.
 *
 * Deux compteurs et non un, et la différence est tout l'intérêt. `executed` compte les
 * EFFETS ; `received` compte les REQUÊTES. Un client qui dépêcherait deux fois la même
 * action laisserait `executed` à 1 — la déduplication ci-dessous le masquerait
 * parfaitement — et c'est précisément le défaut qu'une preuve de l'« exactement une
 * fois » doit pouvoir voir. Trouvé en mutant la passerelle pour qu'elle dépêche deux
 * fois : avec le seul compteur d'effets, la vérification restait verte.
 */
let received = 0;

/**
 * Les arguments du dernier `tools/call`, et le nom de l'outil visé.
 *
 * Observés du côté du FOURNISSEUR, c'est-à-dire du seul côté qui compte : un registre
 * d'outils déclaré promet qu'un argument est une projection de ce qu'Oathrion détient
 * déjà, et cette promesse ne se vérifie qu'en regardant ce qui arrive ici. Un champ en
 * trop — un identifiant de locataire, un vidage de métadonnées — serait visible dans
 * cet objet et dans aucun test interne.
 */
let lastCall: { name: string; arguments: Record<string, unknown> } = { name: "", arguments: {} };

/** Un en-tête, ou la chaîne vide. Node met les noms en minuscules. */
function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function reply(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function rpcError(res: ServerResponse, id: JsonRpcRequest["id"], code: number, message: string): void {
  reply(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  /*
   * L'en-tête de version est exigé, et son absence est refusée plutôt que tolérée.
   * Un serveur permissif ici laisserait passer un client qui parle une autre révision
   * du protocole, et le désaccord se manifesterait bien plus tard, sur un champ.
   */
  const version = req.headers["mcp-protocol-version"];
  if (version !== PROTOCOL_VERSION) {
    reply(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `MCP-Protocol-Version attendu : ${PROTOCOL_VERSION}, reçu : ${String(version)}` },
    });
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    rpcError(res, null, -32700, "JSON invalide");
    return;
  }

  const id = request.id ?? null;

  if (request.method === "initialize") {
    reply(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "exemple-outils-client", version: "1.0.0" },
      },
    });
    return;
  }

  if (request.method === "tools/list") {
    reply(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "stripe.refund",
            description: "Rembourse un client. C'est VOTRE outil : Oathrion ne fait que décider.",
            inputSchema: {
              type: "object",
              properties: {
                customer: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string" },
                /*
                 * DÉCLARÉ PARCE QU'IL EST ACCEPTÉ, et c'est la leçon d'un passage de
                 * `verify:tools`. Ce serveur tolérait un `reference` sans le déclarer ;
                 * Oathrion compare désormais une déclaration `OATHRION_TOOLS` au schéma
                 * annoncé, et a donc refusé de dépêcher un champ que ce `tools/list`
                 * ne mentionnait pas — avec raison : un argument non déclaré est un
                 * argument que le serveur peut ignorer en silence.
                 *
                 * Un schéma qui ne dit pas tout ce que le serveur accepte est un schéma
                 * incomplet. Celui-ci est corrigé, et la réponse renvoie la référence
                 * pour qu'elle ne soit pas un champ décoratif.
                 */
                reference: { type: "string" },
              },
              required: ["customer", "amount"],
            },
          },
        ],
      },
    });
    return;
  }

  if (request.method !== "tools/call") {
    rpcError(res, id, -32601, `Méthode inconnue : ${String(request.method)}`);
    return;
  }

  received += 1;

  const name = request.params?.name ?? "";
  const args = request.params?.arguments ?? {};
  lastCall = { name, arguments: args };

  /*
   * LA CLÉ D'IDEMPOTENCE. Oathrion l'envoie dans un en-tête dédié ET dans le `id` JSON-RPC
   * (`placet-<executionId>`). On prend l'en-tête, et on retombe sur le `id` : un client
   * conforme fournit au moins l'un des deux.
   */
  const executionId =
    header(req, "x-oathrion-execution-id") ||
    // Nom hérité du renommage Placet → Oathrion. La passerelle émet LES DEUX, avec la
    // même valeur, pendant une version majeure : un serveur écrit contre l'ancien nom
    // continue donc de dédupliquer sans être touché.
    header(req, "x-placet-execution-id") ||
    (typeof id === "string" ? id.replace(/^(placet|placet)-/, "") : "");

  if (executionId === "") {
    rpcError(res, id, -32602, "Aucune clé d'idempotence : ni X-Oathrion-Execution-Id ni un id JSON-RPC exploitable.");
    return;
  }

  const seen = alreadyDone.get(executionId);
  if (seen) {
    /*
     * Rejeu : on rend LE MÊME résultat, sans refaire l'effet, et on ne compte pas une
     * seconde exécution. C'est tout ce que « idempotent » veut dire, et c'est le seul
     * endroit où cela peut être garanti — chez vous, pas chez Oathrion.
     */
    reply(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Déjà traité : ${seen.reference}` }],
        structuredContent: { ...seen, deduplicated: true },
      },
    });
    return;
  }

  if (name !== "stripe.refund") {
    rpcError(res, id, -32602, `Outil inconnu : ${name}`);
    return;
  }

  const amount = typeof args.amount === "number" ? args.amount : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    /*
     * Un refus MÉTIER se signale par `isError: true` DANS le résultat, pas par une
     * erreur de transport : Oathrion écrira un reçu `outcome: "failed"`, consommera le
     * grant, et ne réessaiera pas tout seul.
     */
    reply(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Montant invalide : le remboursement est refusé." }],
        structuredContent: { ok: false, reason: "invalid_amount" },
        isError: true,
      },
    });
    return;
  }

  executed += 1;
  /*
   * La référence du CLIENT quand il en fournit une, sinon une dérivée de la clé
   * d'idempotence. Déclarée dans `inputSchema`, donc utilisée : un champ qu'un schéma
   * annonce et qu'un serveur jette est pire qu'un champ absent, parce que l'appelant
   * croit l'avoir transmis.
   */
  const supplied = typeof args.reference === "string" && args.reference !== "" ? args.reference : null;
  const done = { reference: supplied ?? `ref_${executionId.slice(-12)}`, amount };
  alreadyDone.set(executionId, done);

  reply(res, 200, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: `Remboursement de ${amount} émis (${done.reference}).` }],
      structuredContent: { ok: true, ...done, deduplicated: false },
    },
  });
}

export interface ExampleMcpServer {
  readonly url: string;
  /** Appels réellement exécutés — un rejeu dédupliqué ne l'incrémente pas. */
  executedCount(): number;
  /** `tools/call` reçus, rejeux compris — ce qui révèle une dépêche en double. */
  receivedCount(): number;
  /** Les en-têtes du dernier appel, pour qu'une vérification puisse les examiner. */
  lastHeaders(): Record<string, string>;
  /** L'outil visé et les arguments reçus au dernier `tools/call`. */
  lastCall(): { name: string; arguments: Record<string, unknown> };
  close(): Promise<void>;
}

export async function startExampleMcpServer(port = 0): Promise<ExampleMcpServer> {
  let lastHeaders: Record<string, string> = {};

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      reply(res, 405, { error: "POST attendu" });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
      );
      handle(req, res, Buffer.concat(chunks).toString());
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://127.0.0.1:${bound}/`,
    executedCount: () => executed,
    receivedCount: () => received,
    lastHeaders: () => lastHeaders,
    lastCall: () => lastCall,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* Lancé directement : `npx tsx examples/mcp-server/server.ts 7801`. */
if (process.argv[1]?.endsWith("server.ts")) {
  const port = Number(process.argv[2] ?? 7801);
  void startExampleMcpServer(port).then((s) => {
    // eslint-disable-next-line no-console -- c'est un exemple exécutable
    console.log(`serveur d'outils d'exemple sur ${s.url}`);
  });
}
