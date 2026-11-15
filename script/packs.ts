/**
 * `npm run packs` — ce que chaque paquet gouverne, et ce qu'il ne gouverne pas.
 *
 * Un paquet s'active par un nom dans une variable d'environnement. Sans cette sortie, un
 * exploitant qui écrit `OATHRION_INTERCEPT_PACKS=stripe` ne sait ni quels chemins il vient
 * de mettre sous contrôle, ni — et c'est le plus important — ce qui reste hors de portée.
 *
 * Les `limits` sont imprimées aussi fort que les règles. Un catalogue qui ne montrerait
 * que ce qu'il couvre laisserait croire qu'il couvre le reste.
 */

import { INTERCEPT_PACKS } from "../server/intercept/packs";

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const packs = only.length > 0
  ? INTERCEPT_PACKS.filter((p) => only.includes(p.id))
  : INTERCEPT_PACKS;

if (packs.length === 0) {
  console.error(`Aucun paquet nommé "${only.join(", ")}".`);
  console.error(`Disponibles : ${INTERCEPT_PACKS.map((p) => p.id).join(", ")}`);
  process.exit(2);
}

console.log("\n" + "=".repeat(78));
console.log("Oathrion — PAQUETS DE RÈGLES D'INTERCEPTION");
console.log("=".repeat(78));

for (const pack of packs) {
  console.log(`\n${pack.label}  —  OATHRION_INTERCEPT_PACKS=${pack.id}`);
  console.log("─".repeat(78));
  console.log(`  origine     ${pack.origin}`);
  console.log(`  credential  ${pack.credential.header}: ${pack.credential.template}`);

  console.log(`\n  CE QUI EST GOUVERNÉ`);
  for (const rule of pack.rules) {
    const bits = [`${rule.method} ${rule.path}`];
    console.log(`    ${bits[0]!.padEnd(46)} → ${rule.action}`);
    console.log(`      cible   ${rule.target}`);
    if (rule.amount) {
      console.log(
        `      montant ${rule.amount}` +
          (rule.amountScale ? `  ÷ ${String(rule.amountScale)}` : "") +
          (rule.currency ? `   devise ${rule.currency}` : ""),
      );
    }
    if (rule.stream) console.log(`      relais  en flux`);
  }

  console.log(`\n  CE QUI NE L'EST PAS`);
  for (const limit of pack.limits) {
    /* Repliées à 74 colonnes : une limite qu'on ne lit pas n'est pas déclarée. */
    const mots = limit.replace(/\*\*/g, "").split(" ");
    let ligne = "   ·";
    for (const mot of mots) {
      if ((ligne + " " + mot).length > 74) {
        console.log(ligne);
        ligne = "    ";
      }
      ligne += " " + mot;
    }
    console.log(ligne);
  }

  console.log(`\n  À DÉCLARER VOUS-MÊME (la portée par locataire n'appartient qu'à vous)`);
  console.log(
    `    OATHRION_DESTINATIONS=[{"id":"${pack.id}","url":"${pack.origin}",` +
      `"organizations":["org_…"]}]`,
  );
  console.log(
    `    OATHRION_INTERCEPT_KEY_${pack.id.toUpperCase().replace(/-/g, "_")}=<jeton>`,
  );
}

console.log("\n" + "=".repeat(78));
console.log("Chemins et champs issus de la DOCUMENTATION PUBLIÉE de chaque fournisseur.");
console.log("Éprouvés contre un corps de requête réaliste (`intercept-packs.test.ts`).");
console.log("NON VÉRIFIÉS contre le service réel : aucun appel n'est fait par ces tests.");
console.log("=".repeat(78) + "\n");
