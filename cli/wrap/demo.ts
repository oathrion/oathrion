/**
 * `oathrion demo` (11 novembre : « booster l'adoption dès la publication »). Le moment « waouh »
 * en dix secondes : la notification d'Oathrion, telle qu'elle arrive quand un agent agit sans
 * autorisation, mais sur un agent pour de faux (Nova). Rien de réel n'est mis en pause. La
 * personne clique « Stop », puis « Share it ».
 *
 *   oathrion demo           un agent mis en pause
 *   oathrion demo --decoy   un leurre lu (la notification rouge)
 *
 * Le pivot local est lancé s'il ne tourne pas ; un pivot plus ancien que le paquet installé
 * (sans la démo) laisse d'abord la place, comme pour `oathrion watch`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureHub, hubDir, hubIsStale, type HubConnection } from "./hub";

export const DEMO_USAGE = `
oathrion demo            Show Oathrion's notification on a pretend agent (nothing real is paused)
oathrion demo --decoy    The same, for a decoy read (the red one)`;

interface DemoIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Pour les essais : le pivot. */
  connect?: () => Promise<HubConnection>;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function freshHub(env: NodeJS.ProcessEnv): Promise<HubConnection> {
  const dir = hubDir(env);
  if (existsSync(join(dir, "port")) && hubIsStale(env, dir)) {
    const old = await ensureHub(env, { log: () => undefined }).catch(() => null);
    if (old?.wasRunning && (await old.op({ op: "retire" }).catch(() => null))?.status === 202) {
      for (let i = 0; i < 40 && (await old.op({ op: "status" }).catch(() => null)) !== null; i += 1) await wait(250);
    }
  }
  return ensureHub(env, { log: () => undefined });
}

export async function runDemo(argv: string[], io: DemoIo): Promise<number> {
  const unknown = argv.find((a) => a !== "--decoy");
  if (unknown) {
    io.err(`Unknown option: ${unknown}.${DEMO_USAGE}`);
    return 2;
  }
  const kind = argv.includes("--decoy") ? "decoy" : "pause";
  let conn: HubConnection;
  try {
    conn = await (io.connect ?? (() => freshHub(io.env)))();
  } catch (error) {
    io.err(`Oathrion could not start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const answer = await conn.op<{ shown?: boolean; detail?: string; error?: string }>({ op: "demo", kind }).catch(() => null);
  if (answer?.status === 200 && answer.body?.shown) {
    const ourWindow = (io.platform ?? process.platform) === "linux";
    const what = kind === "decoy" ? "Oathrion warns you that a decoy was read." : "Oathrion paused Nova, a pretend AI agent.";
    io.out(ourWindow ? `Look at the top right of your screen: ${what}` : `Look at the notification from Oathrion: ${what}`);
    io.out("It is a demo: nothing real was paused or read.");
    /* Hors de Linux, la notification du système n'a que « Decide » : il ouvre la décision dans la console (`/decide`). */
    if (ourWindow) io.out(kind === "decoy" ? "Click « Share it » to see the card you can post." : "Click « Stop », then « Share it »: your card opens, ready to post.");
    else io.out(kind === "decoy" ? "Click « Decide »: your console opens on it, with the card you can post." : "Click « Decide »: your console opens on Nova. Click « Stop », then share your card.");
    io.out(kind === "decoy" ? "For real: oathrion decoys plant" : "For real: npx oathrion, then oathrion watch --always (Linux)");
    return 0;
  }
  if (answer?.status === 400) {
    io.err("The Oathrion running is older than this one and has no demo. Close the console and your agents, then try again.");
    return 1;
  }
  io.err(answer?.body?.detail ?? answer?.body?.error ?? "Oathrion did not answer.");
  return 1;
}
