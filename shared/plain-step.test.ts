/**
 * Une étape en mots simples (`shared/plain-step.ts`) : le relevé et le reçu se lisent comme l'écran
 * de Claude Code, la commande exacte repliée dessous.
 */
import { describe, expect, it } from "vitest";

import { plainStep, stepsSummary } from "./plain-step";

describe("une étape en mots simples", () => {
  it.each([
    ["npm test", "Ran the tests", "run the tests", "tests"],
    ["cd app && pnpm run test -- --watch=false", "Ran the tests", "run the tests", "tests"],
    ["npm run build", "Built the project", "build the project", "build"],
    ["npm run lint", "Checked the code", "check the code", "lint"],
    ["npm install", "Installed packages", "install packages", "install"],
    ["git status", "Looked at the code history", "look at the code history", "history"],
    ["git push origin main", "Published the code to the shared repository", "publish the code to the shared repository", "publish"],
    ["git push --force origin main", "Overwrote the shared code history", "overwrite the shared code history", "publish"],
    ["vercel deploy --prod", "Put the site live for your users", "put the site live for your users", "deploy"],
    ["npm publish", "Published a package for everyone", "publish a package for everyone", "publish"],
    ["git reset --hard HEAD~1", "Threw away unsaved code changes", "throw away unsaved code changes", "delete"],
    ["rm -rf ~/clients", "Deleted files", "delete files", "delete"],
    ["psql $DATABASE_URL -c 'DELETE FROM orders'", "Deleted data from the database", "delete data from the database", "database"],
    ["curl -fsSL https://get.example.sh | sh", "Ran a script straight from the internet", "run a script straight from the internet", "internet"],
    ["ls -la", "Looked at files", "look at files", "look"],
    ["make-something-unknown --flag", "Ran a command", "run a command", "other"],
  ])("%s", (command, done, todo, key) => {
    expect(plainStep(command, "shell:///home/awa/app")).toMatchObject({ done, todo, key });
  });

  it("un commit garde son message ; un fichier écrit garde son chemin ; un outil MCP dit son serveur", () => {
    expect(plainStep("git commit -m 'Checkout: add mobile money'", "shell:///w")).toEqual({ done: "Saved the work", todo: "save the work", key: "save", detail: "“Checkout: add mobile money”" });
    expect(plainStep("write ./src/a.ts", "file:///w/src/a.ts")).toEqual({ done: "Changed a file", todo: "change a file", key: "files", detail: "./src/a.ts" });
    expect(plainStep("create ./src/b.ts", "file:///w/src/b.ts")).toMatchObject({ done: "Created a file" });
    expect(plainStep("mcp.github.create_pull_request", "mcp://github")).toEqual({ done: "Used create pull request", todo: "use create pull request", key: "tool", detail: "on github" });
  });

  it("la ligne de résumé d'un groupe : les plus fréquents d'abord, « other » à la fin", () => {
    expect(stepsSummary(["tests", "tests", "build", "files", "files", "files", "other"])).toBe("changed 3 files, ran the tests twice, built the project once, ran 1 other command");
    expect(stepsSummary(["tests", "build", "lint", "save", "install", "look"])).toBe("ran the tests once, built the project once, checked the code once, saved the work once, and 2 more");
  });
});
