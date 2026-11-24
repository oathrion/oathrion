/**
 * LE WEB PUSH, CÔTÉ RELAIS (23 novembre, le soir : `notes/CONCEPTION-RELAIS-TELEPHONE.md`). Le
 * pivot chiffre chaque notification pour le navigateur du téléphone (RFC 8291) ; le relais ne
 * lit rien : il signe l'en-tête VAPID (RFC 8292, sa clé P-256) et remet le paquet chiffré au
 * service de notifications du navigateur — seulement ceux qu'on connaît, pour que le relais ne
 * serve jamais à poster ailleurs.
 */
import { b64u, unb64u } from "./core.ts";

/** Les services de notifications des navigateurs (Chrome, Firefox, Safari, Edge). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function pushEndpointAllowed(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.port === "" && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

export class VapidKeys {
  private readonly key: CryptoKey;
  /** La clé publique brute (65 octets, base64url) : `applicationServerKey` de la page. */
  readonly publicKey: string;
  private readonly subject: string;

  private constructor(key: CryptoKey, publicKey: string, subject: string) {
    this.key = key;
    this.publicKey = publicKey;
    this.subject = subject;
  }

  /** La clé privée PKCS#8 (`VAPID_PRIVATE_KEY`, tirée par `script/keys.ts`). */
  static async load(pkcs8: string, subject = "mailto:contact@oathrion.com"): Promise<VapidKeys> {
    const key = await crypto.subtle.importKey("pkcs8", unb64u(pkcs8.trim()), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("VAPID_PRIVATE_KEY is not a P-256 private key.");
    const raw = new Uint8Array(65);
    raw[0] = 4;
    raw.set(unb64u(jwk.x), 1);
    raw.set(unb64u(jwk.y), 33);
    return new VapidKeys(key, b64u(raw), subject);
  }

  /** `Authorization: vapid t=…, k=…` pour ce service, valable douze heures. */
  async authorization(endpoint: string, now = Date.now()): Promise<string> {
    const encode = (value: object) => b64u(new TextEncoder().encode(JSON.stringify(value)));
    const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: this.subject })}`;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key, new TextEncoder().encode(unsigned)));
    return `vapid t=${unsigned}.${b64u(signature)}, k=${this.publicKey}`;
  }
}

export interface PushResult {
  /** `gone` : l'abonnement n'existe plus (permission retirée, navigateur effacé). */
  outcome: "sent" | "gone" | "failed";
  status: number;
  /** Ce que le service a répondu, en bref (sa raison, jamais une notification : elle est chiffrée). */
  reason?: string;
}

/** Remet un paquet déjà chiffré (aes128gcm) au service du navigateur. */
export async function sendPush(
  vapid: VapidKeys,
  endpoint: string,
  body: Uint8Array,
  options: { ttl?: number; topic?: string; urgency?: "high" | "normal" } = {},
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<PushResult> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: await vapid.authorization(endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttl ?? 3600),
      urgency: options.urgency ?? "high",
      ...(options.topic ? { topic: options.topic } : {}),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return { outcome: "sent", status: response.status };
  const reason = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
  return { outcome: response.status === 404 || response.status === 410 ? "gone" : "failed", status: response.status, ...(reason ? { reason } : {}) };
}
