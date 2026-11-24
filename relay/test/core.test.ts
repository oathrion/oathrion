import { describe, expect, it } from "vitest";

import { b64u, type Conn, framed, machineOf, MemoryRevocations, readTicket, RelayCore, RelayKeys, signTicket, TelegramClient, type TelegramUpdate, verifySigned } from "../src/core.ts";

/** Un faux Telegram : chaque appel est noté ; `fail` fait échouer une méthode. */
function fakeTelegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fail = new Map<string, { code: number; description: string }>();
  let nextId = 100;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ method, body });
    const failure = fail.get(method);
    if (failure) return new Response(JSON.stringify({ ok: false, error_code: failure.code, description: failure.description }));
    const result = method === "sendPhoto" ? { message_id: nextId++, photo: [{ file_id: "small_file_id_000" }, { file_id: "large_file_id_000" }] } : method.startsWith("send") ? { message_id: nextId++ } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  return { calls, fail, client: new TelegramClient("123:SECRET", fetchImpl, "https://telegram.test") };
}

async function newKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    pkcs8: b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    sign: async (data: string) => b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(data)))),
  };
}

async function setup(now = { t: 1_800_000_000_000 }) {
  const relayKey = await newKeyPair();
  const keys = await RelayKeys.load(relayKey.pkcs8);
  const telegram = fakeTelegram();
  const revocations = new MemoryRevocations();
  const core = new RelayCore({ bot: "OathrionBot", telegram: telegram.client, keys, revocations, salt: "salt", now: () => now.t });
  const conns: Conn[] = [];
  const room = async (route: string) => conns.filter((c) => c.session.machine?.startsWith(route));

  /** Une machine qui se connecte : sa clé, ses messages reçus, sa connexion. */
  async function machine(options: { ticket?: string; claim?: string; key?: Awaited<ReturnType<typeof newKeyPair>> } = {}) {
    const key = options.key ?? (await newKeyPair());
    const id = await machineOf(key.publicKey);
    const received: Record<string, unknown>[] = [];
    const closed: { code: number; reason: string }[] = [];
    const { session, hello } = core.open(options.claim ?? id);
    const conn: Conn = { session, send: (m) => received.push(m as Record<string, unknown>), close: (code, reason) => closed.push({ code, reason }) };
    conns.push(conn);
    const challenge = (hello as { challenge: string }).challenge;
    const say = (message: object) => core.onMessage(conn, JSON.stringify(message), room);
    await say({ t: "auth", key: key.publicKey, sig: await key.sign(`oathrion-relay-v1|connect|${challenge}`), ...(options.ticket ? { ticket: options.ticket } : {}) });
    return { key, id, conn, received, closed, say, last: (t: string) => [...received].reverse().find((m) => m.t === t) };
  }

  const update = (u: Partial<TelegramUpdate>) => core.onUpdate({ update_id: 1, ...u } as TelegramUpdate, room);
  const start = (code: string, user = 42, chat = 42, type = "private") => update({ message: { message_id: 1, chat: { id: chat, type }, from: { id: user, username: "abdoulaye" }, text: `/start ${code}` } });
  const press = (data: string, user = 42, chat = 42) => update({ callback_query: { id: `press-${String(Math.random()).slice(2, 8)}`, from: { id: user }, data, message: { message_id: 100, chat: { id: chat } } } });

  /** Une machine appairée au compte 42. */
  async function pairedMachine(label = "Laptop") {
    const m = await machine();
    await m.say({ t: "pair.begin", kind: "telegram", label });
    await start(m.last("code")!.code as string);
    const ticket = m.last("paired")!.ticket as string;
    return { ...m, ticket };
  }

  return { core, keys, relayKey, telegram, revocations, conns, room, machine, update, start, press, pairedMachine, now };
}

describe("relay: the pivot proves its key", () => {
  it("answers ready after a good signature, closes after a bad one or a wrong machine", async () => {
    const s = await setup();
    const good = await s.machine();
    expect(good.last("ready")).toMatchObject({ bot: "OathrionBot", paired: false });
    expect(good.conn.session.machine).toBe(good.id);

    const other = await newKeyPair();
    const liar = await s.machine({ claim: await machineOf(other.publicKey) });
    expect(liar.closed[0]?.code).toBe(4003);

    const { session } = s.core.open(null);
    const closed: number[] = [];
    await s.core.onMessage({ session, send: () => undefined, close: (code) => closed.push(code) }, JSON.stringify({ t: "auth", key: other.publicKey, sig: await other.sign("oathrion-relay-v1|connect|not-the-challenge") }), s.room);
    expect(closed).toEqual([4003]);
  });

  it("refuses everything but auth first", async () => {
    const s = await setup();
    const { session } = s.core.open(null);
    const closed: number[] = [];
    await s.core.onMessage({ session, send: () => undefined, close: (code) => closed.push(code) }, JSON.stringify({ t: "pair.begin" }), s.room);
    expect(closed).toEqual([4001]);
  });

  it("closes the older connection of the same machine", async () => {
    const s = await setup();
    const first = await s.machine();
    await s.machine({ key: first.key });
    expect(first.closed).toEqual([{ code: 4000, reason: "replaced" }]);
  });
});

describe("relay: pairing in one scan", () => {
  it("pairs the account that sent the one-time code, and signs a ticket for this machine", async () => {
    const s = await setup();
    const m = await s.machine();
    await m.say({ t: "pair.begin", kind: "telegram", label: "Abdoulaye's laptop" });
    const code = m.last("code")!.code as string;
    expect(code).toHaveLength(33);
    expect(code.startsWith(m.id.slice(0, 11))).toBe(true);

    await s.start(code);
    const ticket = await readTicket(s.keys.publicKey, m.last("paired")!.ticket as string);
    expect(ticket).toMatchObject({ machine: m.id, chat: 42, user: 42, account: "@abdoulaye", label: "Abdoulaye's laptop" });
    expect(s.telegram.calls.at(-1)?.body.text).toContain("Paired with Abdoulaye's laptop");

    /* Usage unique : le même code, une seconde fois, ne fait rien. */
    await s.start(code, 99, 99);
    expect(m.received.filter((r) => r.t === "paired")).toHaveLength(1);
    expect(s.telegram.calls.at(-1)?.body.text).toContain("expired, or was used already");
  });

  it("ignores an expired code, a guessed one, and a group chat", async () => {
    const s = await setup();
    const m = await s.machine();
    await m.say({ t: "pair.begin", kind: "telegram" });
    const code = m.last("code")!.code as string;
    await s.start(`${code.slice(0, 11)}${"A".repeat(22)}`);
    await s.start(code, 42, -100, "group");
    expect(m.last("paired")).toBeUndefined();
    s.now.t += 10 * 60_000 + 1;
    await s.start(code);
    expect(m.last("paired")).toBeUndefined();
  });

  it("gives at most five codes in ten minutes", async () => {
    const s = await setup();
    const m = await s.machine();
    for (let i = 0; i < 6; i += 1) await m.say({ t: "pair.begin", kind: "telegram" });
    expect(m.received.filter((r) => r.t === "code")).toHaveLength(5);
    expect(m.last("error")).toMatchObject({ code: "rate" });
  });

  it("answers /start without a code, and any other message, with a help text", async () => {
    const s = await setup();
    await s.update({ message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text: "/start" } });
    expect(s.telegram.calls.at(-1)?.body.text).toContain("Pair my phone");
  });
});

describe("relay: the ticket", () => {
  it("is accepted again after a restart of the relay, only with the key of its machine", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    const again = await s.machine({ key: m.key, ticket: m.ticket });
    expect(again.last("ready")).toMatchObject({ paired: true, account: "@abdoulaye" });

    const thief = await s.machine({ ticket: m.ticket });
    expect(thief.last("ready")).toMatchObject({ paired: false });
    expect(thief.last("unpaired")).toBeDefined();
  });

  it("is refused when tampered with", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    const [data, sig] = m.ticket.split(".");
    const forged = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    forged.chat = 666;
    const again = await s.machine({ key: m.key, ticket: `${b64u(new TextEncoder().encode(JSON.stringify(forged)))}.${sig!}` });
    expect(again.last("ready")).toMatchObject({ paired: false });
  });
});

describe("relay: messages to the phone", () => {
  it("sends to the paired chat only, framed, without clickable links, with routed buttons", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    await m.say({ t: "send", ref: "r1", text: "Claude Code wants to run: curl https://evil.example/x\n\nWhy: network.", buttons: [[{ label: "Approve", data: "abcdefghijkl:approve" }]] });
    const sent = s.telegram.calls.at(-1)!;
    expect(sent.method).toBe("sendMessage");
    expect(sent.body.chat_id).toBe(42);
    expect(sent.body.text).not.toContain("https://evil.example");
    expect(sent.body.text).toContain("— Oathrion on Laptop, paired");
    expect((sent.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data).toBe(`${m.id.slice(0, 11)}.abcdefghijkl:approve`);
    expect(m.last("sent")).toMatchObject({ ref: "r1", photo: false });
  });

  it("uploads a small PNG once, then reuses its file id", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    const png = b64u(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    await m.say({ t: "send", ref: "p", text: "Hi", photo: { png } });
    expect(m.last("sent")).toMatchObject({ photo: true, fileId: "large_file_id_000" });
    await m.say({ t: "send", ref: "q", text: "Hi", photo: { fileId: "large_file_id_000" } });
    expect(s.telegram.calls.at(-1)?.body.photo).toBe("large_file_id_000");
  });

  it("refuses to send for an unpaired machine, and closes on a forged button", async () => {
    const s = await setup();
    const m = await s.machine();
    await m.say({ t: "send", ref: "x", text: "Hi" });
    expect(m.last("error")).toMatchObject({ code: "unpaired" });
    const p = await s.pairedMachine();
    await p.say({ t: "send", ref: "y", text: "Hi", buttons: [[{ label: "Go", data: "OTHERROUTE.x:approve" }]] });
    expect(p.closed[0]?.code).toBe(1008);
  });

  it("limits each machine to a burst of five messages", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    for (let i = 0; i < 7; i += 1) await m.say({ t: "send", ref: String(i), text: "Hi" });
    expect(m.received.filter((r) => r.t === "sent")).toHaveLength(5);
    expect(m.last("error")).toMatchObject({ code: "rate" });
    s.now.t += 60_000;
    await m.say({ t: "send", ref: "later", text: "Hi" });
    expect(m.last("sent")).toMatchObject({ ref: "later" });
  });

  it("unpairs when the person blocked the bot", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    s.telegram.fail.set("sendMessage", { code: 403, description: "Forbidden: bot was blocked by the user" });
    await m.say({ t: "send", ref: "b", text: "Hi" });
    expect(JSON.parse(m.last("unpaired")!.p as string)).toMatchObject({ reason: "blocked", machine: m.id });
    expect(m.conn.session.ticket).toBeNull();
  });
});

describe("relay: a button pressed on the phone", () => {
  it("reaches the right machine, signed by the relay", async () => {
    const s = await setup();
    const a = await s.pairedMachine("A");
    const b = await s.pairedMachine("B");
    await s.press(`${a.id.slice(0, 11)}.abcdefghijkl:approve`);
    const press = a.last("press")!;
    expect(await verifySigned(s.keys.publicKey, "press", press.p as string, press.s as string)).toBe(true);
    expect(JSON.parse(press.p as string)).toMatchObject({ machine: a.id, nonce: "abcdefghijkl", choice: "approve" });
    expect(b.last("press")).toBeUndefined();

    /* La machine répond à l'appui qu'on lui a transmis, pas à un autre. */
    const pressId = JSON.parse(press.p as string).pressId as string;
    await a.say({ t: "answer", pressId, text: "Approved" });
    expect(s.telegram.calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", body: { callback_query_id: pressId } });
    const before = s.telegram.calls.length;
    await b.say({ t: "answer", pressId: "someone-else", text: "x" });
    expect(s.telegram.calls.length).toBe(before);
  });

  it("ignores a press by another account, or in another chat", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    await s.press(`${m.id.slice(0, 11)}.abcdefghijkl:approve`, 666, 42);
    await s.press(`${m.id.slice(0, 11)}.abcdefghijkl:approve`, 42, 666);
    expect(m.last("press")).toBeUndefined();
  });

  it("says the computer is offline when nothing is connected", async () => {
    const s = await setup();
    await s.press("AAAAAAAAAAA.abcdefghijkl:approve");
    expect(s.telegram.calls.at(-1)?.body.text).toContain("offline");
  });
});

describe("relay: revocation", () => {
  it("/stop unpairs every machine of the account, even one that reconnects later", async () => {
    const s = await setup();
    const m = await s.pairedMachine();
    s.now.t += 1000;
    await s.update({ message: { message_id: 2, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/stop" } });
    expect(s.revocations.entries.size).toBe(1);
    /* L'empreinte salée, pas l'identifiant. */
    expect([...s.revocations.entries.keys()][0]).not.toContain("42");

    await s.press(`${m.id.slice(0, 11)}.abcdefghijkl:approve`);
    expect(m.last("press")).toBeUndefined();
    const later = await s.machine({ key: m.key, ticket: m.ticket });
    expect(JSON.parse(later.last("unpaired")!.p as string)).toMatchObject({ reason: "revoked" });

    /* Appairé de nouveau après le /stop : valable. */
    s.now.t += 1000;
    await later.say({ t: "pair.begin", kind: "telegram" });
    await s.start(later.last("code")!.code as string);
    expect(later.last("paired")).toBeDefined();
  });

  it("Unpair from the console tells the phone and drops the ticket", async () => {
    const s = await setup();
    const m = await s.pairedMachine("Laptop");
    await m.say({ t: "unpair", ref: "u1" });
    expect(s.telegram.calls.at(-1)?.body.text).toContain("Laptop is unpaired");
    expect(m.last("unpaired")).toMatchObject({ ref: "u1" });
    expect(JSON.parse(m.last("unpaired")!.p as string)).toMatchObject({ reason: "asked" });
  });
});

describe("relay: what leaves", () => {
  it("frames the text, and keeps its lines", () => {
    const text = framed("Title\n\nWhy: x.y", { v: 1, id: "i", machine: "m", chat: 1, user: 1, account: "@a", label: "PC", at: Date.UTC(2026, 10, 23) });
    expect(text.split("\n")[0]).toBe("Title");
    expect(text).toContain("paired 2026-11-23");
  });

  it("never puts the bot token in an error", async () => {
    const s = await setup();
    s.telegram.fail.set("getMe", { code: 401, description: "Unauthorized" });
    await expect(s.telegram.client.call("getMe")).rejects.toThrow(/^Unauthorized$/);
  });

  it("signs tickets that only the relay key verifies", async () => {
    const s = await setup();
    const other = await RelayKeys.load((await newKeyPair()).pkcs8);
    const ticket = await signTicket(other, { v: 1, id: "i", machine: "m", chat: 1, user: 1, account: "a", label: "l", at: 0 });
    expect(await readTicket(s.keys.publicKey, ticket)).toBeNull();
    expect(await readTicket(other.publicKey, ticket)).not.toBeNull();
  });
});
