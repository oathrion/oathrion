/**
 * LA CONFIGURATION SSO : ce qu'elle refuse, et pourquoi chaque refus existe.
 *
 * ## Ce que ce fichier protège
 *
 * Une configuration SSO est quatre URL, un identifiant de client et un secret. Les quatre
 * URL étaient lues comme de SIMPLES CHAÎNES, sans jamais être analysées : une faute de
 * frappe ne se voyait qu'à la première connexion d'un utilisateur réel, et un schéma
 * inattendu traversait la configuration sans un mot.
 *
 * Et l'exception `OATHRION_OIDC_ALLOW_HTTP=1` levait bien plus que son nom n'annonce : elle
 * sautait la validation de destination et accordait le réseau privé à l'appel qui
 * transporte le `clientSecret`. Un `issuer` en `http://10.0.0.5` suffisait à faire de
 * Oathrion un client HTTP pointé sur le réseau interne, porteur d'un secret.
 *
 * Ces tests tiennent les deux bornes : les URL sont jugées au démarrage, et l'exception
 * ne couvre que la boucle locale — jamais la production.
 */

import { describe, expect, it } from "vitest";

import { isLoopbackHost, oidcConfigFor, oidcConfigProblems, SSO_CALLBACK_PATH } from "../identity/oidc";

const BASE = {
  issuer: "https://idp.acme.example.com",
  clientId: "placet-console",
  clientSecret: "secret-de-banc-d-essai-jamais-reel",
  redirectUri: `https://placet.acme.example.com${SSO_CALLBACK_PATH}`,
};

/** Un environnement d'essai complet, sans toucher à `process.env`. */
function env(config: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { OATHRION_OIDC: JSON.stringify({ ...BASE, ...config }), ...extra } as NodeJS.ProcessEnv;
}

describe("les quatre URL sont analysées, et non pas seulement recopiées", () => {
  it("accepte une configuration entièrement en HTTPS", () => {
    const config = oidcConfigFor(env({}));
    expect(config?.issuer).toBe(BASE.issuer);
  });

  for (const field of ["issuer", "redirectUri", "authorizationEndpoint", "tokenEndpoint", "jwksUri"]) {
    it(`refuse un "${field}" qui n'est pas une URL`, () => {
      expect(() => oidcConfigFor(env({ [field]: "idp.acme.example.com" }))).toThrow(
        /is not a URL/,
      );
    });
  }

  it("refuse un schéma qui n'est ni http ni https", () => {
    /* `file:` et `data:` analysent sans erreur : seul un test de schéma les arrête. */
    expect(() => oidcConfigFor(env({ jwksUri: "file:///etc/passwd" }))).toThrow(/scheme/);
  });

  it("refuse un identifiant placé dans l'URL", () => {
    /*
     * Un secret dans l'URL apparaît dans les journaux, dans `Referer` et dans les
     * messages d'erreur — et il contourne le coffre, seul endroit où un secret vit.
     */
    expect(() =>
      oidcConfigFor(env({ tokenEndpoint: "https://user:motdepasse@idp.acme.example.com/token" })),
    ).toThrow(/credentials in the URL/);
  });

  it("refuse un fragment, qui n'est jamais transmis au serveur", () => {
    expect(() => oidcConfigFor(env({ authorizationEndpoint: "https://idp.acme.example.com/a#x" })))
      .toThrow(/fragment/);
  });

  it("refuse une URL de retour qui n'est pas la route réellement servie", () => {
    /*
     * Le fournisseur renverrait l'utilisateur sur une adresse qu'Oathrion ne sert pas, et
     * le symptôme serait un 404 après une authentification réussie — le plus déroutant
     * des symptômes, puisque tout s'est bien passé jusque-là.
     */
    expect(() => oidcConfigFor(env({ redirectUri: "https://placet.acme.example.com/retour" })))
      .toThrow(new RegExp(SSO_CALLBACK_PATH));
  });

  it("refuse une URL de retour qui porte déjà des paramètres de requête", () => {
    expect(() =>
      oidcConfigFor(env({ redirectUri: `https://placet.acme.example.com${SSO_CALLBACK_PATH}?t=1` })),
    ).toThrow(/query parameters/);
  });

  it("laisse les points d'entrée absents à la découverte", () => {
    const config = oidcConfigFor(env({}));
    expect(config?.tokenEndpoint).toBe("");
    expect(config?.jwksUri).toBe("");
  });
});

describe("l'exception HTTP est bornée à la boucle locale", () => {
  it("refuse HTTP sans le drapeau", () => {
    expect(() => oidcConfigFor(env({ issuer: "http://idp.acme.example.com" }))).toThrow(/HTTPS/);
  });

  it("accepte HTTP sur la boucle locale avec le drapeau", () => {
    const config = oidcConfigFor(
      env(
        { issuer: "http://127.0.0.1:8080", redirectUri: `http://localhost:5000${SSO_CALLBACK_PATH}` },
        { OATHRION_OIDC_ALLOW_HTTP: "1" },
      ),
    );
    expect(config?.issuer).toBe("http://127.0.0.1:8080");
  });

  for (const host of ["10.0.0.5", "192.168.1.10", "169.254.169.254", "idp.acme.example.com", "metadata.google.internal"]) {
    it(`refuse HTTP vers ${host} MÊME avec le drapeau`, () => {
      /*
       * Le cas qui donne son sens à la borne. `169.254.169.254` est le service de
       * métadonnées des hébergeurs : un `issuer` pointé là, en HTTP, et Oathrion allait lui
       * porter le `clientSecret`.
       */
      expect(() =>
        oidcConfigFor(env({ issuer: `http://${host}` }, { OATHRION_OIDC_ALLOW_HTTP: "1" })),
      ).toThrow(/loopback/);
    });
  }

  it("reconnaît 127.0.0.0/8 en entier, et pas seulement 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    /* Les voisins qui ressemblent sans l'être. */
    expect(isLoopbackHost("127.0.0.1.evil.example.com")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example.com")).toBe(false);
    expect(isLoopbackHost("12700.1")).toBe(false);
  });
});

describe("le drapeau HTTP et la production ne coexistent pas", () => {
  it("REFUSE le démarrage quand les deux sont posés", () => {
    const problems = oidcConfigProblems(
      env({ issuer: "http://127.0.0.1:8080" }, { OATHRION_OIDC_ALLOW_HTTP: "1", NODE_ENV: "production" }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/OATHRION_OIDC_ALLOW_HTTP=1 with NODE_ENV=production is REFUSED/);
  });

  it("refuse le drapeau en production même SANS configuration SSO", () => {
    /*
     * Le trajet réel d'une variable d'environnement : posée sur un banc d'essai, puis
     * l'environnement est copié vers la production. Le drapeau seul, en production, est
     * déjà la trace de cette copie — même si OATHRION_OIDC a été retiré.
     */
    const problems = oidcConfigProblems({
      OATHRION_OIDC_ALLOW_HTTP: "1",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(problems[0]).toMatch(/REFUSED/);
  });

  it("le refus de production passe AVANT l'analyse de la configuration", () => {
    /*
     * Avec un OATHRION_OIDC par ailleurs invalide, c'est le problème de production qui doit
     * être nommé — sinon l'autre faute le masquerait, et l'exploitant corrigerait la
     * mauvaise chose avant de revoir celle-ci.
     */
    const problems = oidcConfigProblems({
      OATHRION_OIDC: "{ ceci n'est pas du JSON",
      OATHRION_OIDC_ALLOW_HTTP: "1",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/NODE_ENV=production/);
  });

  it("ne dit rien quand aucun SSO n'est configuré", () => {
    expect(oidcConfigProblems({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("accepte le drapeau hors production", () => {
    const problems = oidcConfigProblems(
      env({ issuer: "http://127.0.0.1:8080", redirectUri: `http://localhost:5000${SSO_CALLBACK_PATH}` },
          { OATHRION_OIDC_ALLOW_HTTP: "1" }),
    );
    expect(problems).toEqual([]);
  });

  it("ne révèle jamais le secret du client dans un message de refus", () => {
    /* Un message d'erreur de configuration finit dans les journaux de démarrage. */
    let message = "";
    try {
      oidcConfigFor(env({ issuer: "http://10.0.0.5" }, { OATHRION_OIDC_ALLOW_HTTP: "1" }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(BASE.clientSecret);
  });
});
