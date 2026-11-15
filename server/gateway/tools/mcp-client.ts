/**
 * Oathrion as an MCP *client* of a downstream MCP server.
 *
 * Phase 3 made Oathrion an MCP *server*: an agent runtime speaks MCP to Oathrion, and
 * Oathrion decides. This module is the other half — once a call is authorized,
 * Oathrion speaks MCP onward to the server that actually holds the capability.
 *
 *   agent runtime ──MCP──▶ Oathrion gateway ──MCP──▶ downstream MCP server ──HTTP──▶ provider
 *                            ▲
 *                            the only place a decision is made
 *
 * WHY THIS DOES NOT CREATE A SECOND PATH TO THE TOOLS
 * ---------------------------------------------------
 * This is the risk the brief names explicitly: introducing a downstream must
 * not create a route where MCP reaches the provider without passing through
 * Oathrion. It does not, because of where this code is reachable from.
 *
 * `callDownstreamTool` is only ever called from inside a `CountingTool.run()`.
 * `run()` is only reachable through `CountingTool.execute()`, and `execute()`
 * is only reachable from `AgentGateway.dispatch()`, which runs *after* the
 * policy decision and only when that decision was ALLOW. So this module cannot
 * be reached without a decision having already been made; it is downstream of
 * the chokepoint, not beside it. `mcp-single-path.test.ts` continues to assert
 * the gateway remains the sole entry, and Phase 4 adds a test asserting no
 * module outside `tools/` imports this one.
 *
 * WHY IT IS OPT-IN
 * ----------------
 * With `OATHRION_LOCAL_MCP_URL` unset — every normal run, and every pre-existing
 * test — the tools behave exactly as before and report `mode: "SIMULATED"`.
 * Set it, and the same tools route through the local MCP server and report
 * `mode: "LOCAL_MCP"`. Two reasons for the switch rather than a hard cutover:
 *
 *   1. The mode is recorded in the tool result, so the audit entry states
 *      whether an action was simulated or actually dispatched. A system whose
 *      whole claim is honest authorization must not be vague about which of the
 *      two happened.
 *   2. It keeps the existing suite meaningful instead of rewriting it around a
 *      network fixture.
 *
 * The URL is read per call, never cached at import, so a test can point it at
 * an ephemeral port after this module has loaded.
 *
 * LOCAL only: the default and only intended target is a loopback fixture. No
 * credential is read, sent or stored here.
 */

import { sendGuarded } from "../../notifications/webhook-transport";
import { resolveDownstreamDestination, type McpDestination } from "./mcp-destination";
import { legacyWireHeader, wireHeader } from "@shared/wire-headers";

const PROTOCOL_VERSION = "2026-07-28";
const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** Which downstream a tool result came from. */
export type ToolMode = "SIMULATED" | "LOCAL_MCP" | "STDIO_MCP";

/*
 * Le délai du fournisseur vit dans `./downstream-timeout` : `server/authority/receipt-gaps.ts`
 * en a besoin pour son délai de grâce, et ce fichier ne doit être importé que par les
 * outils (`mcp-single-path.test.ts`).
 */
import { downstreamTimeoutMs } from "./downstream-timeout";
export { downstreamTimeoutMs };

/**
 * The configured downstream MCP server origin, or null when there is none.
 *
 * Phase 9: the validation moved to `./mcp-destination`, which applies the same
 * SSRF rules the webhook channel uses and requires an explicit allowlist for any
 * non-loopback destination. This function is kept as the thin accessor the rest
 * of the gateway already calls - its contract (an origin string or null, throw
 * on a bad configuration) is unchanged, so nothing downstream of it moved.
 */
export function downstreamMcpUrl(): string | null {
  return resolveDownstreamDestination()?.origin ?? null;
}

export interface DownstreamCall {
  /** Downstream tool name, e.g. `stripe.refund`. */
  tool: string;
  arguments: Record<string, unknown>;
  /** Oathrion execution id, forwarded for correlation. */
  executionId: string;
  /**
   * Phase 10: the already-validated destination this call must reach.
   *
   * Phase 9 had exactly one downstream, named by the environment, so resolving it
   * here was the same thing as knowing it. Phase 10 authorizes an action *for a
   * destination*, so the destination is part of what was authorized and must be
   * passed in rather than re-read from the environment — re-reading would let a
   * grant issued for one destination dispatch to whatever the environment happens
   * to say at execution time, which is the destination-binding failure §17
   * forbids.
   *
   * It is a resolved {@link McpDestination}, not a URL string: the SSRF rules have
   * already run by the time a value of that type exists, so this parameter cannot
   * be used to smuggle an unvalidated host past them.
   */
  destination?: McpDestination;
}

export interface DownstreamResult {
  ok: boolean;
  /** Human-readable text the downstream returned. */
  text: string;
  /** Structured payload, when the downstream provided one. */
  data: Record<string, unknown>;
}

/**
 * Calls one tool on the downstream MCP server.
 *
 * Sends a spec-conformant `tools/call`: mirrored `MCP-Protocol-Version`,
 * `Mcp-Method` and `Mcp-Name` headers, required `_meta` keys, and an `Accept`
 * naming both media types the transport allows. Written to the specification
 * rather than to what the local fixture happens to tolerate, so that pointing
 * this at a real MCP server is a configuration change and not a rewrite.
 */
export async function callDownstreamTool(call: DownstreamCall): Promise<DownstreamResult> {
  const destination = call.destination ?? resolveDownstreamDestination();
  if (!destination) {
    throw new Error("callDownstreamTool was called with no downstream configured.");
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    // Derived from the execution id: the same execution retried cannot look
    // like two unrelated downstream requests.
    // Le préfixe suit le nom du produit ; `examples/mcp-server/` accepte les deux.
    id: `placet-${call.executionId}`,
    method: "tools/call",
    params: {
      name: call.tool,
      arguments: call.arguments,
      _meta: {
        [META_PROTOCOL]: PROTOCOL_VERSION,
        // `{}` is the spec's way of saying "no optional capabilities", and it
        // is required rather than omittable.
        [META_CAPABILITIES]: {},
      },
    },
  });

  /*
   * Phase 9: dispatched through the guarded transport rather than `fetch`.
   *
   * The reason is DNS rebinding, and it is not a theoretical one. Everything
   * `resolveDownstreamDestination()` checks is a check on a STRING. A hostname
   * that is publicly routable when Oathrion validates it can resolve to 127.0.0.1
   * or to 169.254.169.254 by the time the socket opens, because the connection
   * performs its own, later lookup. No amount of pre-flight validation closes
   * that: the only check that cannot be raced is applied to the address the
   * socket is about to use.
   *
   * `sendGuarded` installs exactly that check, via a custom `lookup` that
   * refuses every blocked address before the connection is made. It also does
   * not follow redirects - a validated host answering `302 Location:
   * http://169.254.169.254/` would otherwise reach the metadata service with
   * every pre-flight check having passed - and it bounds the response.
   *
   * `fetch` cannot do any of this: it exposes no `lookup` hook. That is the
   * whole reason this is not a one-line call.
   *
   * The loopback fixture is exempted from the address check, and only it: its
   * host is a literal loopback address that Oathrion itself validated, so there is
   * no name to rebind.
   */
  const response = await sendGuarded({
    url: destination.url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": call.tool,
      /*
       * LES DEUX NOMS, et c'est le cas le plus coûteux à se tromper de tout le
       * renommage. `examples/mcp-server/` documente cette clé comme la clé
       * d'idempotence à stocker côté fournisseur ; quiconque a suivi cet exemple lit
       * `x-oathrion-execution-id`. Émettre seulement le nouveau nom lui ferait perdre sa
       * déduplication EN SILENCE — son serveur retomberait sur le `id` JSON-RPC s'il
       * l'a prévu, ou refuserait l'appel s'il ne l'a pas prévu. Les deux portent la
       * même valeur.
       */
      [wireHeader("executionId")]: call.executionId,
      [legacyWireHeader("executionId")]: call.executionId,
    },
    body,
    timeoutMs: downstreamTimeoutMs(),
    allowPrivate: destination.kind === "LOCAL_FIXTURE",
    captureBody: true,
  });

  if (response.body === undefined || response.body === "") {
    throw new Error(
      `Downstream MCP server returned an empty body for ${call.tool} (HTTP ${response.status}).`,
    );
  }

  let frame: {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
  try {
    frame = JSON.parse(response.body) as typeof frame;
  } catch {
    /*
     * A malformed downstream reply is an EXECUTION failure, and it is reported
     * as one. It must never be silently treated as success, and the raw body is
     * not echoed into the error: it is attacker-influenced text that would end
     * up in the audit trail and in the operator's log.
     */
    throw new Error(
      `Downstream MCP server returned a body that is not JSON for ${call.tool} ` +
        `(HTTP ${response.status}, ${response.body.length} bytes).`,
    );
  }


  /*
   * A protocol error means the call did not happen — the tool could not be
   * found, or the frame was refused. Surfaced as a thrown error so the Gateway
   * records the run as failed rather than quietly reporting success.
   */
  if (frame.error) {
    throw new Error(
      `Downstream MCP server refused ${call.tool}: ${frame.error.message} (${frame.error.code})`,
    );
  }
  if (!frame.result) {
    throw new Error(`Downstream MCP server returned no result for ${call.tool}.`);
  }

  const text = (frame.result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");

  const data =
    typeof frame.result.structuredContent === "object" && frame.result.structuredContent !== null
      ? (frame.result.structuredContent as Record<string, unknown>)
      : {};

  return { ok: frame.result.isError !== true, text, data };
}

/* ----------------------------- découverte ------------------------------- */

/**
 * Le schéma d'un outil tel que LE SERVEUR le déclare.
 *
 * Réduit à ce qui sert à vérifier une correspondance : le nom, la description, les
 * propriétés déclarées et celles qui sont requises. Le schéma JSON complet n'est pas
 * conservé — Oathrion ne valide pas les TYPES des arguments, et prétendre le faire avec un
 * sous-ensemble de JSON Schema écrit à la main serait une validation en trompe-l'œil.
 */
export interface DownstreamToolSchema {
  name: string;
  description: string;
  /** Les noms de propriétés que le schéma déclare. Vide quand il n'en déclare aucune. */
  properties: string[];
  /** Les propriétés que le serveur marque obligatoires. */
  required: string[];
}

export class DownstreamDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownstreamDiscoveryError";
  }
}

/**
 * `tools/list` — ce que le serveur d'en face déclare réellement servir.
 *
 * ## Le manque que ceci lève
 *
 * Ce client n'émettait que `tools/call`. Un exploitant devait donc écrire à la main le
 * nom de l'outil distant et la projection de chaque argument, **sans que rien ne les
 * compare à ce que le serveur déclare**. Une faute d'une lettre dans `refunds.create`, ou
 * un argument que le serveur exige et que la déclaration oublie, ne se révélait qu'au
 * premier appel réel d'un client.
 *
 * ## Pourquoi ce n'est pas une validation de types
 *
 * Seuls les NOMS sont retenus. Vérifier qu'un `amount` est bien un nombre demanderait
 * d'implémenter JSON Schema, et un sous-ensemble écrit à la main refuserait des schémas
 * valides tout en laissant passer ce qu'il ne comprend pas. Ce qui est vérifié ici est ce
 * qui se vérifie sûrement : l'outil existe-t-il, et ses champs obligatoires sont-ils tous
 * projetés.
 *
 * ## `_meta` et l'absence de clé d'idempotence
 *
 * `tools/list` ne produit aucun effet, donc il ne porte pas d'identifiant d'exécution :
 * il n'y a rien à dédupliquer. L'en-tête `Mcp-Method` le nomme pour que le serveur
 * puisse l'aiguiller comme n'importe quelle autre méthode.
 */
export async function discoverDownstreamTools(
  destination: McpDestination,
): Promise<DownstreamToolSchema[]> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "placet-discover",
    method: "tools/list",
    params: {
      _meta: {
        [META_PROTOCOL]: PROTOCOL_VERSION,
        [META_CAPABILITIES]: {},
      },
    },
  });

  /*
   * LE MÊME TRANSPORT GARDÉ que `tools/call`, et pour la même raison : la découverte
   * sort vers le même hôte, donc elle est exposée à la même réattribution DNS. Un second
   * client HTTP « juste pour lire » serait une seconde copie des gardes d'adresse.
   */
  const response = await sendGuarded({
    url: destination.url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "tools/list",
    },
    body,
    timeoutMs: downstreamTimeoutMs(),
    allowPrivate: destination.kind === "LOCAL_FIXTURE",
    captureBody: true,
  });

  if (response.body === undefined || response.body === "") {
    throw new DownstreamDiscoveryError(
      `The server answered tools/list without a body (HTTP ${response.status}).`,
    );
  }

  let frame: {
    result?: { tools?: unknown };
    error?: { code: number; message: string };
  };
  try {
    frame = JSON.parse(response.body) as typeof frame;
  } catch {
    /* Le corps n'est pas recopié : c'est du texte sous influence du serveur distant. */
    throw new DownstreamDiscoveryError(
      `The server answered tools/list with a body that is not JSON ` +
        `(HTTP ${response.status}, ${String(response.body.length)} bytes).`,
    );
  }

  if (frame.error) {
    /*
     * -32601 « méthode inconnue » est le cas LÉGITIME d'un serveur qui n'implémente pas
     * la découverte. L'appelant doit pouvoir le distinguer d'une panne, parce que les
     * deux ne méritent pas la même réaction : l'un est une limite du serveur, l'autre un
     * incident. Le code est donc conservé dans le message.
     */
    throw new DownstreamDiscoveryError(
      `The server refused tools/list: ${frame.error.message} (${String(frame.error.code)})`,
    );
  }

  const tools = frame.result?.tools;
  if (!Array.isArray(tools)) {
    throw new DownstreamDiscoveryError(
      "The tools/list answer carries no `result.tools` array.",
    );
  }

  return tools.flatMap((entry): DownstreamToolSchema[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const tool = entry as {
      name?: unknown;
      description?: unknown;
      inputSchema?: { properties?: unknown; required?: unknown };
    };
    if (typeof tool.name !== "string" || tool.name === "") return [];

    const properties =
      typeof tool.inputSchema?.properties === "object" && tool.inputSchema.properties !== null
        ? Object.keys(tool.inputSchema.properties as Record<string, unknown>)
        : [];
    const required = Array.isArray(tool.inputSchema?.required)
      ? tool.inputSchema.required.filter((name): name is string => typeof name === "string")
      : [];

    return [
      {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        properties,
        required,
      },
    ];
  });
}
