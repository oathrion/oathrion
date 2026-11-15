/**
 * `npm run package` — produit l'archive de livraison, et refuse de la produire si elle
 * contiendrait un secret.
 *
 * ## LE DÉFAUT QUE CETTE COMMANDE REMPLACE
 *
 * L'archive précédente a été faite par un `tar` sur le répertoire de travail. Elle
 * contenait donc tout ce qui s'y trouvait, `.env` compris. La règle appliquée ici est
 * l'inverse : **rien ne sort qui ne soit suivi par git**, et ce que git suit est
 * revérifié contre une liste de refus explicite avant *et* après l'écriture de
 * l'archive.
 *
 * La vérification d'après-coup n'est pas redondante. Elle porte sur le contenu réel de
 * l'archive tel que `tar` le relit, pas sur la liste qu'on lui a passée — c'est la seule
 * façon de détecter qu'un fichier a été ajouté autrement que par le manifeste.
 *
 * ## CE QUI N'EST PAS FAIT ICI
 *
 * Aucune signature, aucune publication, aucun envoi. La commande écrit un fichier
 * local et son empreinte SHA-256. Signer une livraison suppose une clé, donc un
 * gestionnaire de secrets, et cela appartient à une phase ultérieure — pas à celle qui
 * répare une fuite.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { manifestProblems } from "./release-manifest";

const OUTPUT_DIR = "release";

/**
 * Le format demandé. `--zip` existe pour une raison précise et non par confort.
 *
 * La livraison attendue à la fin de chaque phase est un `.zip`. Tant que cette commande
 * ne savait produire qu'un `.tar.gz`, ce zip était fabriqué à côté, à la main — donc sans
 * liste de refus, sans revérification du contenu écrit, sans empreinte. C'est exactement
 * le geste qui a publié le `.env` : un empaquetage manuel parce que l'outil vérifié ne
 * produisait pas la forme dont on avait besoin. Un garde-fou qu'il faut contourner pour
 * livrer ne protège personne.
 */
const format: "tar" | "zip" = process.argv.includes("--zip") ? "zip" : "tar";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function fail(message: string): never {
  console.error(`\n[package] ${message}\n`);
  process.exit(1);
}

/* --------------------------- 1. contexte git ------------------------------- */

try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  fail(
    "ce répertoire n'est pas un dépôt git.\n" +
      "  L'empaquetage se fonde sur `git ls-files` : c'est ce qui garantit qu'un fichier\n" +
      "  ignoré — .env, data.db — ne peut pas se retrouver dans la livraison. Sans dépôt,\n" +
      "  cette garantie n'existe pas, et produire l'archive quand même reviendrait à\n" +
      "  refaire exactement l'erreur que cette commande corrige.",
  );
}

const commit = git(["rev-parse", "--short", "HEAD"]).trim();
const dirty = git(["status", "--porcelain"]).trim() !== "";

/* ------------------------- 2. manifeste et refus --------------------------- */

const tracked = git(["ls-files", "-z"]).split("\0").filter((entry) => entry !== "");

if (tracked.length === 0) fail("`git ls-files` ne renvoie aucun fichier.");

const problems = manifestProblems(tracked);
if (problems.length > 0) {
  fail(
    `${problems.length} fichier(s) suivi(s) par git ne doivent pas être livrés :\n\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      `\n\n  Un fichier ignoré par .gitignore ne peut pas apparaître ici, donc chacun de\n` +
      `  ces chemins a été ajouté explicitement (git add -f). Retirez-le de l'index\n` +
      `  (git rm --cached <chemin>) et, s'il s'agit d'un secret, considérez-le comme\n` +
      `  publié : faites-le tourner.`,
  );
}

/* ------------------- 2bis. les licences sont-elles réelles ? --------------- */

/**
 * Refus d'empaqueter une licence à trous.
 *
 * ## Pourquoi ce contrôle est ici et pas dans `release-manifest.ts`
 *
 * `releasePathProblem` est une fonction pure d'un CHEMIN — c'est ce qui la rend testable
 * sans dépôt. Celui-ci lit du CONTENU, donc il appartient à la commande qui lit déjà les
 * fichiers.
 *
 * ## Pourquoi un refus et non un avertissement
 *
 * Un `LICENSE` portant `<TITULAIRE>` est pire que l'absence de licence. Sans fichier, un
 * juriste conclut « aucun droit accordé, il faut demander » — une conclusion correcte.
 * Avec un fichier à trou, le lecteur croit lire une licence, qui n'accorde rien au nom de
 * personne. C'est la même règle que celle du jeton de supervision trop court : une
 * protection qui a l'air d'en être une est plus dangereuse que son absence.
 *
 * Et c'est la trajectoire exacte des deux défauts que cette commande existe pour
 * empêcher : le `.env` publié par un empaquetage manuel, et le préfixe `aos_` resté faux
 * deux ans dans `DEPLOYMENT.md` parce que rien ne le relisait.
 */
const LICENCE_PLACEHOLDERS = ["<TITULAIRE>", "<CONTACT>", "<HOLDER>", "<COPYRIGHT HOLDER>"];
const LICENCE_FILES = tracked.filter(
  (entry) => entry === "LICENSE" || entry.endsWith("/LICENSE"),
);

if (LICENCE_FILES.length === 0) {
  fail(
    "aucun fichier LICENSE suivi par git.\n" +
      "  Une archive livrée sans licence laisse son destinataire sans droit d'usage\n" +
      "  démontrable. Si c'est voulu, c'est une décision à écrire, pas à constater.",
  );
}

const unfilled = LICENCE_FILES.flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return LICENCE_PLACEHOLDERS.filter((marker) => text.includes(marker)).map(
    (marker) => `  - ${file} contient encore ${marker}`,
  );
});

if (unfilled.length > 0) {
  fail(
    `licence incomplète — ${unfilled.length} marqueur(s) de gabarit :\n\n` +
      unfilled.join("\n") +
      "\n\n  Un LICENSE à trous est PIRE qu'un dépôt sans licence : sans fichier, un\n" +
      "  juriste conclut « aucun droit accordé, il faut demander » ; avec celui-ci, le\n" +
      "  lecteur croit lire une licence qui n'accorde rien au nom de personne.",
  );
}

/* ---------------------------- 3. écriture --------------------------------- */

mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Le répertoire racine à l'intérieur de l'archive.
 *
 * Sans lui, l'extraction déverse 258 fichiers dans le répertoire courant et se mêle à ce
 * qui s'y trouve déjà. La consigne de livraison est que l'archive puisse être extraite
 * dans un dossier neuf et installée : elle doit donc porter ce dossier elle-même plutôt
 * que compter sur la prudence de celui qui l'ouvre.
 */
const root = `placet-${commit}${dirty ? "-dirty" : ""}`;
const name = `${root}.${format === "zip" ? "zip" : "tar.gz"}`;
const archive = path.join(OUTPUT_DIR, name);
const listFile = path.join(OUTPUT_DIR, ".manifest");
const stage = path.join(OUTPUT_DIR, ".stage");

// Passé par fichier et non par la ligne de commande : le dépôt compte plusieurs
// centaines de fichiers suivis, et une liste d'arguments assez longue est tronquée par
// le système sans message — une archive incomplète est plus difficile à repérer qu'une
// archive absente.
writeFileSync(listFile, `${tracked.join("\n")}\n`, "utf8");

// Recopie dans une aire d'assemblage plutôt que deux chemins d'écriture séparés : `tar`
// sait préfixer avec `--transform`, `zip` ne sait pas, et maintenir deux mécanismes
// différents pour la même garantie est le meilleur moyen de n'en corriger qu'un.
// L'aire ne reçoit que les chemins du manifeste, déjà passés par la liste de refus.
rmSync(stage, { recursive: true, force: true });
for (const entry of tracked) {
  const destination = path.join(stage, root, entry);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(entry, destination, { dereference: true });
}

try {
  if (format === "zip") {
    // -X : ne pas stocker uid/gid ni les attributs étendus de la machine d'origine.
    // -9 : compression maximale. -r : parcours du seul répertoire racine assemblé.
    execFileSync("zip", ["-q", "-X", "-9", "-r", path.resolve(archive), root], {
      cwd: stage,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } else {
    execFileSync(
      "tar",
      [
        "--create",
        "--gzip",
        "--file",
        path.resolve(archive),
        "--directory",
        stage,
        // Horodatages et propriétaires normalisés : deux empaquetages du même commit
        // doivent produire la même empreinte, sinon l'empreinte ne prouve rien.
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mtime=@0",
        root,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
} catch (error) {
  fail(
    `${format === "zip" ? "zip" : "tar"} a échoué : ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
}

/* ------------------- 4. vérification du contenu réel ---------------------- */

const rawEntries = (
  format === "zip"
    ? execFileSync("unzip", ["-Z1", path.resolve(archive)], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    : execFileSync("tar", ["--list", "--file", path.resolve(archive)], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
)
  .split("\n")
  .map((entry) => entry.replace(/\/+$/, ""))
  .filter((entry) => entry !== "" && entry !== root);

/**
 * Le préfixe racine est retiré avant de rejuger le contenu, et son absence est elle-même
 * une faute.
 *
 * C'est le point où l'introduction du répertoire racine pouvait désarmer la vérification
 * sans que rien ne le signale : plusieurs règles de refus s'ancrent en début de chemin
 * (`node_modules/…`, `dist/…`, `coverage/…`), et sous un préfixe elles cessent de
 * correspondre. La revue d'après-coup aurait continué à s'exécuter, à ne rien trouver, et
 * à l'annoncer.
 */
const listed: string[] = [];
for (const entry of rawEntries) {
  if (!entry.startsWith(`${root}/`)) {
    fail(
      `l'archive contient une entrée hors du répertoire racine : ${entry}\n` +
        `  Tout doit être sous ${root}/. Une entrée ailleurs échapperait aux règles de\n` +
        `  refus ancrées en début de chemin, et l'archive s'extrairait en dehors de son\n` +
        `  propre dossier.`,
    );
  }
  listed.push(entry.slice(root.length + 1));
}

rmSync(stage, { recursive: true, force: true });

const shipped = manifestProblems(listed);
if (shipped.length > 0) {
  fail(
    `l'archive écrite contient ${shipped.length} entrée(s) interdite(s) :\n\n` +
      shipped.map((problem) => `  - ${problem}`).join("\n") +
      `\n\n  L'archive est laissée en place pour inspection, mais elle NE DOIT PAS être\n` +
      `  livrée. Ce refus porte sur le contenu relu de l'archive, pas sur le manifeste :\n` +
      `  un fichier y est donc entré autrement que par \`git ls-files\`.`,
  );
}

const digest = crypto.createHash("sha256").update(readFileSync(archive)).digest("hex");
const bytes = statSync(archive).size;

console.error(
  [
    "",
    "[package] archive de livraison écrite",
    "",
    `  fichier    ${archive}`,
    `  racine     ${root}/`,
    `  taille     ${(bytes / 1_048_576).toFixed(2)} Mo`,
    // Deux nombres et non un : `tar --list` et `unzip -Z1` énumèrent aussi les
    // répertoires. N'afficher que le total ferait croire à 33 fichiers de plus que ce que
    // git suit, et un écart inexpliqué dans un rapport de sécurité se lit comme une fuite.
    `  fichiers   ${tracked.length}`,
    `  entrées    ${listed.length}  (fichiers + répertoires, toutes rejugées)`,
    `  commit     ${commit}${dirty ? "  (répertoire de travail modifié)" : ""}`,
    `  sha256     ${digest}`,
    "",
    "  Contenu vérifié deux fois : manifeste avant écriture, contenu relu après.",
    "  Aucun .env, aucune base SQLite, aucun journal.",
    dirty
      ? "  ATTENTION : le répertoire de travail contient des modifications non validées.\n" +
        "  L'archive porte le suffixe -dirty et ne correspond à aucun commit."
      : null,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n"),
);
