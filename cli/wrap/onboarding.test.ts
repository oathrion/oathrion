/**
 * LE PARCOURS GUIDÉ (`onboarding.ts`) : après `npx oathrion`, la démo puis le téléphone, d'une
 * touche chacun ; « n » remet à plus tard ; sans terminal, rien n'est demandé.
 */
import { describe, expect, it } from "vitest";

import { runOnboarding, type OnboardingIo } from "./onboarding";

function io(answers: (string | null)[], paired = false, restart: string[] = [], agent: "seen" | "skip" | "timeout" = "skip") {
  const out: string[] = [];
  const did: string[] = [];
  const asked: string[] = [];
  const stub: OnboardingIo = {
    restart,
    waitForAgent: async (q) => {
      asked.push(q);
      return agent;
    },
    open: (url) => did.push(`open ${url}`),
    out: (l) => out.push(l),
    ask: async (q) => {
      asked.push(q);
      return answers.length > 0 ? answers.shift()! : "";
    },
    askSecret: async (q) => {
      asked.push(q);
      return answers.length > 0 ? answers.shift()! : "";
    },
    demo: async (quiet) => {
      did.push(quiet ? "demo (quiet)" : "demo");
      return 0;
    },
    pairPhone: async (token) => {
      did.push(`pair ${token}`);
      return 0;
    },
    phonePaired: () => paired,
  };
  return { out, did, asked, stub };
}

describe("le parcours guidé", () => {
  it("Entrée, Entrée, le jeton : la démo, l'appairage, puis la démo sur le téléphone", async () => {
    const run = io(["", "", "", "123:abc"]);
    expect(await runOnboarding(run.stub)).toBe(0);
    expect(run.did).toEqual(["demo", "open https://t.me/BotFather", "pair 123:abc", "demo (quiet)"]);
    expect(run.out.join("\n")).toContain("Look at your phone: Nova is paused there too");
    expect(run.out.join("\n")).toContain("✓ Oathrion is set up");
  });

  it("« n » à chaque étape : rien n'est fait, la commande pour plus tard est dite", async () => {
    const run = io(["n", "non"]);
    expect(await runOnboarding(run.stub)).toBe(0);
    expect(run.did).toEqual([]);
    expect(run.out.join("\n")).toContain("Later: oathrion phone telegram");
  });

  it("un téléphone déjà appairé : on ne redemande pas", async () => {
    const run = io(["", ""], true);
    await runOnboarding(run.stub);
    expect(run.did).toEqual(["demo"]);
    expect(run.asked.some((q) => q.includes("2/2"))).toBe(false);
    expect(run.out.join("\n")).toContain("Your phone is already paired");
  });

  it("un client à relancer : on attend qu'il revienne, et on le dit ; puis la démo, le téléphone (1/3, 2/3, 3/3)", async () => {
    const run = io(["", "", "n"], false, ["Cursor", "Claude Code"], "seen");
    await runOnboarding(run.stub);
    expect(run.asked[0]).toContain("1/3 · Restart Cursor, or start a new Claude Code session: I will tell you when it is protected");
    expect(run.out.join("\n")).toContain("✓ Protected: your agent's calls now go through Oathrion.");
    expect(run.asked.some((q) => q.startsWith("2/3 · See Oathrion"))).toBe(true);
  });

  it("Claude Code seul : une nouvelle session ; pas revenu à temps, on dit que ce sera fait à la relance", async () => {
    const run = io(["n", "n"], false, ["Claude Code"], "timeout");
    await runOnboarding(run.stub);
    expect(run.asked[0]).toContain("1/3 · Start a new Claude Code session");
    expect(run.out.join("\n")).toContain("protected as soon as you restart it");
  });

  it("sans terminal : rien n'est fait, rien n'attend", async () => {
    const run = io([null]);
    expect(await runOnboarding(run.stub)).toBe(0);
    expect(run.did).toEqual([]);
  });
});
