/**
 * LES JETONS QUITTENT LES CONFIGURATIONS DES CLIENTS (pièce J1 de `notes/CONCEPTION-JAIL.md`).
 *
 * `~/.cursor/mcp.json` et `~/.claude.json` portaient en clair les jetons des serveurs (`env`, en-
 * têtes d'un serveur distant) : un agent qui lisait la configuration de son client y trouvait de
 * quoi appeler le service sans Oathrion (essai réel du 10 novembre, `cursor-agent`). À
 * l'installation, ces jetons sont DÉPLACÉS dans le coffre local d'Oathrion
 * (`~/.oathrion/_local/server-secrets/<serveur>.json`, 0600) ; la configuration ne garde que la
 * commande `oathrion wrap`, qui les rend au serveur à son lancement. `--undo` les remet à leur
 * place, exactement.
 *
 * Claude Code ne peut pas lire ce coffre (hook et `permissions.deny`) ; un agent enfermé
 * (`oathrion jail`) ne le voit pas du tout.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SECRET_ENV_NAME } from "./guarded-tokens";

interface ServerConfig {
  env?: unknown;
  [key: string]: unknown;
}

export const SECRETS_DIRNAME = "server-secrets";

const fileFor = (dir: string, server: string) => join(dir, SECRETS_DIRNAME, `${server.replace(/[^a-z0-9_-]/gi, "_")}.json`);

/** Les variables d'un serveur qui portent un secret (un jeton, une clé, des en-têtes). */
export function secretEntries(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && SECRET_ENV_NAME.test(entry[0])));
}

/** Les secrets gardés pour ce serveur, à rendre à son lancement. */
export function loadSealedEnv(dir: string, server: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(dir, server), "utf8")) as { env?: Record<string, string> };
    return parsed.env && typeof parsed.env === "object" ? parsed.env : {};
  } catch {
    return {};
  }
}

/**
 * La configuration sans ses secrets, et les secrets gardés dans le coffre (fusionnés avec ceux
 * déjà gardés). Un serveur sans secret est rendu tel quel.
 */
export function sealConfig<T extends ServerConfig>(dir: string, server: string, config: T): T {
  const env = config.env !== null && typeof config.env === "object" ? (config.env as Record<string, unknown>) : {};
  const secrets = secretEntries(env);
  if (Object.keys(secrets).length === 0) return config;
  mkdirSync(join(dir, SECRETS_DIRNAME), { recursive: true, mode: 0o700 });
  const file = fileFor(dir, server);
  writeFileSync(file, `${JSON.stringify({ env: { ...loadSealedEnv(dir, server), ...secrets } }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !(key in secrets)));
  const { env: _env, ...rest } = config;
  return (Object.keys(kept).length > 0 ? { ...rest, env: kept } : rest) as T;
}

/** L'inverse, pour `--undo` : les secrets gardés reviennent dans la configuration. */
export function unsealConfig<T extends ServerConfig>(dir: string, server: string, config: T): T {
  const sealed = loadSealedEnv(dir, server);
  if (Object.keys(sealed).length === 0) return config;
  const env = config.env !== null && typeof config.env === "object" ? (config.env as Record<string, unknown>) : {};
  return { ...config, env: { ...env, ...sealed } };
}

/** Le coffre d'un serveur rendu à sa configuration d'origine : il n'a plus de raison d'être. */
export function forgetSealed(dir: string, server: string): void {
  const file = fileFor(dir, server);
  if (existsSync(file)) rmSync(file);
}
