/**
 * PARLER COMME UN AMI (`notes/CONCEPTION-PARLER-COMME-UN-AMI.md`, lot A, 23 novembre : « les
 * notifications devraient être aussi simples qu'un message WhatsApp d'un pote »).
 *
 * L'agent parle, à la première personne, avec son nom et sa mascotte : une question qu'on
 * comprend sans réfléchir (« Can I publish your code to the shared repository? »), ce que ça
 * change en une demi-phrase (« Your team will see it. »), et le code exact à part, en petit, pour
 * qui le veut. Jamais un nom de règle ni un chemin dans la question. Quand c'est Oathrion qui a
 * agi (il a arrêté quelque chose, il a mis un agent en pause), c'est Warden, sa mascotte, qui
 * parle.
 *
 * Pas d'emoji ni de mot d'alerte : le filtre anti-spam de Chrome sur Android s'en méfie (essai
 * réel du 23 novembre). La chaleur vient des mots.
 *
 * Sans dépendance : le serveur, la console et les tests l'importent.
 */

export interface FriendlyAsk {
  /** La question de l'agent : « Can I publish your code to the shared repository? ». */
  ask: string;
  /** Ce que ça change, en une demi-phrase, ou null. */
  why: string | null;
  /** Le code exact : la commande, le chemin, ou ce que l'outil recevra. Null s'il n'y en a pas. */
  code: string | null;
  /** Où : le serveur (« github »), ou null. */
  where: string | null;
}

export interface FriendlyInput {
  /** `mcp.<serveur>.<outil>`, ou `mcp.claude-code.shell` / `.file_write` pour le hook. */
  action: string;
  target?: string | null;
  command?: string | null;
  /** La raison donnée par le hook (« Oathrion: a push publishes your commits. Allow it? »). */
  reason?: string | null;
  /** La session a lu du contenu non fiable : la source. */
  untrusted?: string | null;
  /** Ce que l'outil recevra (les arguments), déjà raccourci. */
  content?: string | null;
}

/** Le nom d'Oathrion quand il parle lui-même : sa mascotte. */
export const WARDEN = "Warden";

/** Les boutons d'une demande : ils répondent à la question. */
export const FRIENDLY_BUTTONS = { approve: "Yes, go ahead", reject: "No", "allow-hour": "Yes, for 1 hour" } as const;

type Rule = { test: (segment: string, whole: string, input: FriendlyInput) => boolean; ask: string; why: string | null };

const has = (pattern: RegExp) => (segment: string) => pattern.test(segment);

/*
 * Les commandes, de la plus grave à la plus banale : le premier morceau qui correspond donne la
 * phrase. Une commande en plusieurs morceaux (`cd app && git push`) est lue morceau par morceau.
 */
const SHELL: Rule[] = [
  { test: (_s, whole, input) => /secret/i.test(input.reason ?? "") && /\b(curl|wget|scp|rsync|nc|http)\b/.test(whole), ask: "Can I send a file with passwords in it out of this computer?", why: "Someone else could read your passwords." },
  { test: has(/^git\s+push\b.*\s(--force\b|-f\b|--force-with-lease\b)/), ask: "Can I overwrite the shared code history?", why: "Other people's work could be erased." },
  { test: has(/^(vercel\b.*--prod|netlify\s+deploy\b.*--prod|fly(ctl)?\s+deploy\b|git\s+push\s+heroku\b|(npm|pnpm|yarn)\s+run\s+deploy\b)/), ask: "Can I put this live for your users?", why: "They will see it right away." },
  { test: has(/^git\s+push\b/), ask: "Can I publish your code to the shared repository?", why: "Your team will see it." },
  { test: has(/^((npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|gem\s+push|twine\s+upload|poetry\s+publish)\b/), ask: "Can I publish your package for everyone?", why: "Once it's out, it's public." },
  { test: has(/^gh\s+repo\s+delete\b/), ask: "Can I delete a repository on GitHub?", why: "It can't be undone." },
  { test: has(/^gh\s+pr\s+merge\b/), ask: "Can I merge a pull request on GitHub?", why: "It goes into the shared code." },
  { test: has(/^gh\s+release\s+(create|upload)\b/), ask: "Can I publish a release on GitHub?", why: "Everyone will see it." },
  { test: has(/^gh\s+/), ask: "Can I do something on GitHub in your name?", why: "Everyone on the project will see it." },
  { test: has(/^(sudo\s+)?rm\b.*\.git(\/|\s|$)/), ask: "Can I delete your project's history?", why: "It can't be brought back." },
  { test: has(/^git\s+(reset\s+--hard|clean\b|checkout\s+--\s|restore\b)/), ask: "Can I throw away your unsaved code changes?", why: "They can't be brought back." },
  { test: has(/^git\s+branch\s+(-D|--delete\s+--force)\b/), ask: "Can I delete a branch of your code?", why: "Its work may be lost for good." },
  { test: has(/^((terraform|tofu|pulumi)\s+(destroy|down|stack\s+rm)|kubectl\s+delete|railway\s+(delete|down)|(fly|flyctl|heroku)\s+(apps\s+)?destroy|supabase\s+db\s+reset)\b/), ask: "Can I delete servers and the data on them?", why: "It can't be undone." },
  { test: has(/^(terraform|tofu)\s+apply\b.*-auto-approve/), ask: "Can I change your real servers without showing you the plan first?", why: "Something could be replaced or deleted." },
  { test: (segment) => /^(psql|mysql|sqlite3|mongosh|redis-cli)\b/.test(segment) && /\b(drop|delete|truncate|flushall|flushdb|dropdatabase)\b/i.test(segment), ask: "Can I delete data from your database?", why: "It can't be undone." },
  { test: has(/^(prisma\s+migrate\s+reset|npx\s+prisma\s+migrate\s+reset|rails\s+db:(drop|reset)|bin\/rails\s+db:(drop|reset))\b/), ask: "Can I wipe your database and start it over?", why: "Its data will be gone." },
  { test: has(/^(docker|podman)\s+(system|volume|image|container)\s+prune\b|^docker(-|\s)compose\s+down\b.*\s(-v|--volumes)\b|^docker\s+volume\s+rm\b/), ask: "Can I delete Docker data?", why: "Other projects may use it too." },
  { test: has(/^(sudo\s+)?(rm|rmdir|shred|unlink)\b|^find\b.*\s-delete\b|^rsync\b.*\s--delete\b/), ask: "Can I delete some files?", why: "They won't go to the trash." },
  { test: has(/^(sudo\s+)?(chmod|chown)\b/), ask: "Can I change who can open your files?", why: null },
  { test: (segment) => /^(curl|wget)\b/.test(segment) && /\s(-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))\b/.test(segment), ask: "Can I send something to a website?", why: null },
  { test: has(/^(ssh|scp|sftp)\b/), ask: "Can I connect to another computer?", why: null },
  { test: has(/^(sudo)\b/), ask: "Can I run a command as the computer's administrator?", why: "It can change anything on this computer." },
];

/** Les morceaux d'une commande : `cd app && FOO=1 npm publish` → « cd app », « npm publish ». */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, "").replace(/^(command|exec|time|nohup)\s+/, ""))
    .filter(Boolean);
}

/** La raison du hook, sans « Oathrion: », sans « Allow it? », en une phrase. */
function plainReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const text = reason
    .replace(/^Oathrion( refuses)?:?\s*/i, "")
    .replace(/\s*Allow it\?\s*$/i, "")
    .replace(/^rule [a-z0-9-]+:?\s*/i, "")
    .trim();
  if (!text) return null;
  const first = /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  const sentence = first.charAt(0).toUpperCase() + first.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** « a file », « an issue », « files », « something ». */
function aThing(words: string): string {
  if (!words) return "something";
  if (/s$/.test(words) && !/ss$/.test(words)) return words;
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}

/* Le verbe d'un outil MCP (`create_pull_request`, `write_file`) : ce qu'on demande, et ce que ça change. */
const TOOL_VERBS: [RegExp, (thing: string) => { ask: string; why: string | null }][] = [
  [/^(pay|charge|refund|transfer|payout|purchase|buy)$/, () => ({ ask: "Can I move money?", why: "Money will change hands." })],
  [/^(delete|remove|drop|destroy|purge|erase|archive)$/, (thing) => ({ ask: `Can I delete ${aThing(thing)}?`, why: "It can't be undone." })],
  [/^(send|post|reply|comment|publish|share|invite|email|message|notify)$/, (thing) => ({ ask: thing ? `Can I send ${aThing(thing)}?` : "Can I send this?", why: "Other people will see it." })],
  [/^(deploy|release)$/, () => ({ ask: "Can I put this live?", why: "People will see it right away." })],
  [/^(merge)$/, (thing) => ({ ask: `Can I merge ${aThing(thing)}?`, why: null })],
  [/^(write|edit|update|replace|append|patch|set|modify|change|rename)$/, (thing) => ({ ask: `Can I change ${aThing(thing)}?`, why: null })],
  [/^(create|add|insert|new|make|open)$/, (thing) => ({ ask: `Can I create ${aThing(thing)}?`, why: null })],
  [/^(move)$/, (thing) => ({ ask: `Can I move ${aThing(thing)}?`, why: null })],
  [/^(copy|duplicate)$/, (thing) => ({ ask: `Can I copy ${aThing(thing)}?`, why: null })],
  [/^(run|execute|exec|eval)$/, () => ({ ask: "Can I run something?", why: null })],
];

/** Ce que l'agent demande, dit comme un ami. */
export function friendlyAsk(input: FriendlyInput): FriendlyAsk {
  const command = input.command?.trim() || null;
  const reason = plainReason(input.reason);
  const handoff = /^mcp\.claude-code\.(.+)$/.exec(input.action);
  const tainted = Boolean(input.untrusted?.trim());

  /* Une écriture de fichier par Claude Code : le chemin est le code. */
  if (handoff && handoff[1] === "file_write") {
    const path = (input.target ?? "").replace(/^file:\/\//, "") || null;
    const secret = path !== null && /(^|\/)(\.env[^/]*|[^/]*(secret|credential|\.pem|\.key|id_rsa)[^/]*)$/i.test(path);
    return {
      ask: tainted ? "I just read something from outside. Can I change a file now?" : secret ? "Can I change a file that holds secrets?" : "Can I change a file?",
      why: tainted ? "What I read could be trying to trick me." : (reason ?? null),
      code: path,
      where: null,
    };
  }

  if (handoff || command) {
    const whole = command ?? "";
    const parts = segments(whole);
    const found = tainted ? null : SHELL.find((rule) => parts.some((segment) => rule.test(segment, whole, input)));
    if (tainted) return { ask: "I just read something from outside. Can I run this now?", why: "What I read could be trying to trick me.", code: command, where: null };
    if (found) return { ask: found.ask, why: found.why ?? reason, code: command, where: null };
    return { ask: "Can I run a command?", why: reason, code: command, where: null };
  }

  /* Un outil d'un serveur MCP : le verbe de l'outil, et ce sur quoi il porte. */
  const tool = /^mcp\.([^.]+)\.(.+)$/.exec(input.action);
  if (tool) {
    const words = tool[2]!.replace(/[_-]+/g, " ").trim().toLowerCase().split(/\s+/);
    const verb = words[0] ?? "";
    const thing = words.slice(1).join(" ");
    const said = TOOL_VERBS.find(([pattern]) => pattern.test(verb))?.[1](thing) ?? { ask: `Can I use ${words.join(" ")}?`, why: null };
    return { ask: tainted ? `I just read something from outside. ${said.ask}` : said.ask, why: tainted ? "What I read could be trying to trick me." : (said.why ?? reason), code: input.content?.trim() || null, where: tool[1]! };
  }

  return { ask: "Can I go ahead?", why: reason, code: input.content?.trim() || command, where: null };
}

/** Qui écrit : le nom que la personne a donné à l'agent (sa mascotte), sinon son nom. */
export function friendlySender(agentName: string, mascotName?: string | null): string {
  return mascotName?.trim() || agentName;
}

/** Plusieurs questions à la fois. */
export function friendlyGrouped(count: number): string {
  return `I have ${String(count)} questions for you.`;
}

/** Après la réponse : l'agent accuse réception, sans jargon. */
export function friendlyDone(choice: string): string {
  return choice === "reject" ? "OK, I won't do it." : choice === "allow-hour" ? "Thanks. I'll go ahead, and won't ask again for an hour." : "Thanks, I'm going ahead.";
}

/* ------------------------------------------------------------- Warden, quand Oathrion a agi */

/** Un agent lancé sans Oathrion, mis en pause (ou qui tourne sans protection). */
export function wardenPaused(name: string, paused: boolean): { title: string; body: string } {
  return paused
    ? { title: WARDEN, body: `${name} started without me, so I paused it. Nothing is lost. Protect it, or let it run on its own?` }
    : { title: WARDEN, body: `${name} is running without me: I can't stop it if it goes too far. Stop it, or let it run?` };
}

/** Quelque chose a lu un faux secret posé par Oathrion. */
export function wardenDecoy(what: string): { title: string; body: string } {
  return { title: WARDEN, body: `Something just read a fake password I planted (${what}). No honest task does that. Have a look?` };
}

/** Un programme qu'Oathrion n'a jamais vu. */
export function wardenUnknownProgram(name: string, here: boolean): { title: string; body: string } {
  return {
    title: WARDEN,
    body: `Did you just start ${name}? I've never seen it. Tell me it's yours and it can work${here ? "" : " (in Oathrion's console)"}.`,
  };
}
