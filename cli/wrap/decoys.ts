/**
 * LES LEURRES — `oathrion decoys plant | list | remove` (décision du 7 novembre : attraper l'agent
 * en train de se faire manipuler, pas seulement limiter les dégâts).
 *
 * Oathrion pose de FAUX secrets, crédibles et uniques : une fausse clé AWS, un faux jeton GitHub,
 * une fausse clé d'API, un faux mot de passe de base de données. Aucune tâche honnête n'a de raison
 * de les envoyer quelque part. Si l'un d'eux apparaît dans une commande, une écriture ou l'appel
 * d'un outil, l'agent a presque certainement été manipulé par quelque chose qu'il a lu : Oathrion
 * refuse, et le dit (`claude-hook-rules.ts`, règle `decoy` ; le relais MCP aussi).
 *
 * JAMAIS SUR TES VRAIS FICHIERS. Les leurres vivent dans des fichiers à eux, aux noms qu'un
 * attaquant chercherait (`~/.aws/credentials.backup`, `~/.env.production.backup`), créés seulement
 * s'ils n'existent pas, après avoir montré la liste. `remove` ne retire que ce qu'Oathrion a posé
 * et qui n'a pas changé. Le registre (`_local/decoys.json`, 0600) garde les valeurs pour les
 * reconnaître : ce sont de faux secrets, ils ne protègent ni n'ouvrent rien.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HUB_DIRNAME } from "./hub";
import { stateRoot } from "./launch";

export interface DecoyRegistry {
  plantedAt: string;
  files: { path: string; sha256: string }[];
  /** Les dossiers qu'Oathrion a créés pour eux (`~/.aws`) : retirés s'ils sont vides. */
  createdDirs?: string[];
  values: { kind: string; value: string }[];
}

/** Ce qu'une règle doit reconnaître : les valeurs, et les noms des fichiers leurres. */
export interface Decoys {
  values: readonly { kind: string; value: string }[];
  names: readonly string[];
}

export const decoyRegistryPath = (env: NodeJS.ProcessEnv) => join(stateRoot(env), HUB_DIRNAME, "decoys.json");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const alnum = (length: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") =>
  [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");

/**
 * Ce texte porte-t-il un leurre ? « a fake AWS access key », « the decoy file credentials.backup »,
 * ou null. Les noms de fichiers seulement si `names` : les lire seul ne nuit à rien.
 */
export function carriesDecoy(text: string, decoys: Decoys | null | undefined, names: boolean): string | null {
  if (!decoys) return null;
  const value = decoys.values.find((v) => text.includes(v.value));
  if (value) return `a fake ${value.kind.replace(/^an? /, "")}`;
  const name = names ? decoys.names.find((n) => text.includes(n)) : undefined;
  return name ? `the decoy file ${name}` : null;
}

/** Les leurres reconnus par les règles, ou null s'il n'y en a pas. Lu à chaque appel : quelques octets. */
export function loadDecoys(env: NodeJS.ProcessEnv): Decoys | null {
  const path = decoyRegistryPath(env);
  if (!existsSync(path)) return null;
  try {
    const registry = JSON.parse(readFileSync(path, "utf8")) as DecoyRegistry;
    return { values: registry.values.filter((v) => v.value.length >= 12), names: registry.files.map((f) => f.path.split(/[\\/]/).pop() ?? "").filter(Boolean) };
  } catch {
    return null;
  }
}

/** Les fichiers leurres à poser, avec des valeurs neuves. */
export function plannedDecoys(home: string): { path: string; content: string; values: DecoyRegistry["values"] }[] {
  const aws = { id: `AKIA${alnum(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`, secret: alnum(40) };
  const github = `ghp_${alnum(36)}`;
  const openai = `sk-proj-${alnum(48)}`;
  const database = alnum(24);
  return [
    {
      path: join(home, ".aws", "credentials.backup"),
      content: `[prod-backup]\naws_access_key_id = ${aws.id}\naws_secret_access_key = ${aws.secret}\nregion = eu-west-3\n`,
      values: [
        { kind: "an AWS access key", value: aws.id },
        { kind: "an AWS secret key", value: aws.secret },
      ],
    },
    {
      path: join(home, ".env.production.backup"),
      content: `# production — backup, do not commit\nGITHUB_TOKEN=${github}\nOPENAI_API_KEY=${openai}\nDATABASE_URL=postgres://admin:${database}@db.internal:5432/production\n`,
      values: [
        { kind: "a GitHub token", value: github },
        { kind: "an AI provider key", value: openai },
        { kind: "a database password", value: database },
      ],
    },
  ];
}

export const DECOYS_USAGE = `
oathrion decoys plant [--yes]    put fake secrets where an attacker would look, never in your real files
oathrion decoys list             what is planted
oathrion decoys remove [--yes]   take them away (only what Oathrion planted and that has not changed)

  No honest task sends them anywhere. If one appears in what your agent runs, writes or sends,
  Oathrion refuses it: your agent was most likely tricked by something it read.
`;

export interface DecoysIo {
  out: (line: string) => void;
  err: (line: string) => void;
  confirm: (question: string, defaultYes: boolean) => Promise<boolean | null>;
  env: NodeJS.ProcessEnv;
  home?: string;
  now?: () => Date;
}

const tilde = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path);

export async function runDecoys(argv: readonly string[], io: DecoysIo): Promise<number> {
  const home = io.home ?? homedir();
  const yes = argv.includes("--yes");
  const registryPath = decoyRegistryPath(io.env);
  const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, "utf8")) as DecoyRegistry) : null;

  if (argv[0] === "list") {
    if (!registry) {
      io.out("No decoy planted. « oathrion decoys plant » puts some.");
      return 0;
    }
    io.out(`Decoys planted on ${registry.plantedAt.slice(0, 10)}:`);
    for (const file of registry.files) io.out(`  ${tilde(file.path, home)}${existsSync(file.path) ? "" : "  (missing)"}`);
    io.out(`  ${String(registry.values.length)} fake secrets: ${[...new Set(registry.values.map((v) => v.kind))].join(", ")}.`);
    return 0;
  }

  if (argv[0] === "plant") {
    if (registry) {
      io.out("Decoys are already planted (« oathrion decoys list »).");
      return 0;
    }
    const plan = plannedDecoys(home).filter((decoy) => !existsSync(decoy.path));
    if (plan.length === 0) {
      io.out("Every decoy file name is already taken by a file of yours: nothing planted, nothing changed.");
      return 0;
    }
    io.out("Oathrion · decoys");
    io.out("");
    io.out("Fake secrets, in files of their own. Your real files are not touched:");
    const width = Math.max(...plan.map((decoy) => tilde(decoy.path, home).length));
    for (const decoy of plan) io.out(`  ${tilde(decoy.path, home).padEnd(width)}   ${decoy.values.map((v) => v.kind).join(", ")}`);
    io.out("");
    io.out("No honest task sends them anywhere. If one appears in what your agent runs, writes or");
    io.out("sends, Oathrion refuses it and tells you: your agent was most likely tricked.");
    io.out("");
    if (!yes) {
      const answer = await io.confirm("Plant them? [Y/n] ", true);
      if (answer === null) {
        io.err("No terminal to ask you: run again with --yes. Nothing was changed.");
        return 1;
      }
      if (!answer) {
        io.out("Nothing was changed.");
        return 1;
      }
    }
    const createdDirs: string[] = [];
    for (const decoy of plan) {
      if (!existsSync(dirname(decoy.path))) createdDirs.push(dirname(decoy.path));
      mkdirSync(dirname(decoy.path), { recursive: true, mode: 0o700 });
      writeFileSync(decoy.path, decoy.content, { mode: 0o600, flag: "wx" });
      chmodSync(decoy.path, 0o600);
    }
    mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    const planted: DecoyRegistry = {
      plantedAt: (io.now?.() ?? new Date()).toISOString(),
      files: plan.map((decoy) => ({ path: decoy.path, sha256: sha256(decoy.content) })),
      createdDirs,
      values: plan.flatMap((decoy) => decoy.values),
    };
    writeFileSync(registryPath, `${JSON.stringify(planted, null, 2)}\n`, { mode: 0o600 });
    io.out(`  ✓ ${String(plan.length)} decoy file(s) planted. « oathrion decoys remove » takes them away.`);
    return 0;
  }

  if (argv[0] === "remove") {
    if (!registry) {
      io.out("No decoy planted: nothing to remove.");
      return 0;
    }
    if (!yes) {
      const answer = await io.confirm(`Remove the ${String(registry.files.length)} decoy file(s)? [Y/n] `, true);
      if (!answer) {
        io.out("Nothing was changed.");
        return 1;
      }
    }
    for (const file of registry.files) {
      if (!existsSync(file.path)) continue;
      if (sha256(readFileSync(file.path, "utf8")) !== file.sha256) {
        io.out(`  ${tilde(file.path, home)} has changed since: left as it is.`);
        continue;
      }
      rmSync(file.path);
      io.out(`  ✓ removed ${tilde(file.path, home)}`);
    }
    for (const dir of registry.createdDirs ?? []) {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    }
    rmSync(registryPath);
    return 0;
  }

  io.err(DECOYS_USAGE);
  return 3;
}
