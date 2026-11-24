/**
 * LE TÉLÉPHONE EN UN SCAN, PAR LE NAVIGATEUR (`server/local-phone-relay.ts`, `server/local-web-push.ts`,
 * `relay/`) : le vrai relais Node (HTTP et WebSocket) et un faux service de notifications. La page
 * du téléphone est jouée par le test : elle appaire, reçoit une notification qu'elle seule peut
 * déchiffrer (le relais ne la lit pas), et touche un bouton signé par sa clé d'appareil.
 */
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { b64u, MemoryRevocations, RelayCore, RelayKeys } from "../../relay/src/core.ts";
import { startNodeRelay, type NodeRelay } from "../../relay/src/node.ts";
import { VapidKeys } from "../../relay/src/webpush.ts";
import { notificationWords } from "@shared/approval-text";
import { approvalData, shownDigest, shownOf, verifyPhoneApproval } from "@shared/phone-approval";

import { PHONE_APPROVALS_FILE, readPhoneApprovals } from "../local-phone-approvals";
import { RelayPhone, type RelayPhoneOptions, verifyDevice } from "../local-phone-relay";
import { desktopText } from "../notifications/desktop";
import type { NotificationEvent } from "../notifications/types";

/** Le navigateur du téléphone : sa clé d'abonnement, son secret, sa clé d'appareil. */
function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const device = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = device.publicKey.export({ format: "jwk" });
  return {
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/phone-1", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } },
    device: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url"),
    sign: (data: string) => sign("sha256", Buffer.from(`oathrion-phone-v1|${data}`), { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
    /** Ce que fait le navigateur à l'arrivée : déchiffrer (RFC 8291). */
    decrypt: (body: Buffer): Record<string, unknown> => {
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const sender = body.subarray(21, 21 + idlen);
      const sealed = body.subarray(21 + idlen);
      const ikm = Buffer.from(hkdfSync("sha256", ua.computeSecret(sender), auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), sender]), 32));
      const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const decipher = createDecipheriv("aes-128-gcm", key, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
      expect(plain.at(-1)).toBe(2);
      return JSON.parse(plain.subarray(0, plain.length - 1).toString("utf8")) as Record<string, unknown>;
    },
  };
}

const approval = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id: "ntf_1",
  type: "approval.requested",
  at: "2026-11-23T20:00:00Z",
  title: "Approval required",
  summary: "",
  risk: "medium",
  agentId: "agt_claude",
  agentName: "Claude Code",
  executionId: "exe_1",
  approvalId: "apr_1",
  policyId: null,
  policyName: null,
  data: { action: "mcp.github.create_pull_request", arguments: { body: "SECRET CONTENT" } },
  ...over,
});

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 10));
  }
};

const running: { relay: NodeRelay; phones: RelayPhone[] }[] = [];
afterEach(async () => {
  for (const { relay, phones } of running.splice(0)) {
    for (const p of phones) p.stop();
    await relay.close();
  }
  delete process.env.OATHRION_PHONE_RELAY_URL;
  delete process.env.OATHRION_PHONE_RELAY_KEY;
});

async function setup(phoneOptions: RelayPhoneOptions = {}) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const keys = await RelayKeys.load(b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
  const vapid = await VapidKeys.load(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"));
  const pushes: { endpoint: string; body: Buffer }[] = [];
  let status = 201;
  const pushFetch = (async (url: string, init: RequestInit) => {
    pushes.push({ endpoint: url, body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const revocations = new MemoryRevocations();
  const core = new RelayCore({ bot: "OathrionBot", telegram: null, vapid, pushFetch, keys, revocations, salt: "s", publicUrl: "http://relay.invalid" });
  const relay = await startNodeRelay({ core, telegram: null, port: 0 });
  const base = `http://127.0.0.1:${String(relay.port)}`;
  const entry = { relay, phones: [] as RelayPhone[] };
  running.push(entry);
  process.env.OATHRION_PHONE_RELAY_URL = `ws://127.0.0.1:${String(relay.port)}/v1/connect`;
  process.env.OATHRION_PHONE_RELAY_KEY = keys.publicKey;
  const post = async (path: string, body: object) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  const decided: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "relay-web-"));
  const computer = new RelayPhone(dir, { label: "FORCE-N", ...phoneOptions }).bind({
    act: async (_event, action) => {
      decided.push(action);
      return action === "approve" ? "Approved: the action ran" : "Refused: the action did not run";
    },
    feedback: () => undefined,
    text: (event) => desktopText(event, { content: false }),
  });
  entry.phones.push(computer);
  return { base, post, pushes, setStatus: (s: number) => (status = s), revocations, computer, decided, dir };
}

/** « Pair my phone », puis la page du téléphone : Allow notifications. */
async function paired(s: Awaited<ReturnType<typeof setup>>) {
  const waiting = await s.computer.pair();
  expect(waiting).toMatchObject({ state: "waiting", kind: "web" });
  const link = (waiting as { link: string }).link;
  expect(link).toMatch(/^http:\/\/relay\.invalid\/pair#[A-Za-z0-9_-]{33}$/);
  /* La page s'ouvre : la console le voit, la page sait à quel ordinateur elle se lie. */
  expect(await s.post("/v1/web/seen", { code: link.split("#")[1] })).toEqual({ status: 200, json: { computer: "FORCE-N" } });
  await until(() => (s.computer.status() as { seen?: boolean }).seen === true);
  const phone = browser();
  const reply = await s.post("/v1/web/pair", { code: link.split("#")[1], subscription: phone.subscription, device: phone.device, label: "Android phone" });
  expect(reply).toEqual({ status: 200, json: { ok: true, computer: "FORCE-N" } });
  await until(() => s.computer.status().state === "paired");
  return phone;
}

describe("phone in one scan, by the browser: pairing", () => {
  it("pairs from the page, and sends a test notification only this phone can read", async () => {
    const s = await setup();
    const phone = await paired(s);
    expect(s.computer.status()).toMatchObject({ state: "paired", kind: "web", account: "Android phone", online: true });
    await until(() => s.pushes.length === 1);
    expect(phone.decrypt(s.pushes[0]!.body)).toMatchObject({ title: "Oathrion: your phone is paired", actions: [] });
    /* Un autre navigateur ne peut pas la lire. */
    expect(() => browser().decrypt(s.pushes[0]!.body)).toThrow();
  });

  it("serves the phone's page, its service worker and its manifest, with a strict content policy", async () => {
    const s = await setup();
    const page = await fetch(`${s.base}/pair`);
    expect(await page.text()).toContain("Allow notifications");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(`${s.base}/sw.js`)).headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${s.base}/v1/web/key`)).json()).toMatchObject({ key: expect.stringMatching(/^[A-Za-z0-9_-]{87}$/) });
    expect((await fetch(`${s.base}/../package.json`)).status).toBe(404);
    expect((await fetch(`${s.base}/mascots/nova.png`)).headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${s.base}/mascots/../src/core.ts`)).status).toBe(404);
  });
});

describe("phone in one scan, by the browser: a request", () => {
  it("arrives encrypted and without its content; a press signed by the phone decides, once", async () => {
    const s = await setup();
    const phone = await paired(s);
    await until(() => s.pushes.length === 1);
    expect(await s.computer.deliver(approval())).toBe(true);
    const card = phone.decrypt(s.pushes.at(-1)!.body) as { route: string; nonce: string; title: string; body: string; actions: { choice: string }[] };
    expect(JSON.stringify(card)).not.toContain("SECRET CONTENT");
    expect(s.pushes.at(-1)!.body.toString("latin1")).not.toContain("Claude Code");
    expect(card.actions.map((a) => a.choice)).toEqual(["approve", "reject", "allow-hour"]);
    /* Le visage de la demande : l'agent, l'ordinateur, l'heure. */
    expect(card).toMatchObject({ agent: "Claude Code", computer: "FORCE-N", at: expect.any(Number) });
    expect(s.computer.status()).toMatchObject({ state: "paired", lastAt: expect.any(String) });

    const press = (choice: string, by = phone) => {
      const at = Date.now();
      return s.post("/v1/web/press", { route: card.route, nonce: card.nonce, choice, at, device: by.device, sig: by.sign(`press|${card.route}|${card.nonce}|${choice}|${String(at)}`) });
    };
    expect((await press("approve", browser())).status).toBe(503);
    expect((await press("approve")).status).toBe(200);
    await until(() => s.decided.length === 1);
    expect(s.decided).toEqual(["approve"]);
    /* La notification est remplacée : décidé, « Was this right? ». */
    await until(() => s.pushes.some((p) => String(phone.decrypt(p.body).body).includes("Approved: the action ran (from your phone)")));
    const after = phone.decrypt(s.pushes.at(-1)!.body) as { tag: string; actions: { choice: string }[] };
    expect(after.tag).toBe(card.nonce);
    expect(after.actions.map((a) => a.choice)).toEqual(["right", "wrong"]);
    await press("reject");
    await new Promise((done) => setTimeout(done, 150));
    expect(s.decided).toEqual(["approve"]);
  });

  it("checks the phone's own signature, so a lying relay cannot decide", async () => {
    /* Le pivot n'accepte un appui que signé par la clé d'appareil du ticket (`verifyDevice`), même signé par le relais. */
    const phone = browser();
    const data = "press|AAAAAAAAAAA|abcdefghijkl|approve|1800000000000";
    expect(verifyDevice(phone.device, data, phone.sign(data))).toBe(true);
    expect(verifyDevice(phone.device, data.replace("approve", "reject"), phone.sign(data))).toBe(false);
    expect(verifyDevice(phone.device, data, browser().sign(data))).toBe(false);
    expect(verifyDevice("not-a-key", data, phone.sign(data))).toBe(false);
  });

  it("keeps the approval the phone signed on what it showed: a proof the computer cannot make alone", async () => {
    const s = await setup();
    const phone = await paired(s);
    await until(() => s.pushes.length === 1);
    await s.computer.deliver(approval());
    const card = phone.decrypt(s.pushes.at(-1)!.body) as Record<string, unknown> & { route: string; nonce: string };
    const at = Date.now();
    const signedOn = (shown: Record<string, unknown>) => phone.sign(approvalData({ shown: shownOf(shown), nonce: card.nonce, choice: "approve", at }));
    /* Un accord signé sur un AUTRE texte que celui montré : la décision passe, l'accord n'est pas gardé. */
    expect((await s.post("/v1/web/press", { route: card.route, nonce: card.nonce, choice: "approve", at, device: phone.device, sig: phone.sign(`press|${card.route}|${card.nonce}|approve|${String(at)}`), approval: signedOn({ ...card, title: "Something else" }) })).status).toBe(200);
    await until(() => s.decided.length === 1);
    expect(existsSync(join(s.dir, PHONE_APPROVALS_FILE))).toBe(false);

    await s.computer.deliver(approval({ id: "ntf_2", executionId: "exe_2", approvalId: "apr_2" }));
    const second = phone.decrypt(s.pushes.at(-1)!.body) as Record<string, unknown> & { route: string; nonce: string };
    const at2 = Date.now();
    const sig = phone.sign(`press|${second.route}|${second.nonce}|approve|${String(at2)}`);
    const signed = phone.sign(approvalData({ shown: shownOf(second), nonce: second.nonce, choice: "approve", at: at2 }));
    expect((await s.post("/v1/web/press", { route: second.route, nonce: second.nonce, choice: "approve", at: at2, device: phone.device, sig, approval: signed })).status).toBe(200);
    await until(() => s.decided.length === 2);
    const kept = readPhoneApprovals(s.dir);
    expect(kept.get("exe_2")).toBe(kept.get("apr_2"));
    const proof = kept.get("exe_2")!;
    expect(proof).toMatchObject({ choice: "approve", device: { publicKey: phone.device, label: "Android phone" }, shown: { agent: "Claude Code", computer: "FORCE-N" } });
    expect(verifyPhoneApproval(proof)).toEqual({ ok: true });
    /* Ni le contenu de la demande, ni la clé privée : seulement ce que le téléphone a montré, et sa signature. */
    expect(readFileSync(join(s.dir, PHONE_APPROVALS_FILE), "utf8")).not.toContain("SECRET CONTENT");
    /* Un caractère changé dans ce qui a été montré, ou dans le choix : la preuve ne tient plus. */
    expect(verifyPhoneApproval({ ...proof, shown: { ...proof.shown, title: `${proof.shown.title}!` } }).ok).toBe(false);
    expect(verifyPhoneApproval({ ...proof, choice: "reject" }).ok).toBe(false);
    expect(verifyPhoneApproval({ ...proof, device: { ...proof.device, publicKey: browser().device } }).ok).toBe(false);
  });

  it("speaks like a friend: the agent's question as the title, what it changes and the command below; the answer, signed, still checks", async () => {
    const s = await setup();
    const phone = await paired(s);
    await until(() => s.pushes.length === 1);
    const push = { agentName: "Claude Code", requestedValue: "", title: "", context: [{ label: "Action", value: "mcp.claude-code.shell" }, { label: "Target", value: "shell:///home/awa/app" }, { label: "command", value: "git push origin main" }, { label: "reason", value: "Oathrion: a push publishes your commits. Allow it?" }] };
    await s.computer.deliver(approval({ data: { action: "mcp.claude-code.shell", command: "git push origin main", words: notificationWords(push, null), mascot: { id: "ember", name: "elias" } } }));
    const card = phone.decrypt(s.pushes.at(-1)!.body) as Record<string, unknown> & { route: string; nonce: string; actions: { label: string }[] };
    expect(card).toMatchObject({ style: "friendly", agent: "elias", mascot: "ember", title: "Can I publish your code to the shared repository?", body: "Your team will see it.\n\ngit push origin main" });
    expect(card.actions.map((a) => a.label)).toEqual(["Yes, go ahead", "No"]);
    const at = Date.now();
    const sig = phone.sign(`press|${card.route}|${card.nonce}|approve|${String(at)}`);
    const signed = phone.sign(approvalData({ shown: shownOf(card), nonce: card.nonce, choice: "approve", at }));
    expect((await s.post("/v1/web/press", { route: card.route, nonce: card.nonce, choice: "approve", at, device: phone.device, sig, approval: signed })).status).toBe(200);
    await until(() => s.decided.length === 1);
    expect(verifyPhoneApproval(readPhoneApprovals(s.dir).get("exe_1")).ok).toBe(true);
    /* L'agent répond, comme dans une conversation. */
    await until(() => s.pushes.some((p) => phone.decrypt(p.body).title === "Thanks, I'm going ahead."));
    expect(phone.decrypt(s.pushes.at(-1)!.body)).toMatchObject({ style: "friendly", body: "You answered: Can I publish your code to the shared repository?" });
  });

  it("the phone's page computes the same fingerprint of what it showed as the computer", async () => {
    const source = readFileSync(join(__dirname, "../../relay/public/common.js"), "utf8");
    const oath = new Function(`${source}; return OATH;`)() as { shownDigest: (data: Record<string, unknown>) => Promise<string> };
    const card = { v: 1, route: "AAAAAAAAAAA", tag: "t", nonce: "abcdefghijkl", title: "Claude Code wants to run: rm -rf dist/ « é »", body: "rule rm-recursive", agent: "Claude Code", computer: "FORCE-N", at: 1_800_000_000_000, actions: [] };
    expect(await oath.shownDigest(card)).toBe(shownDigest(shownOf(card)));
    expect(await oath.shownDigest({ route: "r", title: "t" })).toBe(shownDigest(shownOf({ route: "r", title: "t" })));
  });

  it("loses its buttons when decided on the computer", async () => {
    const s = await setup();
    const phone = await paired(s);
    await s.computer.deliver(approval());
    await s.computer.settled("ntf_1", "Approved (on your computer)");
    const last = phone.decrypt(s.pushes.at(-1)!.body) as { body: string; actions: unknown[]; silent: boolean };
    expect(last).toMatchObject({ actions: [], silent: true });
    expect(last.body).toContain("Approved (on your computer)");
  });
});

describe("phone in one scan, by the browser: a connection that dies without saying so", () => {
  it("is noticed by the heartbeat, and the computer reconnects by itself", async () => {
    /* Le relais redéployé, une box qui coupe : la connexion se tait sans se fermer (essai réel du 23 novembre). */
    let mute = false;
    let opened = 0;
    class MutableSocket extends WebSocket {
      constructor(url: string | URL) {
        super(url);
        opened += 1;
        /* La nouvelle connexion, elle, entend le relais. */
        if (opened >= 2) mute = false;
      }
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
        if (type !== "message") return super.addEventListener(type, listener, options);
        super.addEventListener(type, (event) => {
          if (!mute) (listener as (event: Event) => void)(event);
        }, options);
      }
    }
    const s = await setup({ WebSocketImpl: MutableSocket as unknown as typeof WebSocket, heartbeatMs: 40, silentMs: 200 });
    await paired(s);
    await until(() => s.pushes.length === 1);
    mute = true;
    await until(() => opened >= 2, 3_000);
    await until(() => s.computer.status().state === "paired" && (s.computer.status() as { online: boolean }).online);
    expect(await s.computer.deliver(approval())).toBe(true);
  });
});

describe("phone in one scan, by the browser: unpairing", () => {
  it("Unpair this phone, on the page, unpairs the computer at its next notification", async () => {
    const s = await setup();
    const phone = await paired(s);
    await new Promise((done) => setTimeout(done, 5));
    const at = Date.now();
    expect((await s.post("/v1/web/unpair", { device: phone.device, at, sig: phone.sign(`unpair|${phone.device}|${String(at)}`) })).status).toBe(200);
    await expect(s.computer.deliver(approval())).rejects.toThrow(/not paired/);
    await until(() => !s.computer.configured);
  });

  it("a browser that withdrew the permission unpairs", async () => {
    const s = await setup();
    await paired(s);
    await until(() => s.pushes.length === 1);
    s.setStatus(410);
    await expect(s.computer.deliver(approval())).rejects.toThrow(/no longer accepts/);
    await until(() => s.computer.status().state === "idle");
    expect(s.computer.status()).toMatchObject({ notice: expect.stringContaining("pair again") });
  });
});
