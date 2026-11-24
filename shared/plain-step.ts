/**
 * UNE ÉTAPE EN MOTS SIMPLES, pour le relevé et le reçu qui se lisent comme l'écran de Claude Code
 * (23 novembre, vidéo du fondateur : « il faut faire les reçus signés de cette manière ») : une
 * ligne qu'on comprend sans être développeur, la commande exacte repliée dessous.
 *
 *   npm test            → done « Ran the tests »,  todo « run the tests »,  key « tests »
 *   git push origin main → done « Published the code to the shared repository », todo « publish… »
 *   write ~/app/a.ts     → done « Changed a file », detail « ./a.ts »
 *
 * `key` regroupe les étapes d'un même genre, pour la ligne de résumé d'une semaine (« ran the tests
 * 5 times, changed 8 files »). Sans dépendance : le serveur et les pages l'importent.
 */

export interface PlainStep {
  /** Ce qui s'est fait, au passé : « Ran the tests ». */
  done: string;
  /** Ce qui a été demandé ou arrêté, à l'infinitif : « run the tests ». */
  todo: string;
  /** Le genre de l'étape, pour compter : « tests », « build », « files »… */
  key: StepKey;
  /** Un complément court et lisible : le fichier, le message du commit ; ou null. */
  detail: string | null;
}

export type StepKey = "tests" | "build" | "lint" | "save" | "publish" | "deploy" | "install" | "look" | "history" | "files" | "delete" | "internet" | "database" | "remote" | "outside" | "tool" | "other";

type Rule = [RegExp, StepKey, string, string];

/* Le premier qui convient, dans l'ordre : du plus précis au plus général. */
const COMMANDS: Rule[] = [
  [/^git\s+push\b.*\s(--force\b|-f\b)/, "publish", "Overwrote the shared code history", "overwrite the shared code history"],
  [/^(vercel\b.*--prod|netlify\s+deploy\b.*--prod|fly(ctl)?\s+deploy\b|git\s+push\s+heroku\b|(npm|pnpm|yarn)\s+run\s+deploy\b)/, "deploy", "Put the site live for your users", "put the site live for your users"],
  [/^git\s+push\b/, "publish", "Published the code to the shared repository", "publish the code to the shared repository"],
  [/^((npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|gem\s+push|twine\s+upload)\b/, "publish", "Published a package for everyone", "publish a package for everyone"],
  [/^gh\s+pr\s+merge\b/, "publish", "Merged a pull request on GitHub", "merge a pull request on GitHub"],
  [/^gh\s+/, "publish", "Acted on GitHub", "act on GitHub"],
  [/^git\s+commit\b/, "save", "Saved the work", "save the work"],
  [/^git\s+(reset\s+--hard|clean\b|checkout\s+--\s|restore\b)/, "delete", "Threw away unsaved code changes", "throw away unsaved code changes"],
  [/^git\s+(status|diff|log|show|branch|fetch|pull|stash|add|switch|checkout)\b/, "history", "Looked at the code history", "look at the code history"],
  [/^((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(vitest|jest)\b|vitest\b|jest\b|pytest\b|go\s+test\b|cargo\s+test\b|python3?\s+-m\s+pytest\b)/, "tests", "Ran the tests", "run the tests"],
  [/^((npm|pnpm|yarn|bun)\s+run\s+build\b|(npm|pnpm|yarn)\s+build\b|cargo\s+build\b|go\s+build\b|make(\s|$)|tsc(\s|$)|npx\s+tsc\b)/, "build", "Built the project", "build the project"],
  [/^((npm|pnpm|yarn|bun)\s+run\s+(lint|typecheck|check|format)\b|eslint\b|npx\s+eslint\b|prettier\b|ruff\b)/, "lint", "Checked the code", "check the code"],
  [/^((npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|pip3?\s+install\b|uv\s+(add|pip)\b|cargo\s+add\b|brew\s+install\b|apt(-get)?\s+install\b)/, "install", "Installed packages", "install packages"],
  [/^(psql|mysql|sqlite3|mongosh|redis-cli)\b.*\b(drop|delete|truncate|flushall|flushdb)\b/i, "database", "Deleted data from the database", "delete data from the database"],
  [/^(psql|mysql|sqlite3|mongosh|redis-cli|prisma)\b/, "database", "Used the database", "use the database"],
  [/^((terraform|tofu|pulumi)\s+(destroy|down)|kubectl\s+delete|railway\s+(delete|down)|supabase\s+db\s+reset)\b/, "delete", "Deleted servers and their data", "delete servers and their data"],
  [/^(sudo\s+)?(rm|rmdir|shred|unlink)\b|^find\b.*\s-delete\b|^rsync\b.*\s--delete\b/, "delete", "Deleted files", "delete files"],
  [/^(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/, "internet", "Ran a script straight from the internet", "run a script straight from the internet"],
  [/^(curl|wget|http)\b/, "internet", "Reached the internet", "reach the internet"],
  [/^(ssh|scp|sftp)\b/, "remote", "Connected to another computer", "connect to another computer"],
  [/^(cat|less|head|tail|ls|grep|rg|find|wc|stat|tree|du|file|pwd|echo|which)\b/, "look", "Looked at files", "look at files"],
  [/^(mkdir|touch|cp|mv)\b/, "files", "Organised files", "organise files"],
  [/^(sudo\s+)?(chmod|chown)\b/, "files", "Changed who can open files", "change who can open files"],
  [/^(docker|podman|docker-compose|kubectl)\b/, "other", "Managed containers", "manage containers"],
  [/^(node|python3?|deno|bun|tsx|npx)\b/, "other", "Ran a script", "run a script"],
];

/** Les morceaux d'une commande (`cd app && npm test`) : on garde le plus parlant, pas le `cd`. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .filter((part) => part !== "" && !/^cd\s/.test(part));
}

/** Une étape : l'action enregistrée (la commande, « write <chemin> », ou `mcp.<serveur>.<outil>`) et sa cible. */
export function plainStep(action: string, target = ""): PlainStep {
  const tool = /^mcp\.([^.]+)\.(.+)$/.exec(action);
  if (tool) {
    const words = tool[2]!.replace(/[_-]+/g, " ").trim();
    return { done: `Used ${words}`, todo: `use ${words}`, key: "tool", detail: `on ${tool[1]!}` };
  }
  if (action.startsWith("read untrusted content: ")) {
    return { done: "Read content from outside", todo: "read content from outside", key: "outside", detail: action.slice("read untrusted content: ".length) };
  }
  const file = /^(write|create|replace|edit) (.+)$/.exec(action);
  if (file && !target.startsWith("shell://")) {
    const created = file[1] === "create";
    return { done: created ? "Created a file" : "Changed a file", todo: created ? "create a file" : "change a file", key: "files", detail: file[2]! };
  }
  const parts = segments(action);
  for (const [pattern, key, done, todo] of COMMANDS) {
    const hit = parts.find((part) => pattern.test(part));
    if (!hit) continue;
    const message = key === "save" ? /-m\s+(['"])(.+?)\1/.exec(hit)?.[2] ?? null : null;
    return { done, todo, key, detail: message ? `“${message}”` : null };
  }
  return { done: "Ran a command", todo: "run a command", key: "other", detail: null };
}

/* Comment se dit un groupe d'étapes du même genre, dans la ligne de résumé. */
const COUNTED: Record<StepKey, (n: number) => string> = {
  tests: (n) => `ran the tests ${times(n)}`,
  build: (n) => `built the project ${times(n)}`,
  lint: (n) => `checked the code ${times(n)}`,
  save: (n) => `saved the work ${times(n)}`,
  publish: (n) => `published ${times(n)}`,
  deploy: (n) => `put the site live ${times(n)}`,
  install: (n) => `installed packages ${times(n)}`,
  look: (n) => `looked at files ${times(n)}`,
  history: (n) => `looked at the code history ${times(n)}`,
  files: (n) => `changed ${String(n)} file${n > 1 ? "s" : ""}`,
  delete: (n) => `deleted ${n > 1 ? `${String(n)} times` : "once"}`,
  internet: (n) => `reached the internet ${times(n)}`,
  database: (n) => `used the database ${times(n)}`,
  remote: (n) => `connected to another computer ${times(n)}`,
  outside: (n) => `read content from outside ${times(n)}`,
  tool: (n) => `used a tool ${times(n)}`,
  other: (n) => `ran ${String(n)} other command${n > 1 ? "s" : ""}`,
};

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${String(n)} times`;
}

/** La ligne de résumé d'un groupe d'étapes, en minuscules : les genres les plus fréquents d'abord, « other » à la fin. */
export function stepsSummary(keys: readonly StepKey[], max = 4): string {
  const counts = new Map<StepKey, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const ordered = [...counts].sort((a, b) => (a[0] === "other" ? 1 : b[0] === "other" ? -1 : b[1] - a[1]));
  const shown = ordered.slice(0, max).map(([key, n]) => COUNTED[key](n));
  const rest = ordered.slice(max).reduce((sum, [, n]) => sum + n, 0);
  return [...shown, ...(rest > 0 ? [`and ${String(rest)} more`] : [])].join(", ");
}
