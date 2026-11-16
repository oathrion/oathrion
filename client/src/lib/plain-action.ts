/**
 * UNE ACTION EN MOTS (16 novembre, retour des premiers testeurs : « trop de lignes de commande
 * et de code, on ne comprend pas au premier regard »). Ce qu'un agent a fait, dit d'abord en
 * mots ; le code exact (la commande, le chemin) vient ensuite, en petit, pour qui le veut.
 *
 *   mcp.fichiers.write_file        → « Write file », « on the fichiers server »
 *   rm -rf build  (shell://~/app)  → « Delete files », « rm -rf build · in ~/app »
 *   write /home/a/notes.md         → « Change a file », « /home/a/notes.md »
 */
export interface PlainAction {
  /** Ce qui a été fait, en mots. */
  title: string;
  /** Le code exact, s'il y en a un ; sinon le lieu, en mots. */
  detail: string | null;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/* Le premier mot d'une commande, en mots ; dans l'ordre : le premier qui convient. */
const COMMANDS: [RegExp, string][] = [
  [/^(sudo\s+)?(rm|rmdir|shred|unlink)\b/, "Delete files"],
  [/^(sudo\s+)?find\b.*\s-delete\b/, "Delete files"],
  [/^git\s+push\b/, "Send code to a shared repository"],
  [/^git\s+(reset|clean|checkout|restore)\b/, "Undo changes in the code"],
  [/^git\b/, "Work with the code history"],
  [/^(npm|npx|pnpm|yarn|bun|pip|pip3|uv|cargo|gem|brew|apt|apt-get)\b/, "Install or run a package"],
  [/^(curl|wget)\b/, "Reach the internet"],
  [/^(ssh|scp)\b/, "Connect to another computer"],
  [/^rsync\b/, "Copy files"],
  [/^(cp)\b/, "Copy files"],
  [/^(mv)\b/, "Move or rename files"],
  [/^(docker|podman|docker-compose|kubectl)\b/, "Manage containers"],
  [/^(chmod|chown)\b/, "Change who can use files"],
  [/^(cat|less|head|tail|ls|grep|rg|find|wc|stat)\b/, "Look at files"],
  [/^(mkdir|touch)\b/, "Create files"],
  [/^(psql|mysql|sqlite3|mongosh|redis-cli)\b/, "Use a database"],
];

export function plainAction(action: string, target = ""): PlainAction {
  const tool = /^mcp\.([^.]+)\.(.+)$/.exec(action);
  if (tool) return { title: capital(tool[2]!.replace(/_/g, " ")), detail: `on the ${tool[1]!} server` };

  const file = /^(write|create|replace|edit) (.+)$/.exec(action);
  if (file && !target.startsWith("shell://")) {
    return { title: file[1] === "create" ? "Create a file" : "Change a file", detail: file[2]! };
  }
  if (action.startsWith("read untrusted content: ")) return { title: "Read content from outside", detail: action.slice("read untrusted content: ".length) };

  if (target.startsWith("shell://")) {
    const command = action.trim();
    const title = COMMANDS.find(([pattern]) => pattern.test(command))?.[1] ?? "Run a command";
    return { title, detail: `${command} · in ${target.slice("shell://".length)}` };
  }
  if (target.startsWith("file://")) return { title: capital(action), detail: target.slice("file://".length) };
  return { title: capital(action.replace(/_/g, " ")), detail: target && !target.startsWith("mcp://") ? target : null };
}

/*
 * Le détail d'une ligne d'activité (« rule rm-git-history · person: approved · exit code 1 »),
 * en mots. Le mode de Claude Code n'apprend rien à la personne : il est retiré.
 */
export function plainDetail(detail: string | null): string | null {
  if (!detail) return null;
  const words = detail
    .split(" · ")
    .flatMap((part) => {
      if (part.startsWith("mode ")) return [];
      const rule = /^rule (.+)$/.exec(part);
      if (rule) return [`rule: ${rule[1]!.replace(/-/g, " ")}`];
      const person = /^person: (.+)$/.exec(part);
      if (person) return [person[1] === "approved" ? "you approved" : person[1] === "rejected" ? "you refused" : person[1] === "pending" ? "waiting for you" : `you: ${person[1]!}`];
      const exit = /^exit code (\d+)$/.exec(part);
      if (exit) return [exit[1] === "0" ? "it worked" : "it failed"];
      return [part];
    })
    .join(" · ");
  return words || null;
}
