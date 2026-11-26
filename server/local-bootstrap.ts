/**
 * L'AMORÇAGE DU MODE LOCAL — `oathrion wrap`, étape E3b.
 *
 * Ce que fait `oathrion wrap` au démarrage, pour qu'un développeur n'ait rien à configurer :
 *
 *   1. lancer le serveur MCP enveloppé, lire ses outils, l'inscrire (`launchWrappedServer`) ;
 *   2. l'espace « Oathrion local » et son administrateur, la personne elle-même — sans
 *      invitation ni mot de passe à choisir : elle se connecte par le lien d'`oathrion console` ;
 *   3. l'agent `agt_wrap_<serveur>`, avec les portées `mcp:read` et `mcp:write` — jamais
 *      `mcp:destructive` : une destruction reste bloquée tant qu'une personne ne l'accorde pas ;
 *   4. la clé de cet agent, LIÉE à lui, renouvelée à chaque lancement ;
 *   5. les règles par défaut : chaque écriture attend une approbation.
 *
 * ## Les règles ne sont jamais réécrites
 *
 * Une personne qui ouvre une règle dans la console (« ces écritures sont libres ») doit la
 * retrouver au lancement suivant. L'amorçage ne fait donc qu'AJOUTER : une écriture déjà
 * couverte par une règle `pol_wrap_<serveur>_…` — activée ou non — est laissée telle quelle ;
 * une écriture nouvelle (le serveur a gagné un outil) reçoit une règle de plus. Un outil
 * nouveau ne passe donc jamais sans approbation par défaut, et un choix humain n'est jamais
 * défait.
 *
 * ## Ce que l'enfant voit
 *
 * Son environnement est celui de la personne qui lance `oathrion wrap`, MOINS tout ce qui
 * appartient à Oathrion (`childEnvironment`) : ni la clé de l'agent, ni le secret de session,
 * ni le chemin de la base. Un serveur MCP tiers est du code tiers.
 */

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";

import type { OrganizationId } from "@shared/tenancy";
import { agentCreateSchema, policyCreateContract, toAgent, toPolicy } from "@shared/validation";

import { displayPrefixOf, hashKey } from "./api-keys";
import type { WrappedToolEntry } from "./gateway/tools/stdio-mcp-tool";
import { apiKeyStore } from "./repositories/api-keys";
import { organizationStore } from "./repositories/organizations";
import { repositoriesFor } from "./repositories";
import { hashPassword } from "./passwords";
import { userStore } from "./repositories/users";

export const LOCAL_ORGANIZATION = "Oathrion local";
export const LOCAL_ADMIN_EMAIL = "vous@oathrion.local";
/** Une règle tient au plus 50 verbes (`policyConditionSchema`). */
const VERBS_PER_POLICY = 50;

export interface WrapConfig {
  name: string;
  command: string;
  args: string[];
}

/** La configuration que le lanceur `oathrion wrap` passe au serveur local. */
export function readWrapConfig(env: NodeJS.ProcessEnv): WrapConfig | null {
  const name = env.OATHRION_WRAP_NAME?.trim();
  const raw = env.OATHRION_WRAP_COMMAND?.trim();
  if (!name && !raw) return null;
  if (!name || !raw) throw new Error("OATHRION_WRAP_NAME and OATHRION_WRAP_COMMAND go together.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OATHRION_WRAP_COMMAND must be a JSON array: the command, then its arguments.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === "string" && part !== "")) {
    throw new Error("OATHRION_WRAP_COMMAND must be a non-empty JSON array of strings.");
  }
  const [command, ...args] = parsed as string[];
  return { name, command: command!, args };
}

/** L'environnement de l'enfant : celui de la personne, sans rien de ce qui est à Oathrion. */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(OATHRION|PLACET|ARIA)_/.test(key)) continue;
    if (key === "DATABASE_URL" || key === "DATABASE_DRIVER" || key === "PORT" || key === "RATE_LIMIT_STORE") continue;
    out[key] = value;
  }
  return out;
}

/** Le nom de la personne : celui de sa session sur la machine, sinon « Vous ». */
function localPersonName(): string {
  try {
    const name = userInfo().username.trim();
    return name === "" ? "You" : name.slice(0, 80);
  } catch {
    return "You";
  }
}

/** L'auteur d'une décision prise dans le client MCP, tel que le journal le retient. */
export const APPROVER_NAME = "You, from your MCP client";

export interface LocalWorkspace {
  organizationId: OrganizationId;
  agentId: string;
  /** L'administrateur vient d'être créé, à ce lancement (le premier). */
  personCreated: boolean;
  /** Les règles ajoutées à ce lancement. */
  createdPolicies: string[];
}

/**
 * L'espace « Oathrion local » et la personne. En local, la machine est déjà à elle : ni
 * invitation ni mot de passe à choisir. L'essai réel du 28 octobre 2026 l'a montré — le lien
 * coupé au copier-coller, puis le compte oublié (STRESS-TEST-LOG §5.53). L'administrateur est
 * créé d'emblée, avec un mot de passe aléatoire que personne ne connaît ; on entre par le lien
 * d'`oathrion console` (`POST /api/local/login`). Un administrateur déjà là (créé par une
 * invitation, sur une installation plus ancienne) est gardé tel quel.
 */
export function ensureLocalSpace(): { organizationId: OrganizationId; personCreated: boolean } {
  const organization = organizationStore.ensureByName(LOCAL_ORGANIZATION);
  const organizationId = organization.id as OrganizationId;
  let personCreated = false;
  if (!userStore.hasAnotherActiveAdmin(organizationId, "")) {
    const person = userStore.ensure({
      email: LOCAL_ADMIN_EMAIL,
      name: localPersonName(),
      passwordHash: hashPassword(randomBytes(32).toString("base64url")),
      passwordSource: "user",
    });
    userStore.grant(organizationId, person.id, "admin");
    personCreated = true;
  }
  return { organizationId, personCreated };
}

/** Les portées d'un agent local : lire et écrire, jamais détruire tant qu'une personne ne l'accorde pas. */
function localPermissions(subject: string) {
  return [
    { scope: "mcp:read", label: "Read", description: `The read tools ${subject}.`, granted: true, risk: "low" },
    { scope: "mcp:write", label: "Write", description: "The write tools, under the rules.", granted: true, risk: "medium" },
    { scope: "mcp:destructive", label: "Destroy", description: "Delete, pay, execute: refused by default.", granted: false, risk: "high" },
  ];
}

async function ensureAgent(organizationId: OrganizationId, agentId: string, name: string, description: string, subject: string): Promise<void> {
  const repositories = repositoriesFor(organizationId);
  if (await repositories.agents.findById(agentId)) return;
  const parsed = agentCreateSchema.parse({
    id: agentId,
    name,
    description,
    provider: "custom",
    model: "mcp-client",
    status: "active",
    owner: "local",
    mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
    permissions: localPermissions(subject),
    policyIds: [],
    tags: ["oathrion-wrap"],
  });
  await repositories.agents.create(toAgent(parsed));
}

/** Un identifiant sûr tiré d'un nom de client (« Cursor » → `cursor`). */
export function clientSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 40);
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : "client";
}

/**
 * L'agent d'un CLIENT (Cursor, Claude Code) : c'est ainsi que la personne pense son agent, et
 * c'est le nom qu'elle voit dans la console. Créé à la première connexion du client, pour tous
 * ses serveurs (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`).
 */
export async function ensureClientAgent(organizationId: OrganizationId, client: string): Promise<{ agentId: string; name: string }> {
  const name = client.trim().slice(0, 60) || "MCP client";
  const agentId = `agt_local_${clientSlug(name)}`;
  await ensureAgent(organizationId, agentId, name, `The MCP client "${name}", which goes through Oathrion to reach its servers.`, "of its servers");
  return { agentId, name };
}

/** Une clé neuve, LIÉE à l'agent, propre à un relais : elle est révoquée quand il part. */
export function issueAgentKey(organizationId: OrganizationId, agentId: string, label: string): { keyId: string; key: string } {
  const key = `oathrion_${randomBytes(32).toString("base64url")}`;
  const keyId = `key_local_${agentId.replace(/^agt_/, "")}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  apiKeyStore.create({
    id: keyId,
    organizationId,
    name: `oathrion wrap · ${label}`,
    role: "operator",
    secretHash: hashKey(key),
    prefix: displayPrefixOf(key),
    source: "user",
    createdBy: "oathrion wrap",
    agentId,
  });
  return { keyId, key };
}

/** La clé d'approbation d'un relais (`--approbation client`) : son nom est l'auteur des décisions prises dans le client. */
export function issueApproverKey(organizationId: OrganizationId): { keyId: string; key: string } {
  const key = `oathrion_${randomBytes(32).toString("base64url")}`;
  const keyId = `key_local_approbation_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  apiKeyStore.create({
    id: keyId,
    organizationId,
    name: APPROVER_NAME,
    role: "approver",
    secretHash: hashKey(key),
    prefix: displayPrefixOf(key),
    source: "user",
    createdBy: "oathrion wrap",
  });
  return { keyId, key };
}

export function revokeLocalKey(organizationId: OrganizationId, keyId: string, reason: string): void {
  const key = apiKeyStore.list(organizationId).find((candidate) => candidate.id === keyId);
  if (key && key.revokedAt === null) apiKeyStore.revoke(organizationId, keyId, "oathrion wrap", reason);
}

/**
 * Les règles par défaut d'un serveur : chaque écriture et chaque destruction attend une
 * approbation. Elles ne sont jamais réécrites : une écriture déjà couverte par une règle
 * `pol_wrap_<serveur>_…` — activée ou non — est laissée telle quelle ; une écriture nouvelle
 * reçoit une règle de plus. Un choix humain n'est jamais défait.
 *
 * Les DESTRUCTIONS aussi, depuis l'essai sur de vrais serveurs (§5.48). Elles sont bloquées par
 * l'absence de la portée `mcp:destructive` ; mais une personne qui l'accorde ne doit pas les
 * voir passer SANS approbation — c'était le cas, la règle ne couvrant que les écritures.
 */
export async function ensureServerPolicies(organizationId: OrganizationId, server: string, entries: readonly WrappedToolEntry[]): Promise<string[]> {
  const repositories = repositoriesFor(organizationId);
  const policyPrefix = `pol_wrap_${server}_`;
  const existing = (await repositories.policies.list()).filter((policy) => policy.id.startsWith(policyPrefix));
  const covered = new Set(
    existing.flatMap((policy) => (policy.condition && "actions" in policy.condition ? (policy.condition.actions ?? []) : [])),
  );
  const uncovered = entries
    .filter((entry) => (entry.toolClass === "write" || entry.toolClass === "destructive") && !covered.has(entry.verb))
    .map((entry) => entry.verb);
  const createdPolicies: string[] = [];
  let index = existing.length + 1;
  for (let start = 0; start < uncovered.length; start += VERBS_PER_POLICY) {
    const verbs = uncovered.slice(start, start + VERBS_PER_POLICY);
    const id = `${policyPrefix}${String(index)}`;
    index += 1;
    const parsed = policyCreateContract.parse({
      id,
      name: `${server}: every write waits for approval`,
      description:
        `Default rule of oathrion wrap: ${String(verbs.length)} write or destructive tool(s) of the ` +
        `"${server}" server wait for a person to approve. Destructive tools also stay blocked while ` +
        `the agent lacks the "mcp:destructive" permission.`,
      type: "REQUIRE_HUMAN_APPROVAL",
      condition: { kind: "targetMatches", targets: [`mcp://${server}/*`], actions: verbs },
      scope: "organization",
      appliesTo: "all agents",
      effect: "require_approval",
      status: "enabled",
      action: "APPROVAL_REQUIRED",
      risk: "medium",
      priority: 5,
    });
    await repositories.policies.create(toPolicy(parsed));
    createdPolicies.push(id);
  }
  return createdPolicies;
}

/**
 * La règle des questions du hook Claude Code : ce qu'il ne peut pas demander dans le terminal
 * (mode automatique) attend une personne dans Oathrion. Visible dans Policies, comme les autres.
 */
export const CLAUDE_HOOK_POLICY_ID = "pol_claude_code_hook";

export async function ensureClaudeHookPolicy(organizationId: OrganizationId, verbs: readonly string[]): Promise<void> {
  const repositories = repositoriesFor(organizationId);
  if ((await repositories.policies.list()).some((policy) => policy.id === CLAUDE_HOOK_POLICY_ID)) return;
  const parsed = policyCreateContract.parse({
    id: CLAUDE_HOOK_POLICY_ID,
    name: "Claude Code: its hook's questions wait for a person",
    description:
      "When Claude Code runs in a mode that asks no one (auto mode), what Oathrion's hook would ask in " +
      "the terminal — a push, a publish, replacing an untracked file — waits here for a person instead.",
    type: "REQUIRE_HUMAN_APPROVAL",
    condition: { kind: "targetMatches", targets: ["shell://*", "file://*"], actions: [...verbs] },
    scope: "organization",
    appliesTo: "all agents",
    effect: "require_approval",
    status: "enabled",
    action: "APPROVAL_REQUIRED",
    risk: "high",
    priority: 5,
  });
  await repositories.policies.create(toPolicy(parsed));
}

/**
 * « DÉCIDER UNE FOIS » : ne plus demander pour un outil d'ÉCRITURE de ce serveur.
 *
 * Le moteur retient la règle la plus restrictive (`shared/policy/engine.ts`) : une règle
 * « autoriser » ne l'emporte pas sur « demander ». Le verbe SORT donc de la règle « chaque
 * écriture attend une approbation » et ENTRE dans `pol_wrap_<serveur>_toujours`, une règle
 * « autorisé sans approbation » visible dans la console (Politiques), qui dit quand et d'où
 * l'accord est venu. Elle porte le même préfixe : `ensureServerPolicies` voit le verbe couvert
 * et ne le remet pas sous approbation au prochain lancement.
 *
 * Jamais pour une destruction : l'appelant (le pivot) le vérifie avec la classe de l'outil.
 */
export async function grantToolAlways(organizationId: OrganizationId, server: string, verb: string, origin: string): Promise<string> {
  const repositories = repositoriesFor(organizationId);
  const policies = (await repositories.policies.list()).filter((policy) => policy.id.startsWith(`pol_wrap_${server}_`));
  const actionsOf = (policy: (typeof policies)[number]) => (policy.condition && "actions" in policy.condition ? [...(policy.condition.actions ?? [])] : []);
  for (const policy of policies) {
    if (policy.id.endsWith("_toujours") || !actionsOf(policy).includes(verb)) continue;
    const remaining = actionsOf(policy).filter((action) => action !== verb);
    /* Une liste vide ne doit jamais devenir « toutes les actions » : la règle est désactivée. */
    await repositories.policies.update(policy.id, {
      condition: { ...(policy.condition as object), actions: remaining } as typeof policy.condition,
      ...(remaining.length === 0 ? { status: "disabled" as const } : {}),
    });
  }
  const id = `pol_wrap_${server}_toujours`;
  const existing = policies.find((policy) => policy.id === id);
  const verbs = [...new Set([...(existing ? actionsOf(existing) : []), verb])];
  const when = new Date().toISOString().slice(0, 16).replace("T", " at ");
  const description =
    `Writes of the "${server}" server that the person allowed without approval ("decide once"). ` +
    `Last grant: ${verb.split(".").at(-1) ?? verb}, on ${when} UTC, ${origin}. Removing a verb from here puts it back under approval at the next launch.`;
  if (existing) {
    await repositories.policies.update(id, { condition: { ...(existing.condition as object), actions: verbs } as typeof existing.condition, description, status: "enabled" });
  } else {
    const parsed = policyCreateContract.parse({
      id,
      name: `${server}: allowed without approval`,
      description,
      type: "ALLOW_TOOL",
      condition: { kind: "targetMatches", targets: [`mcp://${server}/*`], actions: verbs },
      scope: "organization",
      appliesTo: "all agents",
      /* Le contrat d'une règle ALLOW_TOOL : `action: "ALLOW"` décide ; `effect` ne connaît pas « allow » (cf. shared/seed/policies.ts). */
      effect: "warn",
      status: "enabled",
      action: "ALLOW",
      risk: "low",
      priority: 5,
    });
    await repositories.policies.create(toPolicy(parsed));
  }
  return id;
}

/**
 * L'espace, l'agent, sa clé et les règles, pour UN serveur (le mode d'avant le pivot unique).
 * Idempotent : relancé, il ne crée que ce qui manque, et remplace seulement la clé de l'agent.
 */
export async function bootstrapLocalWorkspace(input: {
  server: string;
  entries: readonly WrappedToolEntry[];
  agentKey: string;
  /**
   * La clé d'approbation du relais, quand la personne approuve DANS son client
   * (`--approbation client`). Absente, aucune clé d'approbation n'existe : il ne faut pas
   * élargir ce qu'un processus de la même machine pourrait lire sans raison.
   */
  approverKey?: string;
  baseUrl: string;
  /** Le dossier d'état (`~/.oathrion/<serveur>`). */
  stateDir: string;
}): Promise<LocalWorkspace> {
  const { organizationId, personCreated } = ensureLocalSpace();

  /* L'agent du serveur. Jamais `mcp:destructive`. */
  const agentId = `agt_wrap_${input.server}`;
  await ensureAgent(organizationId, agentId, `Agent ${input.server}`, `The agent that goes through oathrion wrap to reach the MCP server "${input.server}".`, "of the server");

  /* La clé : une seule vivante, liée à l'agent. L'ancienne est révoquée. */
  for (const key of apiKeyStore.list(organizationId)) {
    if (key.agentId === agentId && key.revokedAt === null) apiKeyStore.revoke(organizationId, key.id, "oathrion wrap", "relance");
  }
  apiKeyStore.create({
    /* L'heure seule ne suffit pas : deux lancements dans la même milliseconde (Node 24, en CI) donnaient le même identifiant. */
    id: `key_wrap_${input.server}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
    organizationId,
    name: `oathrion wrap · ${input.server}`,
    role: "operator",
    secretHash: hashKey(input.agentKey),
    prefix: displayPrefixOf(input.agentKey),
    source: "user",
    createdBy: "oathrion wrap",
    agentId,
  });

  /* La clé d'approbation du relais : une seule vivante par serveur, seulement sur demande. */
  const approverPrefix = `key_wrap_${input.server}_approbation_`;
  for (const key of apiKeyStore.list(organizationId)) {
    if (key.id.startsWith(approverPrefix) && key.revokedAt === null) apiKeyStore.revoke(organizationId, key.id, "oathrion wrap", "relance");
  }
  if (input.approverKey) {
    apiKeyStore.create({
      id: `${approverPrefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
      organizationId,
      name: APPROVER_NAME,
      role: "approver",
      secretHash: hashKey(input.approverKey),
      prefix: displayPrefixOf(input.approverKey),
      source: "user",
      createdBy: "oathrion wrap",
    });
  }

  const createdPolicies = await ensureServerPolicies(organizationId, input.server, input.entries);
  return { organizationId, agentId, personCreated, createdPolicies };
}
