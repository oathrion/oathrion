/**
 * LE WEB PUSH, CÔTÉ RELAIS : appairer un navigateur par son code, transmettre une notification
 * déjà chiffrée avec l'en-tête VAPID, n'accepter que les appuis signés par l'appareil appairé,
 * révoquer un appareil, et refuser de poster ailleurs que chez un service de notifications.
 */
import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { b64u, type Conn, machineOf, MemoryRevocations, readTicket, RelayCore, RelayKeys } from "../src/core.ts";
import { pushEndpointAllowed, VapidKeys } from "../src/webpush.ts";

async function ed25519() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    pkcs8: b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    sign: async (data: string) => b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(data)))),
  };
}

/** Un téléphone : sa clé d'appareil (ECDSA P-256) et l'abonnement de son navigateur. */
function phone(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const device = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return {
    device,
    subscription: { endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } },
    sign: (data: string) => sign("sha256", Buffer.from(`oathrion-phone-v1|${data}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

async function setup() {
  const now = { t: 1_800_000_000_000 };
  const keys = await RelayKeys.load((await ed25519()).pkcs8);
  const vapidPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const vapid = await VapidKeys.load(vapidPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"));
  const pushes: { endpoint: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  let pushStatus = 201;
  const pushFetch = (async (url: string, init: RequestInit) => {
    pushes.push({ endpoint: url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return new Response(null, { status: pushStatus });
  }) as unknown as typeof fetch;
  const revocations = new MemoryRevocations();
  const core = new RelayCore({ bot: "OathrionBot", telegram: null, vapid, publicUrl: "https://relay.test", pushFetch, keys, revocations, salt: "s", now: () => now.t });
  const conns: Conn[] = [];
  const room = async (route: string) => conns.filter((c) => c.session.machine?.startsWith(route));
  async function machine() {
    const key = await ed25519();
    const id = await machineOf(key.publicKey);
    const received: Record<string, unknown>[] = [];
    const closed: number[] = [];
    const { session, hello } = core.open(id);
    const conn: Conn = { session, send: (m) => received.push(m as Record<string, unknown>), close: (code) => closed.push(code) };
    conns.push(conn);
    const say = (message: object) => core.onMessage(conn, JSON.stringify(message), room);
    await say({ t: "auth", key: key.publicKey, sig: await key.sign(`oathrion-relay-v1|connect|${(hello as { challenge: string }).challenge}`) });
    return { id, conn, received, closed, say, hello: hello as Record<string, unknown>, last: (t: string) => [...received].reverse().find((m) => m.t === t) };
  }
  /** Une machine appairée à un téléphone par la page. */
  async function paired() {
    const m = await machine();
    await m.say({ t: "pair.begin", kind: "web", label: "FORCE-N" });
    const code = m.last("code")!;
    const p = phone();
    const reply = await core.webPair({ code: code.code, subscription: p.subscription, device: p.device, label: "Android phone" }, room);
    return { m, p, code, reply };
  }
  const press = (p: ReturnType<typeof phone>, route: string, nonce: string, choice: string, at = now.t) => core.webPress({ route, nonce, choice, at, device: p.device, sig: p.sign(`press|${route}|${nonce}|${choice}|${String(at)}`) }, room);
  return { core, keys, vapid, vapidPair, pushes, setStatus: (s: number) => (pushStatus = s), revocations, machine, paired, press, now, room };
}

describe("relay web push: pairing", () => {
  it("offers browser notifications, gives a page link with the code in its fragment, and pairs once", async () => {
    const s = await setup();
    const { m, code, reply } = await s.paired();
    expect(m.hello).toMatchObject({ web: true, telegram: false });
    expect(code.link).toBe(`https://relay.test/pair#${String(code.code)}`);
    expect(reply).toEqual({ status: 200, json: { ok: true, computer: "FORCE-N" } });
    const ticket = await readTicket(s.keys.publicKey, m.last("paired")!.ticket as string);
    expect(ticket).toMatchObject({ kind: "web", machine: m.id, account: "Android phone", push: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123" } });
    const again = await s.core.webPair({ code: code.code, subscription: phone().subscription, device: phone().device }, s.room);
    expect(again.status).toBe(410);
  });

  it("tells the computer the moment the phone opens the page, and the page which computer it pairs with", async () => {
    const s = await setup();
    const m = await s.machine();
    await m.say({ t: "pair.begin", kind: "web", label: "FORCE-N" });
    const code = m.last("code")!.code as string;
    expect(await s.core.webSeen({ code }, s.room)).toEqual({ status: 200, json: { computer: "FORCE-N" } });
    await s.core.webSeen({ code }, s.room);
    expect(m.received.filter((r) => r.t === "pair.seen")).toHaveLength(1);
    /* Vu n'est pas appairé : le code sert encore à appairer. */
    const p = phone();
    expect((await s.core.webPair({ code, subscription: p.subscription, device: p.device }, s.room)).status).toBe(200);
    expect((await s.core.webSeen({ code }, s.room)).status).toBe(410);
    expect((await s.core.webSeen({ code: "nope" }, s.room)).status).toBe(400);
  });

  it("refuses a subscription that does not go to a browser's notification service", async () => {
    const s = await setup();
    const m = await s.machine();
    await m.say({ t: "pair.begin", kind: "web" });
    const evil = phone("https://evil.example/collect");
    const reply = await s.core.webPair({ code: m.last("code")!.code, subscription: evil.subscription, device: evil.device }, s.room);
    expect(reply.status).toBe(400);
    expect(pushEndpointAllowed("https://web.push.apple.com/QGx")).toBe(true);
    expect(pushEndpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(pushEndpointAllowed("http://fcm.googleapis.com/x")).toBe(false);
    expect(pushEndpointAllowed("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(pushEndpointAllowed("https://fcm.googleapis.com:8443/x")).toBe(false);
  });

  it("refuses Telegram when the relay has no bot", async () => {
    const s = await setup();
    const m = await s.machine();
    await m.say({ t: "pair.begin", kind: "telegram" });
    expect(m.last("error")).toMatchObject({ code: "kind" });
  });
});

describe("relay web push: a notification", () => {
  it("is posted, still encrypted, with a VAPID signature for that service", async () => {
    const s = await setup();
    const { m } = await s.paired();
    const sealed = randomBytes(200);
    await m.say({ t: "push", ref: "r1", body: sealed.toString("base64url"), topic: "abcdefghijkl" });
    expect(m.last("pushed")).toMatchObject({ ref: "r1" });
    const sent = s.pushes.at(-1)!;
    expect(sent.endpoint).toBe("https://fcm.googleapis.com/fcm/send/abc123");
    expect(Buffer.from(sent.body).equals(sealed)).toBe(true);
    expect(sent.headers).toMatchObject({ "content-encoding": "aes128gcm", topic: "abcdefghijkl", urgency: "high" });
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(sent.headers.authorization!)!;
    expect(k).toBe(s.vapid.publicKey);
    const [header, claims, signature] = t!.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:contact@oathrion.com" });
    expect(verify("sha256", Buffer.from(`${header!}.${claims!}`), { key: createPublicKey(s.vapidPair.publicKey.export({ format: "pem", type: "spki" })), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("unpairs when the browser's subscription is gone", async () => {
    const s = await setup();
    const { m } = await s.paired();
    s.setStatus(410);
    await m.say({ t: "push", ref: "r", body: randomBytes(200).toString("base64url") });
    expect(JSON.parse(m.last("unpaired")!.p as string)).toMatchObject({ reason: "expired" });
    expect(m.last("error")).toMatchObject({ code: "expired" });
  });

  it("refuses Telegram messages to a browser, and a push too big for the services", async () => {
    const s = await setup();
    const { m } = await s.paired();
    await m.say({ t: "send", ref: "x", text: "Hi" });
    expect(m.last("error")).toMatchObject({ code: "kind" });
    await m.say({ t: "push", ref: "y", body: randomBytes(5000).toString("base64url") });
    expect(m.closed).toContain(1008);
  });
});

describe("relay web push: a button touched on the phone", () => {
  it("reaches the machine only signed by the paired device, with the device's signature", async () => {
    const s = await setup();
    const { m, p } = await s.paired();
    const route = m.id.slice(0, 11);
    expect((await s.press(p, route, "abcdefghijkl", "approve")).status).toBe(200);
    const forwarded = JSON.parse(m.last("press")!.p as string) as { nonce: string; choice: string; device: { at: number; sig: string } };
    expect(forwarded).toMatchObject({ nonce: "abcdefghijkl", choice: "approve", device: { at: s.now.t } });

    const stranger = phone();
    expect((await s.press(stranger, route, "abcdefghijkl", "approve")).status).toBe(503);
    const forged = await s.core.webPress({ route, nonce: "abcdefghijkl", choice: "reject", at: s.now.t, device: p.device, sig: stranger.sign(`press|${route}|abcdefghijkl|reject|${String(s.now.t)}`) }, s.room);
    expect(forged.status).toBe(403);
    expect((await s.press(p, route, "abcdefghijkl", "approve", s.now.t - 20 * 60_000)).status).toBe(400);
    expect(m.received.filter((r) => r.t === "press")).toHaveLength(1);
  });

  it("passes the phone's approval on untouched, and drops one that is not a signature", async () => {
    const s = await setup();
    const { m, p } = await s.paired();
    const route = m.id.slice(0, 11);
    const sign = (choice: string) => p.sign(`press|${route}|abcdefghijkl|${choice}|${String(s.now.t)}`);
    const approval = p.sign(`approval|${route}|abcdefghijkl|approve|${String(s.now.t)}|digest`);
    expect((await s.core.webPress({ route, nonce: "abcdefghijkl", choice: "approve", at: s.now.t, device: p.device, sig: sign("approve"), approval }, s.room)).status).toBe(200);
    expect(JSON.parse(m.last("press")!.p as string)).toMatchObject({ device: { at: s.now.t, approval } });
    expect((await s.core.webPress({ route, nonce: "abcdefghijkl", choice: "reject", at: s.now.t, device: p.device, sig: sign("reject"), approval: "<script>" }, s.room)).status).toBe(200);
    expect((JSON.parse(m.last("press")!.p as string) as { device: Record<string, unknown> }).device).not.toHaveProperty("approval");
  });

  it("says the computer is offline when nothing is connected", async () => {
    const s = await setup();
    const reply = await s.press(phone(), "AAAAAAAAAAA", "abcdefghijkl", "approve");
    expect(reply).toMatchObject({ status: 503, json: { offline: true } });
  });
});

describe("relay web push: Unpair this phone", () => {
  it("revokes the device durably: no more pushes, no more presses, even after a reconnection", async () => {
    const s = await setup();
    const { m, p } = await s.paired();
    s.now.t += 1000;
    const at = s.now.t;
    expect((await s.core.webUnpair({ device: p.device, at, sig: p.sign(`unpair|${p.device}|${String(at)}`) })).status).toBe(200);
    expect([...s.revocations.entries.keys()][0]).not.toContain(p.device.slice(0, 20));
    await m.say({ t: "push", ref: "after", body: randomBytes(200).toString("base64url") });
    expect(JSON.parse(m.last("unpaired")!.p as string)).toMatchObject({ reason: "revoked" });
    const stolen = phone();
    expect((await s.core.webUnpair({ device: p.device, at, sig: stolen.sign(`unpair|${p.device}|${String(at)}`) })).status).toBe(403);
  });

  it("serves the manifest with the code, for an iPhone home screen", async () => {
    const s = await setup();
    expect(s.core.webManifest("A".repeat(33))).toMatchObject({ start_url: `/pair#${"A".repeat(33)}`, display: "standalone" });
    expect(s.core.webManifest("<script>")).toMatchObject({ start_url: "/pair" });
  });
});
