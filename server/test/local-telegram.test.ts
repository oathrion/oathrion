/**
 * DÉCIDER DEPUIS SON TÉLÉPHONE (`server/local-telegram.ts`, `cli/wrap/phone.ts`) contre un faux
 * Telegram : la carte part avec ses boutons ; seul le compte appairé, dans sa conversation, décide ;
 * une décision ne se prend qu'une fois ; les secrets ne quittent pas la machine ; l'appairage
 * attend le code envoyé depuis le téléphone.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPhone } from "../../cli/wrap/phone";
import { readTelegram, redactForPhone, TelegramPhone, writeTelegram, TELEGRAM_FILE } from "../local-telegram";
import { desktopText } from "../notifications/desktop";
import type { NotificationEvent } from "../notifications/types";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";

type Call = { method: string; body: Record<string, unknown> };

/** Un faux Telegram : chaque appel est noté ; `updates` est servi au prochain getUpdates. */
function fakeTelegram() {
  const calls: Call[] = [];
  let updates: unknown[] = [];
  let nextId = 500;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) for (const [key, value] of init.body.entries()) body[key] = typeof value === "string" ? value : "(file)";
    else if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    let result: unknown = true;
    if (method === "getMe") result = { username: "oathrion_test_bot" };
    if (method === "getUpdates") {
      /* Comme Telegram, une attente quand rien n'est arrivé (l'attente longue). */
      if (updates.length === 0) await new Promise((done) => setTimeout(done, 10));
      result = updates;
      updates = [];
    }
    if (method === "sendPhoto" || method === "sendMessage") result = { message_id: nextId++ };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl, serve: (u: unknown[]) => (updates = u) };
}

const approval = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id: "ntf_1",
  type: "approval.requested",
  at: "2026-11-12T08:00:00Z",
  title: "Approval required",
  summary: "",
  risk: "medium",
  agentId: "agt_claude",
  agentName: "Claude Code",
  executionId: "exe_1",
  approvalId: "apr_1",
  policyId: null,
  policyName: null,
  data: { action: "mcp.github.create_pull_request", image: join(process.cwd(), "client", "public", "mascots", "warden.png") },
  ...over,
});

function phone() {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-phone-"));
  const telegram = fakeTelegram();
  const acted: string[] = [];
  const judged: [boolean, string][] = [];
  const channel = new TelegramPhone({
    dir,
    fetchImpl: telegram.fetchImpl,
    text: desktopText,
    act: (_event, action) => {
      acted.push(action);
      return action === "approve" ? "Approved: the action runs." : "Rejected.";
    },
    feedback: (_event, right, decision) => judged.push([right, decision]),
  });
  return { dir, telegram, acted, judged, channel };
}

const press = (id: number, data: string, from = 42, chat = 42) => ({ update_id: id, callback_query: { id: `cb${String(id)}`, from: { id: from }, data, message: { message_id: 500, chat: { id: chat } } } });

describe("le téléphone (Telegram)", () => {
  it("rien n'est envoyé tant qu'aucun téléphone n'est appairé", async () => {
    const { channel, telegram, dir } = phone();
    expect(await channel.deliver(approval())).toBe(false);
    writeTelegram(dir, { token: TOKEN, bot: "b", pairCode: "abcd" });
    expect(await channel.deliver(approval())).toBe(false);
    expect(telegram.calls).toEqual([]);
  });

  it("la carte part avec la mascotte, les mots de la notification et Approve / Reject", async () => {
    const { channel, telegram, dir } = phone();
    writeTelegram(dir, { token: TOKEN, bot: "b", chatId: 42, userId: 42 });
    expect(await channel.deliver(approval())).toBe(true);
    const sent = telegram.calls[0]!;
    expect(sent.method).toBe("sendPhoto");
    expect(sent.body.chat_id).toBe("42");
    expect(sent.body.photo).toBe("(file)");
    expect(String(sent.body.caption)).toContain('Claude Code wants to use "create_pull_request"');
    const keyboard = JSON.parse(String(sent.body.reply_markup)) as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(keyboard.inline_keyboard[0]!.map((b) => b.text)).toEqual(["Approve", "Reject"]);
    expect(keyboard.inline_keyboard[0]![0]!.callback_data).toMatch(/^[A-Za-z0-9_-]{12}:approve$/);
  });

  it("seul le compte appairé, dans sa conversation, décide ; une seule fois ; puis 👍 / 👎", async () => {
    const { channel, telegram, dir, acted, judged } = phone();
    writeTelegram(dir, { token: TOKEN, bot: "b", chatId: 42, userId: 42 });
    await channel.deliver(approval());
    const markup = JSON.parse(String(telegram.calls[0]!.body.reply_markup)) as { inline_keyboard: { callback_data: string }[][] };
    const approve = markup.inline_keyboard[0]![0]!.callback_data;
    const id = approve.split(":")[0]!;

    /* Un autre compte, ou une autre conversation : ignorés, sans réponse. */
    telegram.serve([press(1, approve, 7, 42), press(2, approve, 42, 99), press(3, `forged:approve`)]);
    expect(await channel.poll(0)).toBe(1);
    expect(acted).toEqual([]);

    telegram.serve([press(4, approve), press(5, approve)]);
    await channel.poll(0);
    expect(acted).toEqual(["approve"]);
    const edited = telegram.calls.find((c) => c.method === "editMessageCaption")!;
    expect(String(edited.body.caption)).toContain("✓ Approved: the action runs. (from your phone)\nWas this right?");
    expect(JSON.stringify(edited.body.reply_markup)).toContain(`${id}:right`);

    telegram.serve([press(6, `${id}:right`)]);
    await channel.poll(0);
    expect(judged).toEqual([[true, "Approved: the action runs. (from your phone)"]]);
    /* Le décalage avance : un appui déjà lu ne revient pas. */
    expect(telegram.calls.filter((c) => c.method === "getUpdates").at(-1)!.body.offset).toBe(6);
  });

  it("ce qui sort de la machine : les clés et les jetons sont masqués, un chemin reste lisible", () => {
    const line = "curl -H 'Authorization: Bearer abc.def' https://api.stripe.com -d key=sk_live_51HxyzABCDEFGH ghp_abcdefghijklmnop1234 /home/awa/projects/lumen/src/index.js";
    const shown = redactForPhone(line);
    expect(shown).not.toContain("sk_live_51HxyzABCDEFGH");
    expect(shown).not.toContain("ghp_abcdefghijklmnop1234");
    expect(shown).not.toContain("abc.def");
    expect(shown).toContain("/home/awa/projects/lumen/src/index.js");
    expect(redactForPhone("export TOKEN=QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789abcdefXYZ")).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789abcdefXYZ");
  });
});

describe("oathrion phone", () => {
  it("telegram <jeton> : attend le code envoyé depuis le téléphone, puis l'appairage est posé (0600) et le son envoyé", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-phone-home-"));
    const env = { OATHRION_WRAP_HOME: home } as NodeJS.ProcessEnv;
    const telegram = fakeTelegram();
    const lines: string[] = [];
    const run = runPhone(["telegram", TOKEN], { out: (l) => lines.push(l), err: (l) => lines.push(l), env, fetchImpl: telegram.fetchImpl, pairWithinMs: 5_000 });
    /* Le téléphone envoie le code affiché ; un message d'un groupe, ou un autre texte, ne compte pas. */
    await new Promise((done) => setTimeout(done, 50));
    const dir = join(home, "_local");
    const code = readTelegram(dir)!.pairCode!;
    telegram.serve([
      { update_id: 10, message: { chat: { id: -100, type: "group" }, from: { id: 9 }, text: code } },
      { update_id: 11, message: { chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hello" } },
      { update_id: 12, message: { chat: { id: 42, type: "private" }, from: { id: 42 }, text: `/start ${code}` } },
    ]);
    expect(await run).toBe(0);
    expect(readTelegram(dir)).toEqual({ token: TOKEN, bot: "oathrion_test_bot", chatId: 42, userId: 42 });
    expect(statSync(join(dir, TELEGRAM_FILE)).mode & 0o777).toBe(0o600);
    expect(telegram.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["getMe", "deleteWebhook", "sendMessage", "sendAudio"]));
    expect(lines.join("\n")).toContain(`send this code: ${code}`);
    expect(lines.join("\n")).toContain("✓ Paired");
  });

  it("sans jeton en argument : il est demandé au clavier ; rien de tapé, rien de changé", async () => {
    const telegram = fakeTelegram();
    const asked: string[] = [];
    const io = (answer: string | null) => ({ out: () => undefined, err: () => undefined, env: { OATHRION_WRAP_HOME: mkdtempSync(join(tmpdir(), "oathrion-phone-")) }, fetchImpl: telegram.fetchImpl, askSecret: async (q: string) => (asked.push(q), answer) });
    expect(await runPhone(["telegram"], io(null))).toBe(3);
    expect(await runPhone(["telegram"], io("  "))).toBe(3);
    expect(await runPhone(["telegram"], io("pas-un-jeton"))).toBe(3);
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain("it is not shown");
    expect(telegram.calls).toEqual([]);
  });

  it("un jeton qui n'en a pas la forme est refusé sans rien appeler", async () => {
    const telegram = fakeTelegram();
    const lines: string[] = [];
    expect(await runPhone(["telegram", "nope"], { out: (l) => lines.push(l), err: (l) => lines.push(l), env: { OATHRION_WRAP_HOME: mkdtempSync(join(tmpdir(), "oathrion-phone-")) }, fetchImpl: telegram.fetchImpl })).toBe(3);
    expect(telegram.calls).toEqual([]);
  });
});
