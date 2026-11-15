/**
 * LA MASCOTTE ET LE NOM DONNÉS À UN AGENT (`server/local-mascot-choices.ts`) : par famille
 * (« Claude Code » et « claude » sont le même agent), gardés sur la machine, relus quand ils
 * changent ; un nom propre et court ; le fil les montre.
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { agentFamily, cleanAgentNickname } from "@shared/mascots";

import { buildFeed } from "../local-feed";
import { MASCOT_CHOICES_FILE, MascotChoices } from "../local-mascot-choices";

describe("la famille d'un agent", () => {
  it("le client MCP et le processus sont le même agent", () => {
    expect(agentFamily("Claude Code")).toBe(agentFamily("claude"));
    expect(agentFamily("cursor-agent")).toBe(agentFamily("Cursor"));
    expect(agentFamily("agy")).toBe(agentFamily("Antigravity (app)"));
    expect(agentFamily("My  Bot")).toBe("my bot");
  });

  it("un nom : court, sans ce qui casserait un affichage", () => {
    expect(cleanAgentNickname("  Kiki  ")).toBe("Kiki");
    expect(cleanAgentNickname("<b>Kiki</b>")).toBe("bKiki/b");
    expect(cleanAgentNickname("x".repeat(25))).toBeNull();
    expect(cleanAgentNickname("   ")).toBeNull();
    expect(cleanAgentNickname(42)).toBeNull();
  });
});

describe("les choix de la personne", () => {
  it("sans choix, la mascotte d'office ; un choix vaut pour toute la famille, gardé en 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-mascots-"));
    const choices = new MascotChoices(dir, () => new Date("2026-11-11T12:00:00Z"));
    expect(choices.of("agy")).toEqual({ id: "nova", name: "Nova" });
    expect(choices.choose("Claude Code", "pixel", "Kiki")).toMatchObject({ mascot: "pixel", nickname: "Kiki" });
    expect(choices.of("claude")).toEqual({ id: "pixel", name: "Kiki" });
    expect(statSync(join(dir, MASCOT_CHOICES_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, MASCOT_CHOICES_FILE), "utf8"))).toMatchObject({ claude: { mascot: "pixel", nickname: "Kiki" } });
    /* Sans nom : celui de la mascotte. */
    choices.choose("agy", "bolt", "");
    expect(choices.of("agy")).toEqual({ id: "bolt", name: "Bolt" });
    /* Relu par une autre instance (le pivot et la console partagent le fichier). */
    expect(new MascotChoices(dir).of("Claude Code")).toEqual({ id: "pixel", name: "Kiki" });
  });

  it("refuse Warden (celle d'Oathrion), une mascotte inconnue, un nom trop long", () => {
    const choices = new MascotChoices(mkdtempSync(join(tmpdir(), "oathrion-mascots-")));
    expect(choices.choose("agy", "warden", "")).toContain("The mascot is one of");
    expect(choices.choose("agy", "dragon", "")).toContain("The mascot is one of");
    expect(choices.choose("agy", "nova", "x".repeat(30))).toContain("1 to 24 characters");
    expect(choices.list()).toEqual({});
  });

  it("le fil montre le nom choisi", () => {
    const choices = new MascotChoices(mkdtempSync(join(tmpdir(), "oathrion-mascots-")));
    choices.choose("agy", "ember", "Kiki");
    const feed = buildFeed({ events: [{ id: "evt_1", at: "2026-11-11T10:00:00Z", kind: "stopped", agent: "agy" }], approvals: [], executions: [], face: (agent) => choices.of(agent) });
    expect(feed[0]).toMatchObject({ title: "You stopped Kiki (agy).", mascot: { id: "ember", name: "Kiki" } });
  });
});

describe("les cartes à partager depuis la notification", () => {
  it("un jeton par carte, relue par la console ; les 50 dernières seulement", async () => {
    const { LocalHub } = await import("../local-hub");
    const hub = new LocalHub(mkdtempSync(join(tmpdir(), "oathrion-share-")), { holderTimeoutMs: 30_000, idleMs: 30_000, childTimeoutMs: 5_000 });
    const card = { sentence: "I tried Oathrion.", mascot: { id: "nova", name: "Kiki" }, at: "2026-11-11T06:30:00Z", tone: "good" as const };
    const first = hub.keepShareCard(card);
    expect(first).toMatch(/^[0-9a-f]{24}$/);
    expect(hub.shareCard(first)).toEqual(card);
    expect(hub.shareCard("unknown")).toBeNull();
    for (let i = 0; i < 50; i += 1) hub.keepShareCard({ ...card, sentence: `card ${String(i)}` });
    expect(hub.shareCard(first)).toBeNull();
  });
});
