/**
 * Le renommage n'a pas le droit de toucher ce qui ne nous appartient pas.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le renommage ARIA → Placet a été fait par une passe mécanique sur ~3 800 occurrences,
 * et elle a cassé deux choses qu'aucun garde existant ne voyait :
 *
 * 1. **Les attributs d'accessibilité du W3C.** `aria-label`, `aria-hidden`,
 *    `aria-selected` et une cinquantaine d'autres sont des attributs HTML définis par
 *    **WAI-ARIA**, sans aucun rapport avec le nom du produit — c'est précisément la
 *    collision qui a motivé le renommage. La passe les a transformés en
 *    `placet-label`, `placet-hidden`… soit **84 attributs** devenus inopérants dans la
 *    console. Le typecheck a passé (JSX accepte un attribut à tiret inconnu), le lint a
 *    passé, le build a passé. Rien, dans tout le dépôt, ne pouvait le voir.
 *
 * 2. **Le nom d'un paquet npm tiers.** `aria-hidden@1.2.6` est une vraie dépendance
 *    (Radix UI). Renommée en `placet-hidden` dans `package-lock.json`, elle a fait
 *    échouer `npm ci` DANS LE CONTENEUR avec un 404 de registre — mais pas sur l'hôte,
 *    où le cache `node_modules` masquait le problème. Trouvé par `verify:compose`, et
 *    seulement par lui.
 *
 * Les deux fautes ont la même forme : **le mot « aria » appartient aussi à des tiers.**
 * Ce test est le garde qui manquait, et il s'exécute en millisecondes à chaque suite.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Les attributs WAI-ARIA 1.2.
 *
 * Écrits en entier plutôt que détectés par motif : un motif du genre
 * `placet-[a-z]+` attraperait aussi `placet-demo`, `placet-postgres` et les noms de
 * conteneurs, qui sont légitimes. La liste est la seule façon d'être précis.
 */
const WAI_ARIA_ATTRIBUTES = [
  "activedescendant", "atomic", "autocomplete", "braillelabel", "brailleroledescription",
  "busy", "checked", "colcount", "colindex", "colindextext", "colspan", "controls",
  "current", "describedby", "description", "details", "disabled", "dropeffect",
  "errormessage", "expanded", "flowto", "grabbed", "haspopup", "hidden", "invalid",
  "keyshortcuts", "label", "labelledby", "level", "live", "modal", "multiline",
  "multiselectable", "orientation", "owns", "placeholder", "posinset", "pressed",
  "readonly", "relevant", "required", "roledescription", "rowcount", "rowindex",
  "rowindextext", "rowspan", "selected", "setsize", "sort", "valuemax", "valuemin",
  "valuenow", "valuetext",
] as const;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const relative = path.join(dir, entry);
    if (statSync(path.join(ROOT, relative)).isDirectory()) sources(relative, out);
    else if (/\.(tsx?|jsx?|html|md)$/.test(entry)) out.push(relative);
  }
  return out;
}

/**
 * Ce fichier s'exclut lui-même, et ce n'est pas une échappatoire.
 *
 * Son en-tête CITE les attributs cassés (`placet-label`, `placet-hidden`) pour
 * expliquer la faute, donc il se signalait comme coupable au premier passage. Même
 * situation que `claims-honesty.test.ts`, qui avait rejeté la spécification du kit de
 * conformité pour avoir employé le mot interdit en décrivant la règle.
 *
 * L'exclusion porte sur UN chemin exact, nommé ici, et non sur un motif : un
 * `*.test.ts` exempté aurait laissé passer un attribut réellement cassé dans n'importe
 * quel test de la console.
 */
const SELF = path.join("server", "test", "rename-collisions.test.ts");

const FILES = ["client", "server", "shared", "script", "cli", "sdk", "examples", "conformance", "docs"]
  .flatMap((dir) => sources(dir))
  .filter((f) => f !== SELF);

describe("les attributs d'accessibilité du W3C", () => {
  it("ne portent jamais le nom du produit", () => {
    /* Les deux générations du nom : `placet-label` (renommage précédent) et `oathrion-label` (celui-ci). */
    const pattern = new RegExp(`\\b(?:placet|oathrion)-(${WAI_ARIA_ATTRIBUTES.join("|")})\\b`, "g");
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of readFileSync(path.join(ROOT, file), "utf8").matchAll(pattern)) {
        offenders.push(`${file} : ${match[0]} (le W3C l'écrit aria-${match[1]})`);
      }
    }
    expect(
      offenders,
      "Un attribut WAI-ARIA a été renommé avec le produit. Ce sont des attributs HTML " +
        "définis par le W3C, sans rapport avec notre nom — et c'est exactement la " +
        "collision qui a motivé le renommage :\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("sont toujours présents dans la console — le garde n'est pas vide", () => {
    /*
     * Contrôle POSITIF. Sans lui, supprimer tous les attributs d'accessibilité de la
     * console ferait passer le test ci-dessus avec zéro infraction, et le garde
     * deviendrait une formalité qui ne mesure plus rien.
     */
    const used = FILES.filter((f) => f.startsWith("client/"))
      .filter((f) => /\baria-(label|hidden|selected|current|describedby)\b/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(used.length).toBeGreaterThan(10);
  });
});

describe("la grammaire française, que le renommage a cassée", () => {
  /*
   * « ARIA » commence par une voyelle, « Placet » par une consonne : l'élision tombe.
   *
   * La passe mécanique a transformé « rien d'ARIA » en « rien d'Placet » — 22 fois, dans
   * la documentation d'installation, la page d'astreinte, l'exemple de serveur MCP et
   * jusque dans `.env.example`. Typecheck, lint, build et la suite entière étaient verts :
   * aucune porte ne lit le français.
   *
   * Ce garde le lit. Il est bon marché, et il couvre une faute qu'un lecteur francophone
   * remarque à la première ligne — c'est-à-dire exactement celle qui coûte le plus en
   * crédibilité pour ce qu'elle coûte à réparer.
   */
  it("n'élide pas devant une consonne", () => {
    const pattern = /\b[dlsnmtjcDLSNMTJC]'Placet\b/g;
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of readFileSync(path.join(ROOT, file), "utf8").matchAll(pattern)) {
        offenders.push(`${file} : « ${match[0]} » — « Placet » commence par une consonne`);
      }
    }
    expect(
      offenders,
      "L'élision française ne s'emploie que devant une voyelle. « d'ARIA » était correct ; " +
        "« d'Placet » ne l'est pas — écrivez « de Placet » :\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  /*
   * ET L'INVERSE, au renommage suivant : « Oathrion » commence par une VOYELLE. La passe
   * mécanique a écrit « de Oathrion » 169 fois et « que Oathrion » 103 fois (27 octobre
   * 2026), corrigées en « d'Oathrion » et « qu'Oathrion ».
   */
  it("élide devant Oathrion, qui commence par une voyelle", () => {
    /* `\p{L}` et non `\b` : pour `\b`, « ê » n'est pas une lettre, et « même Oathrion » contiendrait « me Oathrion ». */
    const pattern = /(?<![\p{L}'’])(?:de|De|que|Que|le|Le|ne|se|je|me|te|ce|Ce|jusque|lorsque|puisque) Oathrion\b/gu;
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of readFileSync(path.join(ROOT, file), "utf8").matchAll(pattern)) {
        offenders.push(`${file} : « ${match[0]} »`);
      }
    }
    expect(offenders, "« Oathrion » commence par une voyelle : écrivez « d'Oathrion », « qu'Oathrion » :\n" + offenders.join("\n")).toEqual([]);
  });
});

/*
 * LA CLASSE C : ce que le renommage Placet → Oathrion ne devait PAS toucher.
 *
 * Des valeurs déjà écrites chez les fournisseurs, en base ou dans des messages envoyés,
 * ou partagées entre deux versions qui tournent ensemble pendant une mise à jour. Les
 * renommer casse des installations existantes en silence : la réconciliation ne
 * reconnaîtrait plus les actions déjà faites, Stripe rembourserait deux fois un réessai,
 * deux versions ne s'excluraient plus sur le même verrou. Voir
 * `notes/RENOMMAGE-OATHRION.md`. Chaque ligne nomme un fichier et la valeur qui doit y
 * rester ; une passe mécanique future qui la remplace fait échouer ce test.
 */
describe("les valeurs déjà écrites ou partagées gardent l'ancien nom", () => {
  const KEPT: [file: string, value: string, why: string][] = [
    ["server/action/canonical.ts", "placet.action.v1", "entre dans l'empreinte de chaque action"],
    ["server/connectors/github.ts", "<!-- placet-execution:", "marque déjà posée sur les issues"],
    ["server/connectors/stripe.ts", "metadata[placet_execution]", "marque déjà posée sur les remboursements"],
    ["server/connectors/stripe.ts", "`placet-${executionId}`", "clé d'idempotence : un réessai doit présenter la même"],
    ["server/connectors/slack.ts", "placet_execution", "marque déjà posée dans les messages"],
    ["server/connectors/linear.ts", "`placet:${executionId}`", "déduplication chez Linear"],
    ["server/gateway/tools/mcp-client.ts", "`placet-${call.executionId}`", "identifiant JSON-RPC, clé d'idempotence de repli"],
    ["server/authority/store.ts", "placet:receipts:", "verrou partagé avec une version précédente pendant une mise à jour"],
    ["server/sql/execution-quota.ts", "placet:quota:executions:", "verrou partagé avec une version précédente"],
    ["server/repositories/postgres.ts", "placet:spend:", "verrou partagé avec une version précédente"],
    ["server/connectors/oauth-install.ts", "placetOAuth", "format des secrets OAuth déjà scellés dans le coffre"],
    ["server/notifications/slack.ts", "placet_approve", "boutons des messages Slack déjà envoyés"],
    ["server/connectors/guardrails.ts", "pol_placet_", "identifiants des politiques déjà créées"],
    ["deploy/docker-compose.local.yml", "name: placet-local", "projet Compose, donc volumes de l'installation existante"],
  ];
  for (const [file, value, why] of KEPT) {
    it(`${file} garde « ${value} » — ${why}`, () => {
      expect(readFileSync(path.join(ROOT, file), "utf8")).toContain(value);
    });
  }

  it("la marque lisible de Linear est reconnue sous les deux noms", () => {
    const linear = readFileSync(path.join(ROOT, "server/connectors/linear.ts"), "utf8");
    /* La lecture ne dépend pas du nom du produit : « … exécution exe_… ». */
    expect(linear).toContain("/(?:exécution|execution) (exe_[A-Za-z0-9]+)/");
  });
});

describe("les noms de paquets tiers", () => {
  it("ne sont pas renommés dans package-lock.json", () => {
    /*
     * `aria-hidden` est une dépendance réelle de Radix UI. Renommée, `npm ci` échoue
     * avec un 404 de registre — mais seulement là où aucun cache ne la masque, c'est-à-
     * dire dans le conteneur de build et pas sur la machine de celui qui a fait le
     * renommage.
     */
    const lock = readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
    expect(lock).toContain("aria-hidden");
    expect(lock).not.toContain("placet-hidden");
  });

  it("ne sont pas renommés dans package.json", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Le nom du PROJET suit le produit ; les noms de ses dépendances, jamais.
    expect(manifest.name).toBe("oathrion");
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(deps.filter((d) => d.startsWith("placet-"))).toEqual([]);
  });
});
