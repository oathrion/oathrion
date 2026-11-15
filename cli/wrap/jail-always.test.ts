/**
 * `oathrion jail --always` (`jail-always.ts`) : les lanceurs, le bloc du PATH, et `--undo` qui
 * rend les fichiers du shell exactement comme ils étaient.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { jailAlwaysInstaller, runJailAlways, withBlock } from "./jail-always";

describe("oathrion jail --always", () => {
  it("un lanceur par agent installé, le PATH en tête ; --undo rend tout comme avant", () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-always-"));
    const bin = join(home, "outils");
    mkdirSync(bin);
    writeFileSync(join(bin, "cursor-agent"), '#!/bin/sh\necho "vrai agent $*"\n', { mode: 0o755 });
    const bashrc = "alias ll='ls -l'\nexport EDITOR=vim\n";
    writeFileSync(join(home, ".bashrc"), bashrc);
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), env: { PATH: `${bin}:/usr/bin:/bin` }, home, script: __filename };

    expect(runJailAlways([], io)).toBe(0);
    const shim = join(home, ".oathrion", "bin", "cursor-agent");
    expect(readFileSync(shim, "utf8")).toMatch(/jail -- "\$real" "\$@"/);
    expect(existsSync(join(home, ".oathrion", "bin", "claude"))).toBe(false);
    expect(lines.join("\n")).toMatch(/claude: not installed here/);
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain('export PATH="$HOME/.oathrion/bin:$PATH"');
    expect(readFileSync(join(home, ".bashrc.oathrion-backup"), "utf8")).toBe(bashrc);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);

    /* Déjà dans la prison : le lanceur passe au vrai programme, sans prison dans la prison. */
    expect(execFileSync(shim, ["--version"], { env: { PATH: "/usr/bin:/bin", OATHRION_JAILED: "1" }, encoding: "utf8" })).toBe("vrai agent --version\n");

    /* Deux fois : un seul bloc. */
    runJailAlways([], io);
    expect(readFileSync(join(home, ".bashrc"), "utf8").split(">>> oathrion jail >>>").length).toBe(2);

    expect(runJailAlways(["--undo"], io)).toBe(0);
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(bashrc);
    expect(existsSync(shim)).toBe(false);
  });

  it("un agent mis à jour change de chemin : le lanceur trouve le nouveau dans le PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-always-"));
    const v1 = join(home, "versions", "1");
    const v2 = join(home, "versions", "2");
    for (const [dir, label] of [[v1, "v1"], [v2, "v2"]] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agy"), `#!/bin/sh\necho "${label} $*"\n`, { mode: 0o755 });
    }
    const installer = jailAlwaysInstaller({ home, script: __filename, env: { PATH: `${v1}:/usr/bin:/bin` }, agents: ["agy"] });
    expect(installer.installed()).toBe(false);
    installer.install();
    expect(installer.installed()).toBe(true);
    const shim = join(home, ".oathrion", "bin", "agy");
    const shimDir = join(home, ".oathrion", "bin");
    /* La version 1 a disparu, le PATH mène à la 2 ; et le dossier des lanceurs n'est jamais pris pour l'agent. */
    expect(execFileSync(shim, ["x"], { env: { PATH: `${shimDir}:${v2}:/usr/bin:/bin`, OATHRION_JAILED: "1" }, encoding: "utf8" })).toBe("v2 x\n");
    installer.remove();
    expect(installer.installed()).toBe(false);
  });

  it("un lanceur de l'ancien format (chemin de version fixe) n'est pas à jour : il est refait", () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-always-"));
    const bin = join(home, "outils");
    mkdirSync(bin);
    writeFileSync(join(bin, "agy"), "#!/bin/sh\n", { mode: 0o755 });
    const installer = jailAlwaysInstaller({ home, script: __filename, env: { PATH: `${bin}:/usr/bin:/bin` }, agents: ["agy"] });
    installer.install();
    writeFileSync(join(home, ".oathrion", "bin", "agy"), `#!/bin/sh\nexec node oathrion.mjs jail -- '${bin}/agy' "$@"\n`);
    expect(installer.installed()).toBe(false);
    installer.install();
    expect(installer.installed()).toBe(true);
  });

  it("aucun agent installé : rien à enfermer, rien à demander", () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-always-"));
    expect(jailAlwaysInstaller({ home, script: __filename, env: { PATH: "/nulle/part" } }).installed()).toBe(true);
  });

  it("le bloc se retire sans toucher au reste, même au milieu du fichier", () => {
    const text = "avant\n";
    const added = withBlock(text, true);
    expect(withBlock(`${added}après\n`, false)).toBe("avant\naprès\n");
  });
});
