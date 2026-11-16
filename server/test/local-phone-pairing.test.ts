/**
 * APPAIRER SON TÉLÉPHONE DEPUIS LA CONSOLE (16 novembre, `server/local-phone-pairing.ts`) contre
 * un faux Telegram : un jeton mal formé ou refusé le dit ; un bon jeton donne le lien et son QR
 * code ; seul le bon code, en conversation privée, appaire ; un essai part ensuite sur le
 * téléphone ; sans réponse, l'attente s'arrête.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PhonePairing } from "../local-phone-pairing";
import { readTelegram } from "../local-telegram";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";

function fakeTelegram(refuse = false) {
  const calls: string[] = [];
  let updates: unknown[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const method = String(url).split("/").pop()!;
    calls.push(method);
    if (refuse) return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    let result: unknown = true;
    if (method === "getMe") result = { username: "oathrion_abcde_bot" };
    if (method === "getUpdates") {
      if (updates.length === 0) await new Promise((done) => setTimeout(done, 10));
      result = updates;
      updates = [];
    }
    if (method === "sendPhoto" || method === "sendMessage") result = { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl, serve: (u: unknown[]) => (updates = u) };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((done) => setTimeout(done, 10));
};

describe("appairer le téléphone depuis la console", () => {
  it("un jeton mal formé, ou refusé par Telegram : la raison, et rien n'est écrit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-pair-"));
    expect(await new PhonePairing(dir, { fetchImpl: fakeTelegram().fetchImpl }).start("pas un jeton")).toMatchObject({ state: "failed", message: expect.stringMatching(/That is not a bot token/) });
    expect(await new PhonePairing(dir, { fetchImpl: fakeTelegram(true).fetchImpl }).start(TOKEN)).toMatchObject({ state: "failed", message: expect.stringMatching(/Telegram refused this token/) });
    expect(readTelegram(dir)).toBeNull();
  });

  it("un bon jeton : le lien et son QR code ; seul le bon code, en privé, appaire ; un essai part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-pair-"));
    const telegram = fakeTelegram();
    const pairing = new PhonePairing(dir, { fetchImpl: telegram.fetchImpl });
    const waiting = await pairing.start(` ${TOKEN} `);
    if (waiting.state !== "waiting") throw new Error(`expected waiting, got ${waiting.state}`);
    expect(waiting.link).toBe(`https://t.me/oathrion_abcde_bot?start=${waiting.code}`);
    expect(waiting.qr.cells).toHaveLength(waiting.qr.size * waiting.qr.size);

    /* Un autre code, puis un groupe : ignorés. */
    telegram.serve([
      { update_id: 1, message: { chat: { id: 7, type: "private" }, from: { id: 7 }, text: "/start deadbeef" } },
      { update_id: 2, message: { chat: { id: -9, type: "group" }, from: { id: 7 }, text: `/start ${waiting.code}` } },
    ]);
    await new Promise((done) => setTimeout(done, 60));
    expect(pairing.status().state).toBe("waiting");

    telegram.serve([{ update_id: 3, message: { chat: { id: 42, type: "private" }, from: { id: 42 }, text: `/start ${waiting.code}` } }]);
    await until(() => pairing.status().state === "paired");
    expect(pairing.status()).toEqual({ state: "paired", bot: "oathrion_abcde_bot" });
    expect(readTelegram(dir)).toMatchObject({ token: TOKEN, bot: "oathrion_abcde_bot", chatId: 42, userId: 42 });
    expect(telegram.calls.filter((m) => m === "sendMessage" || m === "sendPhoto")).toHaveLength(1);
  });

  it("sans réponse du téléphone : l'attente s'arrête, la console propose un nouveau code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-pair-"));
    const pairing = new PhonePairing(dir, { fetchImpl: fakeTelegram().fetchImpl, withinMs: 50 });
    await pairing.start(TOKEN);
    await until(() => pairing.status().state === "expired");
    expect(pairing.status()).toEqual({ state: "expired", bot: "oathrion_abcde_bot" });
  });
});
