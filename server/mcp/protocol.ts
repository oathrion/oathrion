/**
 * JSON-RPC 2.0 / MCP transport for the Oathrion gateway.
 *
 * This file knows about the wire envelope and NOTHING about Oathrion. It cannot
 * reach a repository, a policy or a tool. The separation is deliberate: the
 * envelope is attacker-controlled input, so keeping its parsing away from the
 * code that decides anything means a malformed frame can only ever produce a
 * protocol error.
 *
 * WHICH REVISION THIS IMPLEMENTS, AND WHY IT MATTERS
 * -------------------------------------------------
 * MCP revision `2026-07-28`, verified against the published schema at
 * https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
 * and the Streamable HTTP transport spec at
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
 *
 * This is NOT the handshake-based protocol most MCP examples show. Revision
 * `2026-07-28` removed `initialize` / `notifications/initialized` and the
 * `Mcp-Session-Id` header (SEP-2575, SEP-2567): every request is now
 * self-contained and carries its own protocol version and client capabilities
 * in `params._meta`. Revisions `2025-11-25` and earlier are "legacy" in the
 * spec's own terms.
 *
 * That is a good fit for an authorization layer rather than an inconvenience. A
 * session handshake means authorization context established once and reused;
 * self-contained requests mean every single call is authorized on its own
 * evidence, which is the property Oathrion needs anyway.
 *
 * WHAT IS AND IS NOT AN ERROR
 * ---------------------------
 * A JSON-RPC `error` means the call could not be processed: bad frame, unknown
 * method, unusable params, unidentifiable caller. An Oathrion decision is NOT one
 * of these — a BLOCK is a successful, correctly processed call whose answer is
 * "no". The spec is explicit that tool-originated failures belong in the result
 * with `isError: true` "not as an MCP protocol-level error response. Otherwise,
 * the LLM would not be able to see that an error occurred and self-correct."
 * Decisions are therefore returned as tool results — see `router.ts`.
 */

/** The only revision this gateway implements. */
export const PROTOCOL_VERSION = "2026-07-28";

/**
 * Advertised by `server/discover` and echoed in an
 * `UnsupportedProtocolVersionError`.
 *
 * Deliberately a single entry. Legacy handshake revisions are NOT supported,
 * and claiming them would be worse than refusing them: a legacy client would
 * connect, complete an `initialize` that this server never implemented, and
 * discover the gap only when a tool call behaved unexpectedly.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;

/** Reserved codes from the JSON-RPC 2.0 specification, section 5.1. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * Codes defined by the MCP specification itself, values taken from the
 * published schema rather than chosen here.
 */
export const MCP_ERRORS = {
  /** `HeaderMismatch` — headers disagree with the body, or are missing. */
  headerMismatch: -32020,
  /** `MissingRequiredClientCapability`. */
  missingClientCapability: -32021,
  /** `UnsupportedProtocolVersionError`. */
  unsupportedProtocolVersion: -32022,
} as const;

/**
 * Oathrion's own codes, from the -32000..-32099 range the JSON-RPC spec reserves
 * for the server.
 *
 * These describe the *caller* — whether Oathrion could work out who is asking —
 * and stay distinct from `invalidParams` so a client can tell "your frame is
 * wrong" from "your credential does not permit this".
 */
export const OATHRION_RPC_ERRORS = {
  /** Authenticated, but the role lacks the capability the method requires. */
  forbidden: -32001,
  /** No agent identified, unknown agent, or an agent in another tenant. */
  agentUnresolved: -32002,
  /** The caller tried to supply an identity Oathrion derives for itself. */
  identityNotAccepted: -32003,
  /**
   * `Origin` present and not permitted. The transport spec requires servers to
   * validate it; see `http-validation.ts` for what the check is and is not
   * worth here.
   */
  originRejected: -32004,
  /** `Accept` cannot accept `application/json`, the only type this endpoint returns. */
  notAcceptable: -32005,
} as const;

/** The `_meta` keys the revision defines. Exact strings from the schema. */
export const META_KEYS = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

/** Transport headers that mirror body fields. Exact names from the spec. */
export const MCP_HEADERS = {
  protocolVersion: "mcp-protocol-version",
  method: "mcp-method",
  name: "mcp-name",
} as const;

/** JSON-RPC allows a string, a number or null as the request id. */
export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  /**
   * Absent — not null — marks a *notification*, which must receive no response.
   * `null` is a legal id for a request expecting an answer, so the two cases
   * cannot be collapsed.
   */
  id?: RpcId;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccessResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result: Record<string, unknown>;
}

export interface RpcErrorResponse {
  jsonrpc: "2.0";
  id: RpcId;
  error: RpcError;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

/**
 * `resultType` values this gateway emits.
 *
 * Revision `2026-07-28` made the field mandatory on every result: "The `result`
 * MUST include a `resultType` field to indicate the type of the result being
 * returned." The core protocol defines `"complete"` (the request finished and
 * the result holds the final content) and `"input_required"` (the server needs
 * more information). This gateway never asks the caller for more input — an
 * action it will not authorise is refused with a decision, not renegotiated —
 * so every result it produces is `"complete"`.
 *
 * Note what `"complete"` does and does not mean here: it describes the
 * PROTOCOL exchange, not the verdict. A BLOCK is a completed call whose answer
 * is "no", and it is reported as `resultType: "complete"` with `isError: true`
 * in the tool result — consistent with the same reasoning recorded at the top
 * of this file about why a decision is never a JSON-RPC error.
 */
export const RESULT_TYPE_COMPLETE = "complete";

/**
 * Wraps a handler's result in the JSON-RPC success envelope.
 *
 * `resultType` is stamped HERE, at the single point where every result becomes
 * a response, rather than in each of the three handlers. That is deliberate: a
 * required field added per-handler is a field a fourth handler will forget, and
 * the failure mode is silent — the server looks fine to its own tests and is
 * rejected by real clients.
 *
 * WHY THIS EXISTS AT ALL (Phase 8, defect P8-1)
 * ---------------------------------------------
 * It was missing until Phase 8, and five in-house MCP test files did not
 * notice, because all of them were written against this same implementation:
 * a shared misreading of the spec passes both sides of a test it also wrote.
 * The omission was found in the first minute of pointing the OFFICIAL MCP
 * client SDK at this gateway, which rejected the response with
 * `missing-resultType`. The regression test is therefore that third-party
 * client (`server/test/mcp-official-sdk.test.ts`), not another assertion
 * written from the same assumptions.
 *
 * A handler may override it by returning its own `resultType`; none does today.
 */
export function rpcSuccess(id: RpcId, result: Record<string, unknown>): RpcSuccessResponse {
  return { jsonrpc: "2.0", id, result: { resultType: RESULT_TYPE_COMPLETE, ...result } };
}

export function rpcFailure(
  id: RpcId,
  code: number,
  message: string,
  data?: unknown,
): RpcErrorResponse {
  // `data` is omitted rather than set to undefined, so the serialised frame
  // does not carry an empty key.
  return data === undefined
    ? { jsonrpc: "2.0", id, error: { code, message } }
    : { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * A protocol-level refusal, thrown by the router and converted to a JSON-RPC
 * error response with the right HTTP status by the route.
 *
 * Carries `status` because the transport spec prescribes specific statuses:
 * `400` for header and version problems, `404` for an unimplemented method.
 */
export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status = 200,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcFault";
  }
}

export type ParsedFrame =
  | { kind: "request"; request: RpcRequest }
  | { kind: "notification"; request: RpcRequest }
  | { kind: "invalid"; id: RpcId; code: number; message: string };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The id to answer an invalid frame with.
 *
 * The spec requires a null id when the id cannot be determined. A non-scalar id
 * (object, array) is not a valid id and must not be echoed back — reflecting an
 * attacker-supplied object into the response turns a malformed frame into a
 * reflection primitive.
 */
function readId(value: unknown): RpcId {
  if (!isPlainObject(value)) return null;
  const id = value.id;
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  return null;
}

/**
 * Validates one JSON-RPC frame.
 *
 * Strict about `jsonrpc: "2.0"`: accepting a frame without it, or with "1.0",
 * means guessing which protocol the client believes it is speaking.
 */
export function parseFrame(value: unknown): ParsedFrame {
  const id = readId(value);

  if (!isPlainObject(value)) {
    return {
      kind: "invalid",
      id,
      code: JSON_RPC_ERRORS.invalidRequest,
      message: "Request must be a JSON object.",
    };
  }
  if (value.jsonrpc !== "2.0") {
    return {
      kind: "invalid",
      id,
      code: JSON_RPC_ERRORS.invalidRequest,
      message: 'Missing or unsupported "jsonrpc" version; expected "2.0".',
    };
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    return {
      kind: "invalid",
      id,
      code: JSON_RPC_ERRORS.invalidRequest,
      message: '"method" must be a non-empty string.',
    };
  }

  /*
   * `params` may be omitted or an object. The JSON-RPC spec also allows an
   * array of positional arguments, but every MCP method takes named arguments,
   * so an array cannot be interpreted. It is refused rather than silently read
   * as `{}`, which would turn a caller's mistake into a call with defaults.
   */
  if (value.params !== undefined && !isPlainObject(value.params)) {
    return {
      kind: "invalid",
      id,
      code: JSON_RPC_ERRORS.invalidParams,
      message: '"params" must be an object; positional parameters are not supported.',
    };
  }

  const base: RpcRequest = {
    jsonrpc: "2.0",
    method: value.method,
    params: isPlainObject(value.params) ? value.params : {},
  };

  // No `id` key at all is a notification, and must go unanswered.
  if (!("id" in value)) return { kind: "notification", request: base };

  const rawId = value.id;
  if (typeof rawId !== "string" && typeof rawId !== "number" && rawId !== null) {
    return {
      kind: "invalid",
      id: null,
      code: JSON_RPC_ERRORS.invalidRequest,
      message: '"id" must be a string, a number or null.',
    };
  }

  return { kind: "request", request: { ...base, id: rawId } };
}

/**
 * Cross-checks the mirrored transport headers against the body.
 *
 * WHY THIS IS A SECURITY CHECK AND NOT BOOKKEEPING
 * ------------------------------------------------
 * The spec requires the check for a reason worth restating, because it is
 * Oathrion's own thesis in miniature: intermediaries route on the headers while the
 * server executes the body. If the two disagree and the server does not care, a
 * caller can present `Mcp-Name: get_weather` to whatever sits in front of Oathrion
 * while the body says `tools/call` on `delete_customer`. Any policy enforced by
 * that intermediary — a WAF rule, an allowlist at the load balancer, an audit
 * log — is then describing a request that never happened.
 *
 * A mismatch is refused with `400` and code -32020, per the spec.
 */
export function validateHeaders(
  headers: Record<string, string | string[] | undefined>,
  request: RpcRequest,
): void {
  const read = (name: string): string | null => {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  const declaredVersion = read(MCP_HEADERS.protocolVersion);
  if (!declaredVersion) {
    throw new RpcFault(
      MCP_ERRORS.headerMismatch,
      `Missing required header "MCP-Protocol-Version". This endpoint implements MCP ${PROTOCOL_VERSION} and does not accept the legacy handshake-based revisions, which omitted it.`,
      400,
    );
  }

  const headerMethod = read(MCP_HEADERS.method);
  if (!headerMethod) {
    throw new RpcFault(
      MCP_ERRORS.headerMismatch,
      'Missing required header "Mcp-Method".',
      400,
    );
  }
  if (headerMethod !== request.method) {
    throw new RpcFault(
      MCP_ERRORS.headerMismatch,
      `Header mismatch: Mcp-Method header value "${headerMethod}" does not match body value "${request.method}".`,
      400,
    );
  }

  const meta = isPlainObject(request.params._meta) ? request.params._meta : {};
  const bodyVersion = meta[META_KEYS.protocolVersion];
  if (typeof bodyVersion !== "string") {
    throw new RpcFault(
      MCP_ERRORS.headerMismatch,
      `Missing required "${META_KEYS.protocolVersion}" in params._meta.`,
      400,
    );
  }
  if (bodyVersion !== declaredVersion) {
    throw new RpcFault(
      MCP_ERRORS.headerMismatch,
      `Header mismatch: MCP-Protocol-Version header value "${declaredVersion}" does not match body value "${bodyVersion}".`,
      400,
    );
  }

  // Version support is checked only once the two sources agree — otherwise the
  // error would be about a version the caller may not have meant.
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(bodyVersion)) {
    throw new RpcFault(
      MCP_ERRORS.unsupportedProtocolVersion,
      `Unsupported MCP protocol version "${bodyVersion}".`,
      400,
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: bodyVersion },
    );
  }

  /*
   * Required per-request, and the spec is explicit that a server "MUST NOT
   * infer capabilities from prior requests". An empty object is a valid answer
   * meaning "no optional capabilities"; absence is not.
   */
  if (!isPlainObject(meta[META_KEYS.clientCapabilities])) {
    throw new RpcFault(
      MCP_ERRORS.missingClientCapability,
      `Missing required "${META_KEYS.clientCapabilities}" in params._meta. Send {} to declare no optional capabilities.`,
      400,
    );
  }

  // `Mcp-Name` mirrors `params.name`, and is required for tools/call.
  if (request.method === "tools/call") {
    const headerName = read(MCP_HEADERS.name);
    if (!headerName) {
      throw new RpcFault(
        MCP_ERRORS.headerMismatch,
        'Missing required header "Mcp-Name" for a tools/call request.',
        400,
      );
    }
    const bodyName = request.params.name;
    if (typeof bodyName !== "string") {
      throw new RpcFault(
        JSON_RPC_ERRORS.invalidParams,
        '"params.name" must be a string naming the tool to call.',
        400,
      );
    }
    if (headerName !== bodyName) {
      throw new RpcFault(
        MCP_ERRORS.headerMismatch,
        `Header mismatch: Mcp-Name header value "${headerName}" does not match body value "${bodyName}".`,
        400,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Compatibility with the handshake-based revisions                           */
/* -------------------------------------------------------------------------- */

/**
 * The revisions real clients still speak, with their `initialize` handshake.
 *
 * WHY THIS EXISTS. The gateway implemented 2026-07-28 only and refused the
 * handshake. Measured on 2026-10-19 with a real client — Cursor's `cursor-agent`
 * 2026.08.11, `mcp list-tools` against a local instance — the connection failed:
 * the client opened with `initialize` and no `MCP-Protocol-Version` header, got a
 * 400, fell back to the older SSE transport and got a 404. The "connect your agent
 * over MCP" step of the guided start therefore did not work with a mainstream
 * client.
 *
 * WHAT DOES NOT CHANGE. Only the envelope differs: `tools/list` and `tools/call`
 * run the same code, through the same gateway, with the same connector filtering
 * and the same server-side authorization. Where a compatibility client DOES send
 * `Mcp-Method` or `Mcp-Name`, they must still match the body — the routing check is
 * kept wherever its inputs exist.
 */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

export type ProtocolMode = { kind: "current" } | { kind: "legacy"; version: string };

/**
 * Picks the protocol the request speaks, then validates it accordingly.
 *
 *   · `MCP-Protocol-Version: 2026-07-28`            → current, every check above;
 *   · a legacy version in the header                → legacy;
 *   · no header, and no 2026 `_meta` version in body → legacy, 2025-03-26 — the
 *     revision whose clients never sent the header, as its successor specifies;
 *   · no header but a 2026 `_meta` version          → current, which refuses it
 *     exactly as before (missing header).
 */
export function validateRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  request: RpcRequest,
): ProtocolMode {
  const read = (name: string): string | null => {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const declared = read(MCP_HEADERS.protocolVersion);
  const meta = isPlainObject(request.params._meta) ? request.params._meta : {};
  const bodyDeclaresCurrent = typeof meta[META_KEYS.protocolVersion] === "string";

  const legacy =
    (declared !== null && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(declared)) ||
    (declared === null && !bodyDeclaresCurrent);
  if (!legacy) {
    validateHeaders(headers, request);
    return { kind: "current" };
  }

  const headerMethod = read(MCP_HEADERS.method);
  if (headerMethod !== null && headerMethod !== request.method) {
    throw new RpcFault(
      MCP_ERRORS.headerMismatch,
      `Header mismatch: Mcp-Method header value "${headerMethod}" does not match body value "${request.method}".`,
      400,
    );
  }
  if (request.method === "tools/call") {
    const bodyName = request.params.name;
    if (typeof bodyName !== "string") {
      throw new RpcFault(JSON_RPC_ERRORS.invalidParams, '"params.name" must be a string naming the tool to call.', 400);
    }
    const headerName = read(MCP_HEADERS.name);
    if (headerName !== null && headerName !== bodyName) {
      throw new RpcFault(
        MCP_ERRORS.headerMismatch,
        `Header mismatch: Mcp-Name header value "${headerName}" does not match body value "${bodyName}".`,
        400,
      );
    }
  }
  return { kind: "legacy", version: declared ?? "2025-03-26" };
}

/** The version answered to `initialize`: the client's own if supported, else the newest legacy one. */
export function negotiateLegacyVersion(requested: unknown): string {
  return typeof requested === "string" && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LEGACY_PROTOCOL_VERSIONS[0];
}
