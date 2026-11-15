/**
 * Balayage anti-secret des fichiers destinés à la livraison.
 *
 * ## CE QUE CE SCRIPT CHERCHE, ET CE QU'IL NE CHERCHE PAS
 *
 * Il ne cherche pas « une chaîne qui ressemble à un secret » — ce critère produit des
 * centaines de faux positifs (hachages de test, empreintes de commit, identifiants
 * générés) et fait donc ignorer la sortie, ce qui est pire que ne rien vérifier.
 *
 * Il cherche deux choses précises :
 *
 *   1. Les valeurs exactes qui ont fuité dans l'archive précédente. Elles sont
 *      connues, donc leur présence est un fait vérifiable et non une heuristique.
 *   2. Les formes qui ne peuvent pas être autre chose qu'un vrai secret : une
 *      affectation d'une variable OATHRION_* sensible à une valeur non vide qui n'est pas
 *      un marqueur, et les en-têtes de clé privée.
 *
 * Les fichiers de test sont inclus dans le balayage. Un mot de passe de test est un
 * mot de passe : s'il ressemble à un identifiant de production, quelqu'un finira par
 * le réutiliser.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releasePathProblem } from "./release-manifest";

/**
 * Empreintes SHA-256 des valeurs ayant fuité dans l'archive précédente.
 *
 * Des empreintes et non les valeurs elles-mêmes : ce fichier est livré, et un
 * balayeur anti-secret qui transporte lui-même une liste de mots de passe en clair
 * est une contradiction — même si ces valeurs sont déjà publiques, elles
 * réapparaîtraient dans chaque archive, chaque recherche plein texte et chaque copie
 * du dépôt. La détection reste exacte parce que la comparaison se fait sur les
 * empreintes des fragments rencontrés, pas sur une recherche de sous-chaîne.
 */
const LEAKED_FINGERPRINTS = new Map<string, string>([
  ["c2860ca8ea1dd62a692e602ad7f0899b6495c20307d1855c9a1c0a10c74ac28a", "mot de passe admin (19 car.)"],
  ["6e2a838372075904da29e50891ab8e16cbcacf87a93e145a2491972ac28e64e5", "mot de passe viewer (20 car.)"],
  ["8ca968fe805fd1f8ed97846713088545139096b0b8b2aa7a14884f29e4644092", "mot de passe approver (22 car.)"],
  ["2b310a944990c632d1c172bf004a6ae26391f14fed5dafe6e1df4b9c46061c0c", "mot de passe operator (22 car.)"],
  ["199793f3223fa44a79d099a6dea57640970faa314af869ac0807f36c93ed8ee5", "mot de passe admin locataire Acme (23 car.)"],
  ["2600713bb15c1f8b08bfcda1c3f69925ba99534ccc99dcff02b5124b0e28056f", "clé d'API Test Runner (23 car.)"],
  ["5d0c3f5e79197d2a1d291c83a1dcfb89ffd1bdf86b0bd133e0dce34b34c21a7a", "clé d'API Acme Bot (23 car.)"],
  ["88fd2536defde52e7eb2d665df03a3a45ed58bb53ec85a16e7185e689f286325", "clé d'API Viewer Bot (25 car.)"],
  ["a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e", "clé de signature de session (64 car.)"],
]);

/**
 * Les fragments d'une ligne susceptibles d'être un secret.
 *
 * Découpé sur les séparateurs que les formats d'Oathrion utilisent — `:` sépare
 * `Nom:rôle:secret`, `,` sépare les entrées, `=` sépare la variable de sa valeur — pour
 * qu'un mot de passe encastré dans une chaîne de configuration soit isolé et donc
 * comparable. Le seuil de 8 caractères écarte les mots courants sans écarter aucune
 * des valeurs recherchées, dont la plus courte fait 19 caractères.
 */
function candidateTokens(line: string): string[] {
  return line
    .split(/[\s:,=;'"`()\[\]{}<>|]+/)
    .filter((token) => token.length >= 8);
}

/**
 * Une valeur qui est explicitement un exemple.
 *
 * Le marqueur est cherché N'IMPORTE OÙ dans la valeur et non sur la valeur entière :
 * la documentation écrit `OATHRION_API_KEYS=Pilot Agent:operator:<la-clé>`, dont seul le
 * troisième champ est un marqueur. Exiger que la valeur entière soit un marqueur
 * signalerait chaque exemple de la documentation, et une sortie pleine de faux
 * positifs est une sortie que personne ne lit.
 */
function isPlaceholder(value: string): boolean {
  if (value === "") return true;
  if (/<[^>]*>/.test(value)) return true;          // <la-clé>, <mot de passe>
  if (value.includes("…") || value.includes("...")) return true;
  if (/\$\{?[A-Z_]+\}?/.test(value)) return true;   // $SECRET, ${SECRET}
  /*
   * Substitution de commande : `$(openssl rand -hex 32)`, `` `openssl ...` ``.
   *
   * Une valeur calculée à l'exécution n'est pas un littéral en dur — c'est même
   * exactement ce que la documentation doit recommander à la place. La signaler
   * apprenait au lecteur à ignorer le scanner, ce qui coûte plus cher que le
   * faux positif lui-même.
   *
   * Le test porte sur `$(` et non sur `$` seul : `$(cat secrets.txt)` reste une
   * commande, alors qu'un `$` isolé au milieu d'une chaîne n'établit rien.
   */
  if (value.includes("$(") || /`[^`]+`/.test(value)) return true;
  if (/^(CHANGE_?ME|REMPLACEZ|xxx+)/i.test(value)) return true;
  return false;
}

/*
 * CE QUI EST SENSIBLE, ET CE QUI NE L'EST PAS.
 *
 * La liste porte les variables dont la VALEUR est un secret. `OATHRION_OAUTH_<DESTINATION>`
 * y est parce qu'elle contient un `clientSecret` ; `OATHRION_SLACK_SIGNING_SECRET` parce que
 * c'est elle qui autorise un clic d'approbation.
 *
 * `OATHRION_SIGV4_<DESTINATION>` n'y est PAS, et l'avoir ajoutée était une erreur : elle ne
 * porte qu'une région et un nom de service — le credential AWS, lui, va dans le coffre.
 * Le scanner signalait donc l'exemple de `docs/firewall.md`, qui ne contient aucun secret.
 *
 * Un faux positif n'est pas gratuit : il apprend au lecteur à passer outre, et un
 * scanner qu'on ignore ne protège plus rien.
 */
const SENSITIVE_ASSIGNMENT =
  /^\s*(OATHRION_SESSION_SECRET|OATHRION_CONSOLE_USERS|OATHRION_API_KEYS|OATHRION_WEBHOOK_SECRET|OATHRION_DATABASE_URL|OATHRION_OAUTH_[A-Z0-9_]+|OATHRION_SLACK_SIGNING_SECRET|OATHRION_SLACK_BOT_TOKEN|OATHRION_OIDC)\s*=\s*(.*)$/;

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

interface Finding {
  file: string;
  line: number;
  reason: string;
}

/**
 * La liste des fichiers à balayer, avec repli hors dépôt git.
 *
 * `package-release` exige un dépôt git et refuse sans lui : sa garantie *est* « ce que
 * git suit », donc s'en passer reviendrait à ne rien garantir. Ici c'est différent — la
 * garantie est « aucun de ces contenus n'est un secret », et elle ne dépend pas de la
 * provenance de la liste. Exiger git ferait échouer cette commande chez le destinataire
 * d'une archive, qui n'a précisément pas de `.git` : c'est le cas où le balayage est le
 * plus utile, puisque c'est là qu'on vérifie ce qu'on a reçu.
 *
 * Le repli parcourt l'arborescence en écartant les répertoires que la liste de refus
 * désigne déjà, ce qui évite d'ouvrir 30 000 fichiers de `node_modules`.
 */
function deliverableFiles(): { files: string[]; source: string } {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((entry) => entry !== "");
    return { files: tracked, source: "git ls-files" };
  } catch {
    const collected: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = join(directory, entry.name).replace(/^\.\//, "");
        if (entry.isDirectory()) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          if (releasePathProblem(`${relative}/`) !== null) continue;
          walk(relative);
        } else if (entry.isFile()) {
          collected.push(relative);
        }
      }
    };
    walk(".");
    return { files: collected, source: "parcours du répertoire (hors dépôt git)" };
  }
}

const { files, source } = deliverableFiles();

const findings: Finding[] = [];
let scanned = 0;

for (const file of files) {
  // Un fichier qui ne devrait pas sortir est un problème de manifeste, pas de
  // contenu : `package-release` le refuse déjà. Ne pas le balayer ici évite de
  // dupliquer ce refus sous une forme moins claire.
  if (releasePathProblem(file) !== null) continue;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binaire ou illisible : rien à y chercher en texte
  }
  if (text.includes("\u0000")) continue;
  scanned += 1;

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const at = index + 1;

    for (const token of candidateTokens(line)) {
      const label = LEAKED_FINGERPRINTS.get(
        crypto.createHash("sha256").update(token, "utf8").digest("hex"),
      );
      if (label !== undefined) {
        findings.push({
          file,
          line: at,
          reason: `valeur ayant fuité dans l'archive précédente — ${label}`,
        });
      }
    }

    if (PRIVATE_KEY.test(line)) {
      findings.push({ file, line: at, reason: "en-tête de clé privée" });
    }

    const assignment = SENSITIVE_ASSIGNMENT.exec(line);
    if (assignment) {
      const value = (assignment[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (!isPlaceholder(value)) {
        findings.push({
          file,
          line: at,
          reason: `${assignment[1]} reçoit une valeur littérale non marquée : « ${value.slice(0, 24)}… »`,
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`\n[secret-scan] ${findings.length} problème(s) sur ${scanned} fichiers :\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} — ${finding.reason}`);
  }
  console.error("");
  process.exit(1);
}

console.error(
  [
    "",
    `[secret-scan] ${scanned} fichiers livrables balayés, aucun secret réel trouvé.`,
    "",
    `  liste des fichiers   ${source}`,
    `  cherché              empreintes des ${LEAKED_FINGERPRINTS.size} valeurs ayant fuité,`,
    "                       en-têtes de clé privée, et affectation littérale d'une",
    "                       variable OATHRION_* sensible à une valeur non marquée",
    "",
  ].join("\n"),
);
