/**
 * `npm run bootstrap:admin` — crée le premier administrateur sans jamais écrire son
 * mot de passe dans l'environnement, dans une commande, ni dans un fichier.
 *
 * ## LES TROIS ENDROITS OÙ CE SECRET NE PASSE PAS
 *
 * 1. **`argv`.** `--password` n'existe pas, et le passer est refusé avec une
 *    explication plutôt qu'ignoré. Un argument de ligne de commande est visible dans
 *    `ps`, dans `/proc/<pid>/cmdline`, dans l'historique du shell et dans les journaux
 *    de la plupart des orchestrateurs.
 * 2. **L'environnement.** Aucune variable n'est lue pour obtenir le secret. C'est le
 *    problème que cette commande existe pour résoudre ; le reproduire ici n'aurait
 *    aucun intérêt.
 * 3. **La sortie.** Le compte rendu affiche l'adresse, l'organisation, le rôle et une
 *    empreinte du *hachage*. Jamais le mot de passe, jamais un fragment.
 *
 * ## DEUX MODES D'ENTRÉE
 *
 * - **Terminal** : saisie masquée, demandée deux fois. La confirmation n'est pas une
 *   politesse : une faute de frappe sur le mot de passe du seul administrateur d'un
 *   plan de contrôle produit un système dans lequel personne ne peut entrer, et dont
 *   la seule sortie est cette même commande avec `--force`.
 * - **Entrée standard redirigée** : la première ligne est le secret. C'est le mode
 *   pour un conteneur d'initialisation ou un gestionnaire de secrets :
 *
 *       kubectl get secret placet-admin -o jsonpath='{.data.password}' | base64 -d \
 *         | npm run bootstrap:admin -- --email admin@exemple.com
 *
 *   Ce fichier n'est pas couvert par eslint (`script/**` est ignoré) mais il l'est par
 *   `npm run typecheck`, qui inclut `script/**` délibérément.
 */

import { bootstrapAdmin, DEFAULT_BOOTSTRAP_ORGANIZATION_NAME } from "../server/bootstrap-admin";

const USAGE = `
Oathrion — amorçage du premier administrateur

  npm run bootstrap:admin -- --email <adresse> [options]

Options
  --email <adresse>    Adresse de connexion. Obligatoire.
  --name <nom>         Nom affiché dans le journal d'audit. Défaut : partie locale
                       de l'adresse.
  --org <nom>          Nom de l'organisation. Défaut : "${DEFAULT_BOOTSTRAP_ORGANIZATION_NAME}".
                       L'identifiant en est dérivé (« Acme Corp » → org_acme_corp).
  --force              Autorise deux cas dangereux, refusés par défaut :
                       une organisation qui a déjà un administrateur actif, et
                       un compte existant dont le mot de passe sera remplacé.
  --help               Affiche ce texte.

Le mot de passe n'est JAMAIS un argument. Il est lu sur l'entrée standard :
saisie masquée et confirmée dans un terminal, première ligne lue si l'entrée est
redirigée.

Exemples
  npm run bootstrap:admin -- --email admin@exemple.com --org "Acme Corp"
  printf '%s' "$ADMIN_PASSWORD" | npm run bootstrap:admin -- --email admin@exemple.com
`;

interface Args {
  email?: string;
  name?: string;
  org?: string;
  force: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    /*
     * `--password` est intercepté explicitement. Le laisser tomber dans le cas
     * « option inconnue » serait déjà un refus, mais un refus qui n'explique pas
     * pourquoi : l'opérateur retenterait avec une autre orthographe au lieu de
     * comprendre que le canal lui-même est le problème.
     */
    if (token === "--password" || token.startsWith("--password=")) {
      throw new UsageError(
        "--password n'existe pas, et c'est délibéré : un mot de passe passé en argument " +
          "est visible dans `ps`, dans /proc/<pid>/cmdline et dans l'historique du shell.\n" +
          "  Relancez sans cet argument : le secret vous sera demandé, masqué.\n" +
          "  Ou redirigez-le :  printf '%s' \"$SECRET\" | npm run bootstrap:admin -- --email …",
      );
    }

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--force") {
      args.force = true;
      continue;
    }

    const named = (flag: string): string | null => {
      if (token === flag) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError(`${flag} attend une valeur.`);
        }
        i += 1;
        return value;
      }
      if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
      return null;
    };

    const email = named("--email");
    if (email !== null) {
      args.email = email;
      continue;
    }
    const name = named("--name");
    if (name !== null) {
      args.name = name;
      continue;
    }
    const org = named("--org");
    if (org !== null) {
      args.org = org;
      continue;
    }

    throw new UsageError(`Option inconnue : "${token}".`);
  }

  return args;
}

/**
 * Saisie masquée.
 *
 * Le mode brut est utilisé plutôt que `readline` parce que `readline` écrit l'écho des
 * caractères avant qu'un intercepteur puisse les masquer ; le contourner suppose de
 * réécrire une méthode privée de la bibliothèque standard. Lire les touches
 * directement est plus long à écrire et n'a pas d'angle mort.
 *
 * Le mode brut précédent est restauré dans tous les chemins de sortie, y compris
 * Ctrl-C : laisser un terminal en mode brut le rend inutilisable après la commande.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const finish = (outcome: { value: string } | { error: Error }): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        switch (character) {
          case "\r":
          case "\n":
          case "\u0004": // Ctrl-D
            finish({ value });
            return;
          case "\u0003": // Ctrl-C
            finish({ error: new Error("Interrompu. Aucun compte n'a été créé.") });
            return;
          case "\u007f": // Retour arrière
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Les caractères de contrôle restants sont ignorés plutôt qu'insérés :
            // une séquence de touche fléchée collée dans un mot de passe produirait un
            // secret que son propriétaire ne peut pas retaper.
            if (character >= " ") value += character;
            break;
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  // Première ligne seulement : un `echo` ajoute un saut de ligne, et un mot de passe
  // qui se terminerait par un « \n » invisible serait impossible à retaper.
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

async function acquirePassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = await readPiped();
    if (piped === "") {
      throw new UsageError(
        "L'entrée standard est redirigée mais vide. Aucun mot de passe n'a été lu.\n" +
          "  Exemple :  printf '%s' \"$SECRET\" | npm run bootstrap:admin -- --email …",
      );
    }
    return piped;
  }

  const first = await promptHidden("Mot de passe (12 caractères minimum, non affiché) : ");
  const second = await promptHidden("Confirmation                                     : ");
  if (first !== second) {
    throw new UsageError("Les deux saisies diffèrent. Aucun compte n'a été créé.");
  }
  return first;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`\n[bootstrap-admin] ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    console.error(USAGE);
    return 0;
  }
  if (!args.email) {
    console.error(`\n[bootstrap-admin] --email est obligatoire.\n${USAGE}`);
    return 2;
  }

  let password: string;
  try {
    password = await acquirePassword();
  } catch (error) {
    console.error(`\n[bootstrap-admin] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const result = bootstrapAdmin({
    email: args.email,
    password,
    name: args.name,
    organizationName: args.org,
    force: args.force,
  });

  if (!result.ok) {
    console.error(`\n[bootstrap-admin] refusé (${result.code}) :\n`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    console.error("");
    return 1;
  }

  const verb = result.created
    ? "créé"
    : "mot de passe remplacé sur un compte existant (--force)";

  console.error(
    [
      "",
      "[bootstrap-admin] administrateur " + verb,
      "",
      `  organisation   ${result.organizationName}  (${result.organizationId})`,
      `  adresse        ${result.email}`,
      `  nom affiché    ${result.name}`,
      `  rôle           ${result.role}`,
      `  identifiant    ${result.userId}`,
      `  empreinte      ${result.passwordFingerprint}  (du hachage stocké, pas du secret)`,
      result.reactivated ? "  statut         compte suspendu réactivé" : null,
      "",
      "  Le mot de passe n'est stocké que sous forme de hachage scrypt, et son origine est",
      "  enregistrée comme « user » : OATHRION_CONSOLE_USERS ne l'écrasera pas au démarrage.",
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n[bootstrap-admin] échec inattendu :\n${String(error)}\n`);
    process.exit(1);
  });
