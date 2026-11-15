/**
 * Oathrion — créer l'espace d'un client et le lien qu'on lui remet.
 *
 *   npm run workspace:create -- --org "Acme" --email admin@acme.com [--days 7]
 *
 * C'est une commande d'EXPLOITANT (celui qui héberge Oathrion). Le client, lui, n'ouvre
 * qu'un lien dans son navigateur : il y choisit son nom et son mot de passe, puis le
 * parcours guidé le prend en main. Voir `server/workspace-invite.ts`.
 *
 * Le lien est imprimé UNE fois. Seul un hachage est conservé ; un lien perdu se remplace
 * en révoquant l'invitation, pas en la réaffichant.
 */

import { createWorkspaceInvitation, invitationLink } from "../server/workspace-invite";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const USAGE = `
Oathrion — créer l'espace d'un client

  npm run workspace:create -- --org "<nom de l'organisation>" --email <adresse de l'administrateur> [--days 7]

Le lien imprimé est à remettre au client par un canal de confiance. Il est valable
--days jours (1 à 30) et ne sert qu'une fois.
`;

function main(): number {
  if (process.argv.includes("--help")) {
    console.error(USAGE);
    return 0;
  }
  const org = arg("org");
  const email = arg("email");
  if (!org || !email) {
    console.error(`\n[workspace:create] --org et --email sont obligatoires.\n${USAGE}`);
    return 2;
  }
  const days = arg("days") ? Number(arg("days")) : undefined;
  const result = createWorkspaceInvitation({ organizationName: org, email, days });
  if (!result.ok) {
    console.error(`\n[workspace:create] refusé (${result.code}) : ${result.problem}\n`);
    return 1;
  }
  const base =
    process.env.OATHRION_PUBLIC_URL?.trim() || `http://127.0.0.1:${process.env.OATHRION_PILOT_PORT ?? process.env.PORT ?? "5000"}`;
  console.log(
    [
      "",
      `Espace ${result.createdOrganization ? "créé" : "existant, sans administrateur"} : ${result.organizationName} (${result.organizationId})`,
      `Administrateur invité : ${result.email}`,
      `Valable jusqu'au : ${result.expiresAt}`,
      "",
      "Lien à remettre au client (affiché une seule fois) :",
      "",
      `  ${invitationLink(base, result.token)}`,
      "",
      process.env.OATHRION_PUBLIC_URL ? "" : "  (OATHRION_PUBLIC_URL n'est pas défini : le lien vise l'adresse locale.)",
    ].join("\n"),
  );
  return 0;
}

process.exit(main());
