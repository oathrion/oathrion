import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { maskWebhook, runNotifications, webhookProblem } from "./notifications";

describe("oathrion notifications", () => {
  it("l'adresse d'un webhook n'est jamais affichée en entier", () => {
    expect(maskWebhook("https://hooks.slack.com/services/T000/B000/abcdefSECRET")).toBe("https://hooks.slack.com/…••••");
    expect(maskWebhook("https://hooks.slack.com/services/T000/B000/abcdefSECRET")).not.toContain("SECRET");
  });

  it("refuse une adresse qui n'est pas https, ou qui porte des identifiants", () => {
    expect(webhookProblem("http://hooks.slack.com/x")).toMatch(/https/);
    expect(webhookProblem("https://moi:motdepasse@hooks.slack.com/x")).toMatch(/credentials/);
    expect(webhookProblem("pas une adresse")).toMatch(/not an address/);
    expect(webhookProblem("https://hooks.slack.com/services/T/B/x")).toBeNull();
  });

  it("branche Slack (fichier en 0600), coupe le bureau, retire Slack ; l'état le dit sans l'adresse", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-notif-cli-"));
    const env = { OATHRION_WRAP_HOME: home };
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await runNotifications(["slack", "https://hooks.slack.com/services/T/B/CLE-SECRETE"], env, out, out)).toBe(0);
    const file = join(home, "_local", "notifications.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await runNotifications(["bureau", "non"], env, out, out)).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/CLE-SECRETE", desktop: false });

    lines.length = 0;
    await runNotifications([], env, out, out);
    expect(lines.join("\n")).toMatch(/Desktop: off[\s\S]*Slack: on/);
    expect(lines.join("\n")).not.toContain("CLE-SECRETE");

    expect(await runNotifications(["slack", "--retirer"], env, out, out)).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ desktop: false });
    expect(await runNotifications(["slack", "http://x"], env, out, out)).toBe(3);
    expect(await runNotifications(["bureau", "peut-être"], env, out, out)).toBe(3);
  });
});
