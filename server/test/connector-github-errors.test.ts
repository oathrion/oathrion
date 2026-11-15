/**
 * LES ERREURS DU FOURNISSEUR, CLASSÉES SANS RÉSEAU.
 *
 * ## Pourquoi ce fichier existe en plus de `verify:github`
 *
 * `npm run verify:github` observe les erreurs que GitHub veut bien produire : un 401 sur
 * un jeton faux, un 404 sur un dépôt absent. Deux cas lui échappent par nature.
 *
 * **Les deux 403.** GitHub emploie le même statut pour « ce jeton n'a pas la permission »
 * et pour « vous avez épuisé votre quota », et seul l'en-tête `x-ratelimit-remaining`
 * les sépare. Observer le second demanderait d'épuiser réellement le quota d'un compte.
 * Les confondre ferait dire à la console « jeton sans droits » là où il suffit d'attendre
 * une heure — et un exploitant régénérerait un jeton qui n'avait rien.
 *
 * **Le jeton expiré.** Un jeton à portée fine a une date de péremption, et GitHub répond
 * alors exactement comme pour un jeton faux : 401, « Bad credentials ». Oathrion ne peut
 * donc PAS annoncer « votre jeton a expiré ». Ce fichier assied ce choix : le code est
 * `unauthorized`, et la cause n'est pas devinée.
 */

import { describe, expect, it } from "vitest";

import { githubProbeCode, parseRepository, RepositoryTargetError } from "../connectors/github";

describe("le statut HTTP devient un code machine", () => {
  it("un 2xx est « ok »", () => {
    expect(githubProbeCode(200)).toBe("ok");
    expect(githubProbeCode(201)).toBe("ok");
    expect(githubProbeCode(204)).toBe("ok");
  });

  it("un 401 est « unauthorized », qu'il s'agisse d'un jeton faux ou expiré", () => {
    /*
     * LE CAS « EXPIRATION ». GitHub ne le distingue pas d'un jeton invalide — même
     * statut, même message. Rendre « expiré » serait annoncer une cause non observée.
     * Ce qu'Oathrion fait à la place : le connecteur passe en état `error`, le credential
     * reste stocké (une coupure n'est pas une révocation), et la console affiche le
     * message de GitHub plus l'action à mener.
     */
    expect(githubProbeCode(401)).toBe("unauthorized");
    expect(githubProbeCode(401, { "x-ratelimit-remaining": "4999" })).toBe("unauthorized");
  });

  it("un 403 SANS quota épuisé est une permission insuffisante", () => {
    expect(githubProbeCode(403, { "x-ratelimit-remaining": "4999" })).toBe("forbidden");
    /* En-tête absent : on ne suppose pas un quota épuisé, donc c'est une permission. */
    expect(githubProbeCode(403)).toBe("forbidden");
  });

  it("un 403 AVEC quota épuisé est un quota, pas une permission", () => {
    /*
     * La distinction qui compte pour l'exploitant : attendre, ou corriger les droits du
     * jeton. Deux gestes opposés derrière un seul statut HTTP.
     */
    expect(githubProbeCode(403, { "x-ratelimit-remaining": "0" })).toBe("rate_limited");
  });

  it("un 429 est un quota", () => {
    expect(githubProbeCode(429)).toBe("rate_limited");
  });

  it("un 404 est « not_found », et pas « forbidden »", () => {
    /*
     * GitHub rend 404 pour un dépôt privé auquel le jeton n'a pas accès — il ne confirme
     * pas l'existence de ce qu'il cache. Le reclasser en « forbidden » serait réintroduire
     * l'oracle que GitHub prend soin de ne pas donner.
     */
    expect(githubProbeCode(404)).toBe("not_found");
  });

  it("tout le reste est « unexpected », jamais « ok »", () => {
    for (const status of [0, 301, 302, 400, 422, 500, 502, 503, 504]) {
      expect(githubProbeCode(status), String(status)).toBe("unexpected");
    }
  });

  it("un 3xx n'est pas un succès", () => {
    /*
     * Le transport partagé ne suit PAS les redirections, et c'est voulu : une redirection
     * depuis un hôte validé est une sortie non validée. Elle doit donc arriver ici comme
     * un échec, et non comme un 2xx déguisé.
     */
    expect(githubProbeCode(302)).not.toBe("ok");
  });
});

describe("la cible d'une action est validée avant tout appel", () => {
  it("accepte la forme avec hôte, et en rend les trois morceaux", () => {
    expect(parseRepository("github.com/placet-labs/pilote")).toEqual({
      host: "github.com",
      owner: "placet-labs",
      repo: "pilote",
    });
  });

  it("tolère le schéma et une barre finale", () => {
    expect(parseRepository("https://github.com/placet-labs/pilote/")).toEqual({
      host: "github.com",
      owner: "placet-labs",
      repo: "pilote",
    });
  });

  it("refuse la forme sans hôte, en disant quoi écrire", () => {
    /*
     * Le message est vérifié, pas seulement le refus : tolérée, cette forme produisait un
     * BLOCK du mandat dont le motif — « does not resolve to a destination that can be
     * checked » — est exact et incompréhensible pour qui a juste écrit la cible trop court.
     */
    expect(() => parseRepository("placet-labs/pilote")).toThrow(RepositoryTargetError);
    expect(() => parseRepository("placet-labs/pilote")).toThrow(/github\.com\/placet-labs\/pilote/);
    expect(() => parseRepository("placet-labs/pilote")).toThrow(/outbound/);
  });

  it("refuse ce qui atteindrait un autre point de terminaison", () => {
    /*
     * La cible est interpolée dans un chemin d'API. Le verbe autorisé était « commenter
     * une issue » ; une cible libre ferait partir autre chose.
     */
    for (const bad of [
      "github.com/../../user",
      "github.com/placet-labs/pilote/issues",
      "github.com/placet-labs",
      "github.com//pilote",
      "github.com/placet-labs/pilote?x=1",
      "github.com/placet-labs/pilote#frag",
      "placet-labs/pilote/extra/more",
      "",
      "   ",
      "github.com",
    ]) {
      expect(() => parseRepository(bad), JSON.stringify(bad)).toThrow(RepositoryTargetError);
    }
  });

  it("refuse un hôte qui n'en est pas un", () => {
    expect(() => parseRepository("localhost/placet-labs/pilote")).toThrow(RepositoryTargetError);
    expect(() => parseRepository("10/placet-labs/pilote")).toThrow(RepositoryTargetError);
  });

  it("accepte une instance Enterprise, dont l'hôte est lisible", () => {
    /*
     * Et c'est le point : l'allowlist de domaine du mandat peut alors autoriser
     * `github.acme.example` sans autoriser `github.com`.
     */
    expect(parseRepository("github.acme.example/equipe/outil").host).toBe("github.acme.example");
  });
});
