/**
 * Écoute, publication de port et proxy : trois décisions distinctes, chacune écrite.
 *
 *   - ÉCOUTE (`OATHRION_HOST`) : où le processus accepte des connexions. 127.0.0.1 par
 *     défaut ; `0.0.0.0` DANS un conteneur, pour que le réseau Docker l'atteigne.
 *   - PUBLICATION (`ports:` / `expose:` de Compose) : ce qui de l'hôte atteint le
 *     conteneur. En production, rien : seul Caddy, sur le réseau Compose, joint Oathrion.
 *     Pour le pilote local, la boucle locale de l'hôte seulement.
 *   - PROXY (Caddy) : la seule porte publique, en HTTPS.
 *
 * Ce test fige les trois dans les fichiers de déploiement, pour qu'un `ports: "5000:5000"`
 * ajouté par commodité, ou un `0.0.0.0` remis en dur dans le serveur, échoue ici.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** Le bloc d'un service dans un fichier Compose (indentation de deux espaces). */
function serviceBlock(compose: string, service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start, `service ${service} introuvable`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("le serveur n'écoute plus sur 0.0.0.0 en dur", () => {
  it("server/index.ts lit l'adresse dans la configuration", () => {
    const source = read("server/index.ts");
    expect(source).not.toMatch(/host:\s*["']0\.0\.0\.0["']/);
    expect(source).toMatch(/resolveHost\(process\.env\.OATHRION_HOST\)/);
  });
});

describe("l'image Docker déclare son écoute de conteneur", () => {
  it("OATHRION_HOST=0.0.0.0 est écrit dans l'image, avec sa raison", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/OATHRION_HOST=0\.0\.0\.0/);
    expect(dockerfile).toMatch(/PAS une\s*\n?#?\s*exposition publique/);
  });
});

describe("Compose de production : seul le proxy est publié", () => {
  const compose = read("deploy/docker-compose.yml");

  it("Oathrion écoute sur l'interface du réseau Compose, explicitement", () => {
    expect(serviceBlock(compose, "placet")).toMatch(/OATHRION_HOST: "0\.0\.0\.0"/);
  });

  it("le port d'Oathrion n'est PAS publié sur l'hôte", () => {
    const placet = serviceBlock(compose, "placet");
    expect(placet).toMatch(/expose:\s*\n\s*- "5000"/);
    expect(placet).not.toMatch(/\n\s{4}ports:/);
  });

  it("PostgreSQL n'est pas publié", () => {
    expect(serviceBlock(compose, "postgres")).not.toMatch(/\n\s{4}ports:/);
  });

  it("le proxy est le seul service publié (80 et 443)", () => {
    const published = [...compose.matchAll(/\n {2}([a-z][\w-]*):\n[\s\S]*?(?=\n {2}[a-z][\w-]*:\n|\nvolumes:|$)/g)]
      .filter((match) => /\n\s{4}ports:/.test(match[0]))
      .map((match) => match[1]);
    expect(published).toEqual(["proxy"]);
  });
});

describe("Compose du pilote local : publication sur la boucle locale de l'hôte seulement", () => {
  const compose = read("deploy/docker-compose.local.yml");

  it("Oathrion écoute dans le conteneur, explicitement", () => {
    expect(serviceBlock(compose, "placet")).toMatch(/OATHRION_HOST: "0\.0\.0\.0"/);
  });

  it("chaque port publié l'est sur 127.0.0.1", () => {
    const mappings = [...compose.matchAll(/^\s+- "([^"]+:\d+)"\s*$/gm)].map((match) => match[1]!);
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings) expect(mapping, mapping).toMatch(/^127\.0\.0\.1:/);
  });
});
