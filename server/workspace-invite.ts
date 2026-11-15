/**
 * Créer l'espace d'un client SANS que le client touche à un terminal.
 *
 * ## Le partage, dit honnêtement
 *
 * DÉPLOIEMENT (l'exploitant, une fois par client) : `npm run workspace:create` crée
 * l'organisation et une invitation d'ADMINISTRATEUR à usage unique, puis imprime un lien.
 * C'est la seule ligne de commande du parcours, et elle appartient à qui héberge Oathrion.
 *
 * PRODUIT (le client) : il ouvre le lien, lit « Créer l'espace Acme », choisit son nom et
 * son mot de passe, et arrive dans la console connecté. Ni Docker, ni `.env`, ni
 * `bootstrap:admin`.
 *
 * ## Pourquoi une invitation et pas un nouveau mécanisme
 *
 * L'invitation existe déjà, avec tout ce qu'un lien d'accès exige : secret haché, une
 * seule utilisation revendiquée atomiquement, expiration, révocation, étranglement des
 * essais. Un « lien de création d'espace » écrit à côté aurait été une seconde
 * implémentation de chacune de ces règles. Ici, le lien EST une invitation de rôle
 * `admin` dans une organisation qui vient d'être créée.
 *
 * ## La garde
 *
 * Une organisation qui a déjà un administrateur actif est refusée : sinon cette commande
 * permettrait à qui a accès au serveur d'entrer dans l'espace d'un client existant, et
 * cela ressemblerait dans le journal à une création.
 */

import { organizationStore } from "./repositories/organizations";
import { identityTokenStore } from "./repositories/identity-tokens";
import { normaliseEmail, userStore } from "./repositories/users";
import { organizationNameProblem, type OrganizationId } from "@shared/tenancy";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WorkspaceInviteInput {
  organizationName: string;
  email: string;
  /** Jours de validité du lien. 7 par défaut, 30 au plus (la borne des invitations). */
  days?: number;
  createdBy?: string;
}

export type WorkspaceInviteResult =
  | {
      ok: true;
      organizationId: OrganizationId;
      organizationName: string;
      email: string;
      token: string;
      expiresAt: string;
      createdOrganization: boolean;
    }
  | { ok: false; code: "invalid_email" | "invalid_organization" | "admin_exists" | "invitation_pending"; problem: string };

export function createWorkspaceInvitation(input: WorkspaceInviteInput): WorkspaceInviteResult {
  const email = normaliseEmail(input.email ?? "");
  if (!EMAIL_SHAPE.test(email)) {
    return { ok: false, code: "invalid_email", problem: `"${input.email}" is not a usable address.` };
  }
  const organizationName = (input.organizationName ?? "").trim();
  const nameProblem = organizationNameProblem(organizationName);
  if (nameProblem !== null) {
    return { ok: false, code: "invalid_organization", problem: `Organization name refused: ${nameProblem}` };
  }

  const existing = organizationStore.findByName(organizationName);
  if (existing && userStore.hasAnotherActiveAdmin(existing.id, "")) {
    return {
      ok: false,
      code: "admin_exists",
      problem:
        `The organization "${organizationName}" already has an active administrator. Its members ` +
        `are invited from the console (Settings → Members), not from the server.`,
    };
  }

  const organization = existing ?? organizationStore.ensureByName(organizationName);
  const pending = identityTokenStore.livePending(organization.id, "invite", email);
  if (pending) {
    return {
      ok: false,
      code: "invitation_pending",
      problem:
        `An invitation for ${email} is already pending in "${organizationName}" (expires on ` +
        `${pending.expiresAt}). The previous link cannot be shown again: only its hash is ` +
        `kept. Revoke it from an administrator's console, or wait for it to expire.`,
    };
  }

  const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), 30);
  const issued = identityTokenStore.create({
    organizationId: organization.id,
    purpose: "invite",
    email,
    role: "admin",
    createdBy: input.createdBy ?? "exploitant (workspace:create)",
    ttlMs: days * 86_400_000,
  });

  return {
    ok: true,
    organizationId: organization.id,
    organizationName: organization.name,
    email,
    token: issued.token,
    expiresAt: issued.record.expiresAt,
    createdOrganization: existing === null,
  };
}

/**
 * Le lien à remettre au client. Le jeton est dans le FRAGMENT (`#…`) : un fragment
 * n'est jamais envoyé au serveur, donc il n'apparaît dans aucun journal d'accès ni dans
 * un en-tête `Referer`. La console le lit puis l'efface de la barre d'adresse.
 */
export function invitationLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/console#/bienvenue?invitation=${encodeURIComponent(token)}`;
}
