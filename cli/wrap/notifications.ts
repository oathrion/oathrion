/**
 * `oathrion notifications` — comment Oathrion prévient la personne qu'une action attend sa
 * décision (`server/local-notifications.ts`).
 *
 *   oathrion notifications                         l'état
 *   oathrion notifications slack <url du webhook>  prévenir aussi sur Slack
 *   oathrion notifications slack --retirer
 *   oathrion notifications bureau oui|non          la notification de bureau (oui par défaut)
 *   oathrion notifications tester                  un message d'essai, sur chaque canal
 *
 * Le réglage est dans `~/.oathrion/_local/notifications.json` (0600) ; le pivot le relit à
 * chaque envoi. L'adresse d'un webhook Slack porte son secret : elle n'est jamais affichée en
 * entier.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hubDir } from "./hub";

export const NOTIFICATIONS_USAGE = `
oathrion notifications                          the current settings
oathrion notifications slack <webhook url>      also notify on Slack (incoming webhook)
oathrion notifications slack --remove
oathrion notifications desktop on|off           the desktop notification (on by default)
oathrion notifications sound on|off             Oathrion's sound with each notification (on by default)
oathrion notifications test                     a test message, on every channel

  Slack notifies; the decision is made on your computer ("oathrion console") or in your
  client: the console only listens on 127.0.0.1.
`;

interface Settings {
  slackWebhookUrl?: string;
  desktop?: boolean;
  sound?: boolean;
}

const file = (env: NodeJS.ProcessEnv) => join(hubDir(env), "notifications.json");

function read(env: NodeJS.ProcessEnv): Settings {
  try {
    return JSON.parse(readFileSync(file(env), "utf8")) as Settings;
  } catch {
    return {};
  }
}

function write(env: NodeJS.ProcessEnv, settings: Settings): void {
  mkdirSync(hubDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(file(env), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** `https://hooks.slack.com/services/T…/B…/xxxx` → `https://hooks.slack.com/…/xxxx`, sans le secret. */
export function maskWebhook(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…${parsed.pathname.slice(-4).replace(/./g, "•")}`;
  } catch {
    return "(unreadable address)";
  }
}

/** Une adresse de webhook acceptable : https, sans identifiants dans l'adresse. */
export function webhookProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "this is not an address (expected: https://hooks.slack.com/services/…).";
  }
  if (parsed.protocol !== "https:") return "the address must start with https://.";
  if (parsed.username || parsed.password) return "the address must not contain credentials.";
  return null;
}

export async function runNotifications(argv: readonly string[], env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const [command, value] = argv;
  const settings = read(env);

  if (command === undefined) {
    out(`Desktop: ${settings.desktop === false ? "off" : "on"}`);
    out(`Sound: ${settings.sound === false ? "off" : "on"}`);
    out(`Slack: ${settings.slackWebhookUrl ? `on (${maskWebhook(settings.slackWebhookUrl)})` : 'off — "oathrion notifications slack <webhook url>"'}`);
    return 0;
  }

  if (command === "slack") {
    if (value === "--remove" || value === "--retirer") {
      delete settings.slackWebhookUrl;
      write(env, settings);
      out("Slack removed: Oathrion will no longer notify you on Slack.");
      return 0;
    }
    if (!value) {
      err(`The Slack incoming webhook address is missing.${NOTIFICATIONS_USAGE}`);
      return 3;
    }
    const problem = webhookProblem(value);
    if (problem) {
      err(`Webhook refused: ${problem}`);
      return 3;
    }
    write(env, { ...settings, slackWebhookUrl: value });
    out(`Slack connected (${maskWebhook(value)}). "oathrion notifications test" sends a test message.`);
    return 0;
  }

  if (command === "sound" || command === "son") {
    const on = value === "on" || value === "oui";
    if (!on && value !== "off" && value !== "non") {
      err(`"sound" expects on or off.${NOTIFICATIONS_USAGE}`);
      return 3;
    }
    write(env, { ...settings, sound: on });
    out(on ? "Oathrion's sound: on." : "Oathrion's sound: off.");
    return 0;
  }

  /* Les anciens mots français restent compris : `bureau oui|non`, `tester`. */
  if (command === "desktop" || command === "bureau") {
    const on = value === "on" || value === "oui";
    if (!on && value !== "off" && value !== "non") {
      err(`"desktop" expects on or off.${NOTIFICATIONS_USAGE}`);
      return 3;
    }
    write(env, { ...settings, desktop: on });
    out(on ? "Desktop notification: on." : "Desktop notification: off.");
    return 0;
  }

  if (command === "test" || command === "tester") {
    let worst = 0;
    if (settings.desktop !== false) {
      const sent =
        process.platform === "linux"
          ? spawnSync("notify-send", ["--app-name=Oathrion", "Oathrion: test", "An action waiting for your decision will be announced like this."], { timeout: 5_000 })
          : process.platform === "darwin"
            ? spawnSync("osascript", ["-e", 'display notification "An action waiting for your decision will be announced like this." with title "Oathrion: test"'], { timeout: 5_000 })
            : null;
      if (sent && sent.status === 0) out("Desktop: test message sent.");
      else {
        out("Desktop: no notification possible here (no notification tool, or no graphical session).");
        worst = 1;
      }
    }
    if (settings.slackWebhookUrl) {
      try {
        const response = await fetch(settings.slackWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Oathrion: test message. An action waiting for your decision will be announced here." }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) out("Slack: test message sent.");
        else {
          out(`Slack: refused (${String(response.status)}). Check the webhook.`);
          worst = 1;
        }
      } catch (error) {
        out(`Slack: unreachable (${error instanceof Error ? error.message : String(error)}).`);
        worst = 1;
      }
    }
    return worst;
  }

  err(`Unknown command: ${command}.${NOTIFICATIONS_USAGE}`);
  return 3;
}
