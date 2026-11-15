/**
 * `npm run mcp:discover` — ce que le serveur MCP de vos agents déclare réellement.
 *
 *   OATHRION_LOCAL_MCP_URL=http://127.0.0.1:7801/ npm run mcp:discover -- --destination=local-fixture
 *   OATHRION_DESTINATIONS='[…]' npm run mcp:discover -- --destination=acme-erp
 *   … --destination=acme-erp --declare=refund   # rend une déclaration OATHRION_TOOLS prête à coller
 *
 * ## À quoi ça sert
 *
 * Brancher un agent existant commence par une question de fait : quels outils ce serveur
 * expose-t-il, et sous quels noms d'arguments ? Sans réponse, un exploitant écrit sa
 * déclaration `OATHRION_TOOLS` de mémoire, et une faute d'une lettre ne se révèle qu'au
 * premier appel d'un client.
 *
 * Cette commande émet un `tools/list` sur une destination **déjà enregistrée**, donc à
 * travers la même allowlist et les mêmes règles d'adresse qu'un appel réel. Elle ne
 * contacte rien qui ne soit pas déjà déclaré : ce n'est pas un scanner.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle n'écrit aucune configuration. `--declare=<verbe>` imprime une déclaration que
 * l'exploitant relit et colle lui-même : les sources d'arguments sont DEVINÉES depuis les
 * noms (`customer` → `target`, `amount` → `metadata.amount`), et une devinette que la
 * commande écrirait d'autorité dans un fichier serait une projection que personne n'a
 * relue.
 *
 * Codes de sortie : 0 des outils ont été découverts · 1 la découverte a échoué ·
 * 2 impossible à mettre en place (destination inconnue, argument manquant).
 */

import { listDestinations } from "../server/authority/destinations";
import { discoverDownstreamTools, DownstreamDiscoveryError } from "../server/gateway/tools/mcp-client";

function argumentValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/**
 * La source de contexte la plus probable pour un nom d'argument.
 *
 * Des DEVINETTES, et le mot est employé exprès. Elles servent à faire gagner du temps à
 * la lecture, pas à décider : la sortie est imprimée pour être relue. Un nom inconnu rend
 * `metadata.<nom>`, qui est la source la plus honnête — « ce que l'agent envoie ».
 */
function guessSource(argument: string): string {
  const table: Record<string, string> = {
    customer: "target",
    customer_id: "target",
    target: "target",
    repository: "target",
    repo: "target",
    currency: "currency",
    agent: "agentId",
    agent_id: "agentId",
    action: "action",
    idempotency_key: "executionId",
    execution_id: "executionId",
  };
  return table[argument.toLowerCase()] ?? `metadata.${argument}`;
}

async function main(): Promise<number> {
  const wanted = argumentValue("destination");
  const declareFor = argumentValue("declare");

  let registry;
  try {
    registry = listDestinations(process.env);
  } catch (error) {
    console.error(`Le registre de destinations est illisible : ${String(error)}`);
    return 2;
  }

  if (registry.length === 0) {
    console.error("Aucune destination n'est enregistrée.");
    console.error("  Déclarez-en une avec OATHRION_DESTINATIONS, ou OATHRION_LOCAL_MCP_URL pour une");
    console.error("  fixture loopback, puis relancez. Cette commande ne contacte que ce qui est");
    console.error("  déjà déclaré — elle ne balaye rien.");
    return 2;
  }

  if (!wanted) {
    console.error("Indiquez la destination à interroger :");
    for (const entry of registry) {
      console.error(`  npm run mcp:discover -- --destination=${entry.id}    # ${entry.label}`);
    }
    return 2;
  }

  const entry = registry.find((candidate) => candidate.id === wanted);
  if (!entry) {
    console.error(`"${wanted}" n'est pas une destination enregistrée.`);
    console.error(`  Connues : ${registry.map((d) => d.id).join(", ")}`);
    return 2;
  }

  console.log(`Destination « ${entry.label} » (${entry.id}) — ${entry.destination.origin}`);
  console.log(`Portée : ${entry.organizations === "*" ? "partagée (*)" : entry.organizations.join(", ")}`);
  console.log("");

  let tools;
  try {
    tools = await discoverDownstreamTools(entry.destination);
  } catch (error) {
    if (error instanceof DownstreamDiscoveryError) {
      console.error(`La découverte a échoué : ${error.message}`);
      console.error("");
      console.error("  Si ce serveur n'implémente pas tools/list, c'est une limite du serveur et");
      console.error("  non une panne : vérifiez la correspondance à la main, et sachez que le reçu");
      console.error("  d'une dépêche portera alors `schemaChecked: false`. Pour que « non");
      console.error('  vérifiable » vaille « non », ajoutez "requireSchema": true à la déclaration.');
      return 1;
    }
    console.error(`La découverte a échoué : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (tools.length === 0) {
    console.log("Le serveur répond à tools/list et ne déclare aucun outil.");
    return 0;
  }

  console.log(`${tools.length} outil(s) déclaré(s) :`);
  for (const tool of tools) {
    console.log("");
    console.log(`  ${tool.name}`);
    if (tool.description) console.log(`    ${tool.description}`);
    if (tool.properties.length === 0) {
      /*
       * Un schéma sans propriétés est OUVERT, et c'est une information : Oathrion ne
       * refusera pas un argument non déclaré pour ce serveur, parce qu'il n'y a rien à
       * quoi le comparer.
       */
      console.log("    arguments : aucun déclaré (schéma ouvert — rien à vérifier contre)");
    } else {
      for (const property of tool.properties) {
        const mark = tool.required.includes(property) ? " (requis)" : "";
        console.log(`    · ${property}${mark}`);
      }
    }
  }

  if (declareFor) {
    const tool = tools[0];
    if (tools.length > 1) {
      console.log("");
      console.log(`Plusieurs outils : --declare utilise le premier (${tool!.name}).`);
    }
    /*
     * Imprimé, jamais écrit. Les sources sont devinées depuis les noms, et une devinette
     * que cette commande inscrirait d'autorité dans un fichier serait une projection que
     * personne n'a relue — exactement ce que le refus « source inconnue » existe pour
     * empêcher.
     */
    const args = Object.fromEntries(tool!.properties.map((p) => [p, guessSource(p)]));
    console.log("");
    console.log("Déclaration à RELIRE puis coller dans OATHRION_TOOLS :");
    console.log("");
    console.log(
      JSON.stringify(
        [
          {
            id: `${entry.id.replace(/-/g, "_")}_${declareFor}`,
            label: `${entry.label} — ${declareFor}`,
            destination: entry.id,
            tool: tool!.name,
            actions: [declareFor],
            arguments: args,
          },
        ],
        null,
        2,
      ),
    );
    console.log("");
    console.log("  Les sources ci-dessus sont DEVINÉES depuis les noms d'arguments. Relisez-les :");
    console.log("  une source fausse enverrait la mauvaise valeur dans une instruction autorisée.");
    console.log(`  Le verbe « ${declareFor} » doit figurer dans shared/policy/actions.ts, sinon`);
    console.log("  le serveur refusera de démarrer — ce qui est voulu.");
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
