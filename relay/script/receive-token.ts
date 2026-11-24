/**
 * LE JETON DU ROBOT, DEPUIS LE TÉLÉPHONE (23 novembre, essai réel du fondateur : « Telegram ne
 * s'est pas ouvert », puis le jeton restait sur le téléphone). Appelé par `deploy.sh` :
 *
 *   1. un QR code ouvre @BotFather sur le téléphone ;
 *   2. un second QR code ouvre une petite page, servie par CETTE machine sur le Wi-Fi, où le
 *      jeton se colle sur le téléphone même (BotFather le copie d'un appui) ;
 *   3. ou bien il se colle ici, dans le terminal, sans s'afficher.
 *
 * Le premier arrivé gagne. Le jeton sort sur la sortie standard (pour `deploy.sh`), rien d'autre.
 * La page vit à une adresse tirée au hasard, dix minutes au plus, et sert une seule fois.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const QRCode = createRequire(join(root, "package.json"))("qrcode") as { toString(text: string, options: object): Promise<string> };
const bot = process.argv[2] || "OathrionBot";
const SHAPE = /[0-9]{5,15}:[A-Za-z0-9_-]{30,64}/;
const say = (text: string) => process.stderr.write(`${text}\n`);
const qr = (text: string) => QRCode.toString(text, { type: "terminal", small: true });

let done = false;
const finish = (token: string) => {
  if (done) return;
  done = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${token}\n`);
  process.exit(0);
};

say("\n1. Scan this with your phone: Telegram opens on @BotFather.");
say(await qr("https://t.me/BotFather"));
say(`   Send /newbot, then « Oathrion », then « ${bot} ». BotFather answers with a token (123456789:AAH…).`);
say("   Tap the token in its message: Telegram copies it.\n");

/* La page du téléphone, sur le Wi-Fi de cette machine. */
const secret = randomBytes(12).toString("base64url");
const address = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oathrion</title>` +
  `<body style="font:17px system-ui;background:#06071c;color:#eef;padding:24px;max-width:480px;margin:auto">${body}</body>`;
const server = createServer((request, response) => {
  if (!request.url?.startsWith(`/${secret}`)) return void response.writeHead(404).end();
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      page(
        `<h2>Oathrion relay</h2><p>Paste the token BotFather gave you for @${bot}.</p>` +
          `<form method="post"><input name="token" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%;font:16px monospace;padding:12px;border-radius:10px;border:1px solid #88f;background:#111436;color:#fff">` +
          `<button style="margin-top:14px;width:100%;padding:12px;font:600 17px system-ui;border:0;border-radius:10px;background:linear-gradient(90deg,#7a5cff,#4a8cff);color:#fff">Send to my computer</button></form>`,
      ),
    );
    return;
  }
  let body = "";
  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
    if (body.length > 4096) request.destroy();
  });
  request.on("end", () => {
    const pasted = new URLSearchParams(body).get("token")?.trim() ?? "";
    const token = SHAPE.exec(pasted)?.[0];
    if (!token) {
      /* Ce qui a été reçu, sans le montrer : vide, ou combien de caractères (essai du fondateur, 23 novembre). */
      const what = pasted === "" ? "The field was empty: the paste did not go through." : `What arrived (${String(pasted.length)} characters) has no token in it.`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        page(
          `<p>${what}</p><p>A token looks like <code>123456789:AAH…</code>. In Telegram, tap the token in BotFather's message (it copies it), come back here, then hold your finger in the field and choose Paste.</p>` +
            `<p><a style="color:#9cf" href="/${secret}">Try again</a></p>`,
        ),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("<h2>✓ Sent</h2><p>Go back to your computer: Oathrion finishes there.</p>"));
    server.close();
    finish(token);
  });
});
if (address) {
  await new Promise<void>((ready) => server.listen(0, "0.0.0.0", ready));
  const url = `http://${address}:${String((server.address() as AddressInfo).port)}/${secret}`;
  say("2. Then scan this one, on the same Wi-Fi as this computer, and paste the token there:");
  say(await qr(url));
  say(`   (${url})\n`);
}

/* Ou ici, dans le terminal : rien ne s'affiche. */
say(`${address ? "Or paste" : "2. Paste"} the token here (it is not shown), then Enter:`);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  let typed = "";
  process.stdin.on("data", (chunk: Buffer) => {
    for (const char of chunk.toString("utf8")) {
      if (char === "\u0003") process.exit(130);
      if (char === "\r" || char === "\n") {
        const token = SHAPE.exec(typed)?.[0];
        if (token) return finish(token);
        say("That is not a token (123456789:AAH…). Paste it again, then Enter:");
        typed = "";
        continue;
      }
      typed += char;
    }
  });
}
setTimeout(() => {
  say("No token in ten minutes: run the script again when the bot is created.");
  process.exit(1);
}, 10 * 60_000).unref();
await new Promise(() => undefined);
