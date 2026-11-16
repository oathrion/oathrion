import { describe, expect, it } from "vitest";

import { plainAction, plainDetail } from "./plain-action";

describe("une action en mots, le code ensuite", () => {
  it("un outil d'un serveur", () => {
    expect(plainAction("mcp.fichiers.write_file", "mcp://fichiers")).toEqual({ title: "Write file", detail: "on the fichiers server" });
  });

  it("une commande de Claude Code : ce qu'elle fait, puis la commande et le dossier", () => {
    expect(plainAction("rm -rf build", "shell:///home/a/app")).toEqual({ title: "Delete files", detail: "rm -rf build · in /home/a/app" });
    expect(plainAction("git push --force origin main", "shell:///home/a/app").title).toBe("Send code to a shared repository");
    expect(plainAction("find . -name '*.log' -delete", "shell:///tmp").title).toBe("Delete files");
    expect(plainAction("make deploy", "shell:///tmp").title).toBe("Run a command");
  });

  it("un fichier écrit par Claude Code", () => {
    expect(plainAction("create /home/a/notes.md", "file:///home/a/notes.md")).toEqual({ title: "Create a file", detail: "/home/a/notes.md" });
    expect(plainAction("write /home/a/notes.md", "file:///home/a/notes.md").title).toBe("Change a file");
  });

  it("le détail : la règle et la personne en mots, sans le mode de Claude Code", () => {
    expect(plainDetail("rule rm-git-history · person: approved · mode acceptEdits · exit code 0")).toBe("rule: rm git history · you approved · it worked");
    expect(plainDetail("mode plan")).toBeNull();
    expect(plainDetail(null)).toBeNull();
  });
});
