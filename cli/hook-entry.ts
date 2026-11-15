#!/usr/bin/env node
/**
 * Le hook Claude Code seul, compilé à part (`dist/oathrion-hook.mjs`).
 *
 * Claude Code l'appelle deux fois par outil (avant, après). Par la commande complète, chaque
 * appel coûtait 0,2 à 0,3 s de chargement (mesuré le 5 novembre) : une session de cinquante
 * outils aurait attendu une demi-minute. Ce fichier ne contient que les règles, le journal et la
 * commande. `oathrion` le choisit quand il est à côté de la commande installée.
 */
import { runClaudeHook } from "./wrap/claude-hook";

const chunks: Buffer[] = [];
const finish = (stdin: string) => void runClaudeHook(process.argv.slice(2), process.env, stdin, (line) => process.stdout.write(`${line}\n`)).then((code) => process.exit(code));
if (process.stdin.isTTY) finish("");
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
