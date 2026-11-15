/**
 * Le runner : ordonnance les propriétés, applique les préconditions, rend le verdict.
 *
 * Trois règles, toutes issues de SPEC.md, et toutes destinées à empêcher qu'un kit
 * « passe » pour une raison qui n'est pas la bonne :
 *
 *   1. une propriété dont une **précondition** est FAIL devient SKIP, jamais FAIL : une
 *      violation doit rester imputable à une seule propriété (§ 1.5) ;
 *   2. un **SKIP n'est jamais un PASS**, et le verdict INCOMPLET existe précisément pour
 *      qu'on ne puisse pas confondre les deux (§ 5) ;
 *   3. le kit **refuse de démarrer** si le décompte du code et celui de SPEC.md
 *      divergent. La v0.1 de la spécification avait un décompte faux ; une garde coûte
 *      dix lignes et rend l'erreur impossible.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHttpClient } from "./client";
import { SkipSignal } from "./skip";
import { PROPERTIES } from "./properties";
import type { Context, Driver, PropertyResult } from "./types";

export interface RunOutcome {
  readonly verdict: "CONFORME" | "NON CONFORME" | "INCOMPLET" | "INVALIDE";
  readonly results: readonly PropertyResult[];
  readonly driver: string;
  readonly baseUrl: string;
  readonly startedAt: string;
}

/** Le décompte déclaré par SPEC.md, § 6. Lu, jamais supposé. */
export function declaredCounts(specPath: string): { core: number; extended: number } {
  const text = readFileSync(specPath, "utf8");
  const row = /\|\s*\*\*Spécifiées\*\*\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/.exec(text);
  if (!row) throw new Error(`SPEC.md ne déclare pas de décompte lisible (§ 6) : ${specPath}`);
  return { core: Number(row[1]), extended: Number(row[2]) };
}

function assertCountsAgree(specPath: string): void {
  const declared = declaredCounts(specPath);
  const actual = {
    core: PROPERTIES.filter((p) => p.level === "core").length,
    extended: PROPERTIES.filter((p) => p.level === "extended").length,
  };
  if (declared.core !== actual.core || declared.extended !== actual.extended) {
    throw new Error(
      `Le décompte de SPEC.md (${declared.core} core, ${declared.extended} extended) ne ` +
        `correspond pas au code (${actual.core} core, ${actual.extended} extended). ` +
        `Corrigez le § 6 de SPEC.md, ou la liste PROPERTIES.`,
    );
  }
}

export async function run(driver: Driver, specPath = join(import.meta.dirname, "..", "SPEC.md")): Promise<RunOutcome> {
  assertCountsAgree(specPath);

  const http = createHttpClient(driver.baseUrl);
  const ctx: Context = {
    driver,
    state: driver.state,
    http,
    nonce: () => Math.random().toString(36).slice(2, 10),
  };

  const results: PropertyResult[] = [];
  const failed = new Set<string>();

  for (const property of PROPERTIES) {
    const blocking = (property.needs ?? []).filter((id) => failed.has(id));
    if (blocking.length > 0) {
      results.push({
        id: property.id,
        level: property.level,
        title: property.title,
        status: "SKIP",
        detail: "",
        reason: `précondition ${blocking.join(", ")} en échec`,
      });
      continue;
    }

    try {
      const detail = await property.run(ctx);
      results.push({ id: property.id, level: property.level, title: property.title, status: "PASS", detail });
    } catch (error) {
      if (error instanceof SkipSignal) {
        /*
         * La propriété elle-même déclare qu'elle n'est pas vérifiable sur ce profil.
         * Ce n'est ni un PASS ni un FAIL : une core en SKIP donne INCOMPLET, et
         * INCOMPLET n'est pas une conformité (§ 5).
         */
        results.push({
          id: property.id,
          level: property.level,
          title: property.title,
          status: "SKIP",
          detail: "",
          reason: error.message,
        });
        continue;
      }
      failed.add(property.id);
      results.push({
        id: property.id,
        level: property.level,
        title: property.title,
        status: "FAIL",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const core = results.filter((r) => r.level === "core");
  const verdict = core.some((r) => r.status === "FAIL")
    ? "NON CONFORME"
    : core.some((r) => r.status === "SKIP" || r.status === "NOT_IMPLEMENTED")
      ? "INCOMPLET"
      : "CONFORME";

  return { verdict, results, driver: driver.name, baseUrl: driver.baseUrl, startedAt: new Date().toISOString() };
}

const MARK: Record<PropertyResult["status"], string> = {
  PASS: "✓",
  FAIL: "✗",
  SKIP: "–",
  NOT_IMPLEMENTED: "·",
};

export function render(outcome: RunOutcome): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Kit de conformité — autorisation d'agent`);
  lines.push(`driver ${outcome.driver} · ${outcome.baseUrl} · ${outcome.startedAt}`);
  lines.push("─".repeat(78));

  for (const level of ["core", "extended"] as const) {
    const group = outcome.results.filter((r) => r.level === level);
    if (group.length === 0) continue;
    lines.push(`\n${level.toUpperCase()}`);
    for (const r of group) {
      const tail = r.status === "SKIP" ? r.reason ?? "" : r.detail;
      lines.push(`  ${MARK[r.status]} ${r.id.padEnd(4)} ${r.title}`);
      if (tail) lines.push(`        ${tail}`);
    }
  }

  const count = (status: PropertyResult["status"], level?: "core" | "extended") =>
    outcome.results.filter((r) => r.status === status && (!level || r.level === level)).length;

  lines.push("");
  lines.push("─".repeat(78));
  lines.push(
    `core      ${count("PASS", "core")} PASS · ${count("FAIL", "core")} FAIL · ${count("SKIP", "core")} SKIP`,
  );
  lines.push(
    `extended  ${count("PASS", "extended")} PASS · ${count("FAIL", "extended")} FAIL · ${count("SKIP", "extended")} SKIP`,
  );
  lines.push(`VERDICT   ${outcome.verdict}`);
  lines.push("");
  return lines.join("\n");
}
