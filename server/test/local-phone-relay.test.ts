/**
 * LE TÉLÉPHONE EN UN SCAN (`server/local-phone-relay.ts`, `relay/`) : le vrai relais (l'adaptateur
 * Node, de vraies connexions WebSocket) contre un faux Telegram. On appaire en un Start ; une
 * demande part avec ses boutons ; l'appui revient signé et ne décide qu'une fois ; Unpair, /stop
 * et un robot bloqué désappairent ; un relais redémarré retrouve la machine par son ticket.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { b64u, MemoryRevocations, RelayCore, RelayKeys, TelegramClient, type TelegramUpdate } from "../../relay/src/core.ts";
import { startNodeRelay, type NodeRelay } from "../../relay/src/node.ts";
import { readRelay, RelayPhone, RELAY_FILE, verifyRelay } from "../local-phone-relay";
import { desktopText } from "../notifications/desktop";
import type { NotificationEvent } from "../notifications/types";

type Call = { method: string; body: Record<string, unknown> };

function fakeTelegram() {
  const calls: Call[] = [];
  const fail = new Map<string, number>();
  let nextId = 700;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) for (const [key, value] of init.body.entries()) body[key] = typeof value === "string" ? value : "(file)";
    else if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    const code = fail.get(method);
    if (code) return new Response(JSON.stringify({ ok: false, error_code: code, description: "Forbidden: bot was blocked by the user" }));
    const result = method === "sendPhoto" ? { message_id: nextId++, photo: [{ file_id: "mascot_file_id_0001" }] } : method.startsWith("send") ? { message_id: nextId++ } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof fetch;
  return { calls, fail, client: new TelegramClient("123:NOT-A-REAL-TOKEN", fetchImpl, "https://telegram.test") };
}

const approval = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id: "ntf_1",
  type: "approval.requested",
  at: "2026-11-23T08:00:00Z",
  title: "Approval required",
  summary: "",
  risk: "medium",
  agentId: "agt_claude",
  agentName: "Claude Code",
  executionId: "exe_1",
  approvalId: "apr_1",
  policyId: null,
  policyName: null,
  data: { action: "mcp.github.create_pull_request", image: join(process.cwd(), "client", "public", "mascots", "warden.png"), arguments: { body: "SECRET CONTENT" } },
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
    for (const phone of phones) phone.stop();
    await relay.close();
  }
  delete process.env.OATHRION_PHONE_RELAY_URL;
  delete process.env.OATHRION_PHONE_RELAY_KEY;
});

async function setup(keysPkcs8?: string) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = keysPkcs8 ?? b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const keys = await RelayKeys.load(pkcs8);
  const telegram = fakeTelegram();
  const revocations = new MemoryRevocations();
  const core = new RelayCore({ bot: "OathrionBot", telegram: telegram.client, keys, revocations, salt: "s" });
  const relay = await startNodeRelay({ core, telegram: telegram.client, port: 0, webhookSecret: "hook" });
  const entry = { relay, phones: [] as RelayPhone[] };
  running.push(entry);
  process.env.OATHRION_PHONE_RELAY_URL = `ws://127.0.0.1:${String(relay.port)}/v1/connect`;
  process.env.OATHRION_PHONE_RELAY_KEY = keys.publicKey;
  /* Le webhook, tel que Telegram l'appelle. */
  const hook = (update: Partial<TelegramUpdate>) =>
    fetch(`http://127.0.0.1:${String(relay.port)}/v1/telegram`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook" }, body: JSON.stringify({ update_id: 1, ...update }) });
  const phone = (dir = mkdtempSync(join(tmpdir(), "relay-phone-")), decided: string[] = []) => {
    const p = new RelayPhone(dir, { label: "Test laptop" }).bind({
      act: async (_event, action) => {
        decided.push(action);
        return action === "approve" ? "Approved" : "Rejected";
      },
      feedback: () => undefined,
      text: (event) => desktopText(event, { content: false }),
    });
    entry.phones.push(p);
    return { p, dir, decided };
  };
  return { relay, telegram, keys, pkcs8, hook, phone, revocations };
}

/** Appaire : « Pair my phone », puis le Start du téléphone sur le lien du QR code. */
async function paired(s: Awaited<ReturnType<typeof setup>>, user = 42) {
  const m = s.phone();
  const waiting = await m.p.pair();
  expect(waiting.state).toBe("waiting");
  const link = (waiting as { link: string }).link;
  expect(link).toMatch(/^https:\/\/t\.me\/OathrionBot\?start=[A-Za-z0-9_-]{33}$/);
  await s.hook({ message: { message_id: 1, chat: { id: user, type: "private" }, from: { id: user, username: "abdoulaye" }, text: `/start ${link.split("=")[1]!}` } });
  await until(() => m.p.status().state === "paired");
  return m;
}

/** Les données du dernier bouton envoyé qui porte ce texte. */
function buttonOf(s: Awaited<ReturnType<typeof setup>>, label: string): string {
  for (const call of [...s.telegram.calls].reverse()) {
    if (!call.body.reply_markup) continue;
    const markup = (typeof call.body.reply_markup === "string" ? JSON.parse(call.body.reply_markup) : call.body.reply_markup) as { inline_keyboard: { text: string; callback_data: string }[][] };
    const button = markup.inline_keyboard.flat().find((b) => b.text === label);
    if (button) return button.callback_data;
  }
  throw new Error(`no button ${label}`);
}

/** Le dernier bouton envoyé, pressé par ce compte. */
async function pressLast(s: Awaited<ReturnType<typeof setup>>, label: string, user = 42) {
  await s.hook({ callback_query: { id: `cq_${label}_${String(Date.now())}`, from: { id: user }, data: buttonOf(s, label), message: { message_id: 700, chat: { id: user } } } });
}

describe("phone in one scan: pairing", () => {
  it("pairs with one Start, keeps the key private, and sends a test card", async () => {
    const s = await setup();
    const m = await paired(s);
    expect(m.p.status()).toMatchObject({ state: "paired", bot: "OathrionBot", account: "@abdoulaye", online: true });
    expect(statSync(join(m.dir, RELAY_FILE)).mode & 0o777).toBe(0o600);
    await until(() => s.telegram.calls.some((c) => (c.method === "sendPhoto" || c.method === "sendMessage") && String(c.body.caption ?? c.body.text).includes("your phone is paired")));
  });

  it("says the relay is not live while it has no pinned key (a self-hosted relay without its key)", () => {
    process.env.OATHRION_PHONE_RELAY_URL = "wss://relay.example.test/v1/connect";
    const m = new RelayPhone(mkdtempSync(join(tmpdir(), "relay-none-")));
    expect(m.status().state).toBe("unavailable");
  });

  it("fails clearly when the relay is unreachable", async () => {
    /* Un port où plus rien n'écoute. */
    const { createServer } = await import("node:net");
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as { port: number }).port;
    await new Promise((done) => closed.close(done));
    process.env.OATHRION_PHONE_RELAY_URL = `ws://127.0.0.1:${String(port)}/v1/connect`;
    process.env.OATHRION_PHONE_RELAY_KEY = "A".repeat(43);
    const m = new RelayPhone(mkdtempSync(join(tmpdir(), "relay-off-")));
    const state = await m.pair();
    m.stop();
    expect(state).toMatchObject({ state: "failed", message: "The phone relay is unreachable." });
  });
});

describe("phone in one scan: a request", () => {
  it("arrives with its buttons and without its content; one press decides, once", async () => {
    const s = await setup();
    const m = await paired(s);
    expect(await m.p.deliver(approval())).toBe(true);
    const sent = s.telegram.calls.filter((c) => c.method === "sendPhoto" || c.method === "sendMessage").at(-1)!;
    expect(JSON.stringify(sent.body)).not.toContain("SECRET CONTENT");
    const approve = buttonOf(s, "Yes, go ahead");
    await s.hook({ callback_query: { id: "cq_1", from: { id: 42 }, data: approve, message: { message_id: 700, chat: { id: 42 } } } });
    await until(() => m.decided.length === 1);
    expect(m.decided).toEqual(["approve"]);
    await until(() => s.telegram.calls.some((c) => c.method.startsWith("editMessage") && String(c.body.caption ?? c.body.text).includes("Approved (from your phone)")));
    /* « Was this right? » suit. Le même bouton, une seconde fois, ne refait rien. */
    expect(buttonOf(s, "👍")).toMatch(/:right$/);
    await s.hook({ callback_query: { id: "cq_2", from: { id: 42 }, data: approve, message: { message_id: 700, chat: { id: 42 } } } });
    await new Promise((done) => setTimeout(done, 150));
    expect(m.decided).toEqual(["approve"]);
  });

  it("ignores a press by someone else", async () => {
    const s = await setup();
    const m = await paired(s);
    await m.p.deliver(approval());
    await pressLast(s, "Yes, go ahead", 666);
    await new Promise((done) => setTimeout(done, 150));
    expect(m.decided).toEqual([]);
  });

  it("loses its buttons when decided on the computer", async () => {
    const s = await setup();
    const m = await paired(s);
    await m.p.deliver(approval());
    await m.p.settled("ntf_1", "Approved (on your computer)");
    expect(s.telegram.calls.at(-1)).toMatchObject({ body: { reply_markup: { inline_keyboard: [] } } });
    expect(String(s.telegram.calls.at(-1)!.body.caption ?? s.telegram.calls.at(-1)!.body.text)).toContain("Approved (on your computer)");
  });

  it("sends the mascot once, then only its file id", async () => {
    const s = await setup();
    const m = await paired(s);
    await m.p.deliver(approval());
    await m.p.deliver(approval({ id: "ntf_2", approvalId: "apr_2" }));
    const photos = s.telegram.calls.filter((c) => c.method === "sendPhoto");
    expect(photos.at(-1)!.body.photo).toBe("mascot_file_id_0001");
  });
});

describe("phone in one scan: unpairing", () => {
  it("Unpair tells the phone and erases the key of this machine", async () => {
    const s = await setup();
    const m = await paired(s);
    await m.p.unpair();
    expect(readRelay(m.dir)).toBeNull();
    expect(s.telegram.calls.some((c) => String(c.body.text).includes("is unpaired"))).toBe(true);
    expect(m.p.status().state).toBe("idle");
  });

  it("/stop on the phone unpairs, and says so in the console", async () => {
    const s = await setup();
    const m = await paired(s);
    await new Promise((done) => setTimeout(done, 5));
    await s.hook({ message: { message_id: 2, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/stop" } });
    await until(() => s.revocations.entries.size === 1);
    await expect(m.p.deliver(approval())).rejects.toThrow(/not paired/);
    await until(() => m.p.status().state === "idle");
    expect(m.p.status()).toMatchObject({ notice: expect.stringContaining("/stop") });
  });

  it("a blocked bot unpairs", async () => {
    const s = await setup();
    const m = await paired(s);
    s.telegram.fail.set("sendPhoto", 403);
    await expect(m.p.deliver(approval())).rejects.toThrow(/stopped/);
    await until(() => !m.p.configured);
  });
});

describe("phone in one scan: the relay restarts", () => {
  it("finds the machine again by its ticket, without any database", async () => {
    const s = await setup();
    const m = await paired(s);
    const ticket = readRelay(m.dir)!.ticket;
    await s.relay.close();
    /* Le même relais (la même clé), redémarré : rien gardé, sauf la clé. */
    const again = await setup(s.pkcs8);
    /* Il écoute sur un autre port : l'adresse gardée à l'appairage change, rien d'autre. */
    const settings = JSON.parse(readFileSync(join(m.dir, RELAY_FILE), "utf8")) as { url: string };
    settings.url = `ws://127.0.0.1:${String(again.relay.port)}/v1/connect`;
    writeFileSync(join(m.dir, RELAY_FILE), JSON.stringify(settings));
    const back = again.phone(m.dir, m.decided);
    back.p.start();
    expect(await back.p.deliver(approval())).toBe(true);
    expect(readRelay(m.dir)!.ticket).toBe(ticket);
    await pressLast(again, "No");
    await until(() => m.decided.length === 1);
    expect(m.decided).toEqual(["reject"]);
  });

  it("verifies the relay signature with the pinned key only", async () => {
    const s = await setup();
    expect(verifyRelay(s.keys.publicKey, "press", "{}", "AAAA")).toBe(false);
    const sig = await s.keys.sign("press", "{}");
    expect(verifyRelay(s.keys.publicKey, "press", "{}", sig)).toBe(true);
    expect(verifyRelay(s.keys.publicKey, "unpaired", "{}", sig)).toBe(false);
  });
});
