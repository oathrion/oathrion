#!/usr/bin/env node
/**
 * Oathrion's hook launcher, for the Claude Code plugin.
 *
 * Claude Code runs this file before and after each governed tool call (see hooks/hooks.json).
 * It finds Oathrion's hook program and hands it the call, unchanged:
 *
 *   1. next to the plugin, when the plugin was installed from the npm package `oathrion`;
 *   2. otherwise in the plugin's data folder (${CLAUDE_PLUGIN_DATA}), where it fetches, ONCE,
 *      the archive of the exact version below from the npm registry (`npm pack oathrion@<version>`)
 *      and unpacks it (`tar`). The hook program uses only Node's own modules: no dependency is
 *      installed and no install script runs.
 *
 * Nothing else is downloaded, and nothing is sent anywhere: the hook judges the call on this
 * machine and writes its journal under ~/.oathrion. If Oathrion cannot be installed, each
 * governed action asks you in Claude Code instead, saying why.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/* The Oathrion version this plugin runs. It moves with each release (version-coherence test). */
export const OATHRION_VERSION = "0.1.0-preview.7";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PLUGIN_ROOT?.trim() || join(HERE, "..");
const args = process.argv.slice(2);
const phase = args[1];

function readStdin() {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Where the installed copy lives in the plugin's data folder; null without a data folder. */
function installDir() {
  const data = process.env.CLAUDE_PLUGIN_DATA?.trim();
  return data ? join(data, "oathrion", OATHRION_VERSION) : null;
}

function installedHook(dir) {
  const hook = join(dir, "package", "oathrion-hook.mjs");
  return existsSync(hook) ? hook : null;
}

/** Install the pinned version once. Two hooks starting together: the second waits for the first. */
function install(dir) {
  const lock = `${dir}.lock`;
  mkdirSync(dirname(dir), { recursive: true });
  const deadline = Date.now() + 110_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      /* Another hook is installing; a lock older than two minutes is left over from a crash. */
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      if (installedHook(dir)) return { ok: true };
      if (Date.now() > deadline) return { ok: false, why: "another installation did not finish in time" };
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
    }
  }
  try {
    if (installedHook(dir)) return { ok: true };
    mkdirSync(dir, { recursive: true });
    /* Only the package's own archive (about 2.5 MB): a few seconds, where a full install took minutes. */
    const npm = process.env.OATHRION_PLUGIN_NPM?.trim() || (process.platform === "win32" ? "npm.cmd" : "npm");
    const fail = (step, run) => {
      const detail = (run.error?.message || run.stderr || "").trim().split("\n").filter(Boolean).slice(-1)[0] || `exit ${String(run.status)}`;
      return { ok: false, why: `${step} failed: ${detail}` };
    };
    const pack = spawnSync(npm, ["pack", `oathrion@${OATHRION_VERSION}`, "--pack-destination", dir, "--silent"], { encoding: "utf8", timeout: 90_000, shell: process.platform === "win32" });
    const archive = pack.status === 0 ? (pack.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0] : undefined;
    if (!archive) return fail(`npm pack oathrion@${OATHRION_VERSION}`, pack);
    const unpack = spawnSync("tar", ["-xzf", join(dir, archive), "-C", dir], { encoding: "utf8", timeout: 30_000 });
    rmSync(join(dir, archive), { force: true });
    if (unpack.status !== 0) return fail("unpacking the archive", unpack);
    return installedHook(dir) ? { ok: true } : { ok: false, why: "the archive has no hook program" };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function findHook() {
  const beside = join(ROOT, "oathrion-hook.mjs");
  if (existsSync(beside)) return { hook: beside };
  const dir = installDir();
  if (!dir) return { why: "Claude Code gave no plugin data folder to install Oathrion into" };
  const ready = installedHook(dir);
  if (ready) return { hook: ready };
  const done = install(dir);
  return done.ok ? { hook: installedHook(dir) } : { why: done.why };
}

const stdin = readStdin();
const found = findHook();
if (!found.hook) {
  /* Before an action: ask the person rather than let it through unchecked. After: nothing to say. */
  if (phase === "pre") {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Oathrion could not check this action (${found.why}), so it asks you instead. Run "npx oathrion" to install it.`,
        },
      })}\n`,
    );
  }
  process.exit(0);
}
const child = spawnSync(process.execPath, [found.hook, ...args], { input: stdin, stdio: ["pipe", "inherit", "inherit"] });
process.exit(child.status ?? 1);
