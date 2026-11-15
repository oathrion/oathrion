/**
 * LES PROGRAMMES QUE LE PIVOT CONNAÎT (demandé par l'utilisateur le 9 novembre : un programme
 * encore inconnu sur la machine est bloqué jusqu'à confirmation de son identité).
 *
 * Le relais dit quel programme l'a lancé (`cli/wrap/client-identity.ts` : l'exécutable réel, le
 * script d'un interpréteur, l'empreinte SHA-256). Le pivot n'émet de clé qu'à un programme
 * qu'une personne a confirmé dans la console : un programme jamais vu reste « en attente »,
 * sans clé, donc sans aucune action possible, lectures comprises ; un programme bloqué n'en aura
 * jamais. Ce n'est pas le nom qu'il se donne (« Claude Code ») qui compte : un autre programme
 * qui prend ce nom est un autre programme.
 *
 * Un programme connu dont l'exécutable a CHANGÉ au même endroit (une mise à jour de Claude Code)
 * reste connu : l'ancienne empreinte est gardée, et le changement se voit dans la console.
 * Sans identité (un système où le relais ne peut pas la lire), le pivot retombe sur le nom
 * déclaré, ce que la documentation dit.
 *
 * Un fichier (`programs.json`, 0600) dans le dossier du pivot : quelques entrées, écrites quand
 * une décision change.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProgramIdentity {
  exe: string;
  script: string | null;
  sha256: string;
  platform: string;
}

export type ProgramStatus = "pending" | "trusted" | "blocked";

export interface KnownProgram {
  id: string;
  /** Le nom que le client s'est donné (`clientInfo`), tel quel : une déclaration, pas une preuve. */
  name: string;
  identity: ProgramIdentity | null;
  status: ProgramStatus;
  firstSeen: string;
  lastSeen: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Les empreintes précédentes d'un exécutable mis à jour au même endroit. */
  previousSha256: string[];
}

export function programId(name: string, identity: ProgramIdentity | null): string {
  const basis = identity ? `${identity.platform}\n${identity.exe}\n${identity.script ?? ""}` : `declared\n${name}`;
  return `prg_${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

/** Une identité lisible, sans rien deviner : l'exécutable, et le script s'il y en a un. */
export function describeIdentity(program: Pick<KnownProgram, "name" | "identity">): string {
  if (!program.identity) return `a program that says it is "${program.name}" (its executable could not be read on this system)`;
  const where = program.identity.script ? `${program.identity.exe} ${program.identity.script}` : program.identity.exe;
  return `${where} — it says it is "${program.name}"`;
}

/** Une identité reçue d'un relais : bornée, et rejetée si elle n'a pas la forme attendue. */
export function parseIdentity(raw: unknown): ProgramIdentity | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.exe !== "string" || value.exe === "" || value.exe.length > 1_000) return null;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  const script = typeof value.script === "string" && value.script !== "" ? value.script.slice(0, 1_000) : null;
  const platform = typeof value.platform === "string" ? value.platform.slice(0, 20) : "unknown";
  return { exe: value.exe, script, sha256: value.sha256, platform };
}

export class LocalPrograms {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(dir, "programs.json");
  }

  list(): KnownProgram[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as KnownProgram[]) : [];
    } catch {
      return [];
    }
  }

  private save(programs: KnownProgram[]): void {
    writeFileSync(this.file, `${JSON.stringify(programs, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Ce programme, vu à l'instant : son statut. Jamais vu : inscrit « en attente ». Vu à un
   * autre endroit ou sous une autre forme : c'est un autre programme, donc en attente aussi.
   */
  observe(name: string, identity: ProgramIdentity | null): KnownProgram {
    const programs = this.list();
    const id = programId(name, identity);
    const at = this.now().toISOString();
    const known = programs.find((program) => program.id === id);
    if (known) {
      known.lastSeen = at;
      if (identity && known.identity && identity.sha256 !== known.identity.sha256) {
        known.previousSha256 = [...known.previousSha256.filter((sha) => sha !== known.identity!.sha256), known.identity.sha256].slice(-10);
        known.identity = identity;
      }
      if (known.name !== name) known.name = name;
      this.save(programs);
      return known;
    }
    /*
     * `OATHRION_UNSAFE_TRUST_ALL_PROGRAMS=1` : tout programme est admis, et c'est inscrit comme
     * tel. Réservé aux essais automatiques (`server/test/setup.ts`) ; la documentation dit de ne
     * jamais le régler ailleurs.
     */
    const unsafe = process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS === "1";
    const added: KnownProgram = { id, name, identity, status: unsafe ? "trusted" : "pending", firstSeen: at, lastSeen: at, decidedAt: unsafe ? at : null, decidedBy: unsafe ? "OATHRION_UNSAFE_TRUST_ALL_PROGRAMS" : null, previousSha256: [] };
    this.save([...programs, added].slice(-200));
    return added;
  }

  /**
   * Une confirmation donnée d'avance par la personne, depuis son terminal (`npx oathrion` a trouvé
   * Claude Code sur la machine). Un programme déjà bloqué le reste.
   */
  trust(name: string, identity: ProgramIdentity, by: string): KnownProgram {
    const program = this.observe(name, identity);
    if (program.status === "blocked") return program;
    return this.decide(program.id, "trusted", by) ?? program;
  }

  /** La décision d'une personne, dans la console. */
  decide(id: string, status: "trusted" | "blocked", by: string): KnownProgram | null {
    const programs = this.list();
    const program = programs.find((candidate) => candidate.id === id);
    if (!program) return null;
    program.status = status;
    program.decidedAt = this.now().toISOString();
    program.decidedBy = by;
    this.save(programs);
    return program;
  }
}
