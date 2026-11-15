/**
 * Les propriétés, telles que SPEC.md § 2 les énonce.
 *
 * Règle de lecture : une propriété lève pour échouer, et rend une chaîne de détail pour
 * passer. Le runner traduit. Aucune propriété n'attrape ses propres exceptions — un
 * `try` local serait le premier endroit où une indulgence se glisserait.
 *
 * Règle d'écriture : chaque propriété négative porte son contrôle positif `[+]`, et
 * **un contrôle positif qui échoue rend la propriété FAIL**, jamais PASS (§ 1.4). Sans
 * cela, une implémentation qui refuse tout passerait tout ce fichier.
 */

import type { Context, Property } from "./types";
import { codeOf, describe, decisionOf, indistinguishable, isRefusal } from "./client";

/* ------------------------------------------------------------------ outils */

function fail(message: string): never {
  throw new Error(message);
}

/** Échec dû au contrôle positif : nommé, parce qu'il ne se diagnostique pas pareil. */
function failPositive(message: string): never {
  throw new Error(`contrôle positif : ${message}`);
}

interface ActionBody {
  action: string;
  destinationId: string;
  arguments: Record<string, unknown>;
}

function pay(ctx: Context, amount: number, destination?: string): ActionBody {
  return {
    action: ctx.state.allowVerb,
    destinationId: destination ?? ctx.state.a.destination,
    arguments: { customer: "cus_conformance", amount, currency: ctx.state.currency },
  };
}

function erase(ctx: Context, destination?: string): ActionBody {
  return {
    action: ctx.state.blockVerb,
    destinationId: destination ?? ctx.state.a.destination,
    arguments: { customer: "cus_conformance" },
  };
}

const authorize = (ctx: Context, token: string | null, body: unknown) =>
  ctx.http.send("POST", "/api/actions/authorize", { token, json: body });

const execute = (ctx: Context, token: string | null, grantId: string, body: ActionBody) =>
  ctx.http.send("POST", "/api/actions/execute", { token, json: { grantId, ...body } });

const approve = (ctx: Context, token: string, grantId: string, actionHash: string) =>
  ctx.http.send("POST", `/api/actions/grants/${grantId}/approve`, {
    token,
    json: { actionHash },
  });

/** Autorise et exige un grant utilisable ; sinon c'est le contrôle positif qui tombe. */
async function grantFor(ctx: Context, token: string, body: ActionBody): Promise<string> {
  const reply = await authorize(ctx, token, body);
  const grantId = reply.body.grantId;
  if (decisionOf(reply) !== "ALLOW" || typeof grantId !== "string") {
    failPositive(`une autorisation attendue en ALLOW a rendu ${describe(reply)} ${JSON.stringify(reply.body).slice(0, 140)}`);
  }
  return grantId;
}

/** Mesure Δ autour d'une étape. Le kit ne lit jamais la valeur absolue. */
async function delta(ctx: Context, destination: string, step: () => Promise<void>): Promise<number> {
  const before = await ctx.driver.deliveries(destination);
  await step();
  return (await ctx.driver.deliveries(destination)) - before;
}

/* ------------------------------------------------------------ A. Décision */

const C1: Property = {
  id: "C1",
  level: "core",
  title: "La décision suit la règle",
  async run(ctx) {
    const { a, belowCeiling, aboveCeiling } = ctx.state;
    const low = await authorize(ctx, a.agent.token, pay(ctx, belowCeiling));
    const high = await authorize(ctx, a.agent.token, pay(ctx, aboveCeiling));
    const blocked = await authorize(ctx, a.agent.token, erase(ctx));

    if (decisionOf(low) !== "ALLOW") fail(`sous le plafond : ${decisionOf(low)} (${describe(low)})`);
    if (decisionOf(high) !== "APPROVAL_REQUIRED") fail(`au-dessus du plafond : ${decisionOf(high)} (${describe(high)})`);
    if (decisionOf(blocked) !== "BLOCK") fail(`verbe bloqué : ${decisionOf(blocked)} (${describe(blocked)})`);
    return "ALLOW / APPROVAL_REQUIRED / BLOCK rendus comme la règle l'impose";
  },
};

const C2: Property = {
  id: "C2",
  level: "extended",
  title: "Toute décision est une réponse réussie",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling, aboveCeiling } = ctx.state;
    const replies = [
      await authorize(ctx, a.agent.token, pay(ctx, belowCeiling)),
      await authorize(ctx, a.agent.token, pay(ctx, aboveCeiling)),
      await authorize(ctx, a.agent.token, erase(ctx)),
    ];
    const bad = replies.filter((r) => r.status !== 200).map(describe);
    if (bad.length > 0) fail(`statuts non-200 : ${bad.join(", ")}`);
    return "les trois décisions sont rendues en 200";
  },
};

const C3: Property = {
  id: "C3",
  level: "core",
  title: "Une action BLOCK n'atteint jamais la destination",
  needs: ["C1"],
  async run(ctx) {
    const { a } = ctx.state;
    let grantId: unknown;
    const onBlock = await delta(ctx, a.destination, async () => {
      const reply = await authorize(ctx, a.agent.token, erase(ctx));
      if (decisionOf(reply) !== "BLOCK") fail(`le verbe bloqué a rendu ${decisionOf(reply)}`);
      grantId = reply.body.grantId;
      if (typeof grantId === "string") {
        const run = await execute(ctx, a.agent.token, grantId, erase(ctx));
        if (!isRefusal(run)) fail(`un grant émis sur un BLOCK a été accepté à l'exécution : ${describe(run)}`);
      }
    });
    if (onBlock !== 0) fail(`${onBlock} livraison(s) après un BLOCK`);

    const onAllow = await delta(ctx, a.destination, async () => {
      const g = await grantFor(ctx, a.agent.token, pay(ctx, ctx.state.belowCeiling));
      const run = await execute(ctx, a.agent.token, g, pay(ctx, ctx.state.belowCeiling));
      if (run.status !== 200) failPositive(`une exécution légitime a rendu ${describe(run)}`);
    });
    if (onAllow !== 1) failPositive(`une exécution légitime a produit Δ=${onAllow}, attendu 1`);
    return `Δ=0 après BLOCK, Δ=1 après une exécution légitime`;
  },
};

const C4: Property = {
  id: "C4",
  level: "core",
  title: "Une action qu'aucune règle ne nomme est refusée",
  needs: ["C1"],
  async run(ctx) {
    const verb = `conformance.undeclared.${ctx.nonce()}`;
    const reply = await authorize(ctx, ctx.state.a.agent.token, {
      action: verb,
      destinationId: ctx.state.a.destination,
      arguments: {},
    });
    if (decisionOf(reply) !== "BLOCK") fail(`verbe inconnu : ${decisionOf(reply)} (${describe(reply)})`);
    if (typeof reply.body.grantId === "string") fail("un grant a été émis pour un verbe inconnu");
    return `le verbe tiré au hasard "${verb}" est BLOCK, sans grant`;
  },
};

const C5: Property = {
  id: "C5",
  level: "extended",
  title: "Décider ne livre rien",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    let grantId = "";
    const onDecision = await delta(ctx, a.destination, async () => {
      grantId = await grantFor(ctx, a.agent.token, pay(ctx, belowCeiling));
    });
    if (onDecision !== 0) fail(`l'autorisation seule a produit Δ=${onDecision}`);

    const onExecute = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, grantId, pay(ctx, belowCeiling));
      if (run.status !== 200) failPositive(`l'exécution a rendu ${describe(run)}`);
    });
    if (onExecute !== 1) failPositive(`l'exécution a produit Δ=${onExecute}, attendu 1`);
    return "Δ=0 à l'autorisation, Δ=1 à la présentation du grant";
  },
};

const C6: Property = {
  id: "C6",
  level: "core",
  title: "Le client ne dicte pas l'autorité",
  needs: ["C1"],
  async run(ctx) {
    const { a } = ctx.state;
    const forced = await authorize(ctx, a.agent.token, { ...erase(ctx), decision: "ALLOW" });
    if (forced.status === 200 && decisionOf(forced) === "ALLOW") {
      fail("un champ `decision` fourni par le client a produit un ALLOW");
    }
    const normal = await authorize(ctx, a.agent.token, pay(ctx, ctx.state.belowCeiling));
    if (decisionOf(normal) !== "ALLOW") failPositive(`la même action sans le champ a rendu ${decisionOf(normal)}`);
    return `le champ imposé donne ${describe(forced)}, l'action normale reste ALLOW`;
  },
};

const C7: Property = {
  id: "C7",
  level: "extended",
  title: "Un champ d'autorité est refusé",
  needs: ["C6"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    const withDecision = await authorize(ctx, a.agent.token, { ...pay(ctx, belowCeiling), decision: "ALLOW" });
    const withHash = await authorize(ctx, a.agent.token, { ...pay(ctx, belowCeiling), actionHash: "0".repeat(64) });
    const bad = [withDecision, withHash].filter((r) => r.status !== 400).map(describe);
    if (bad.length > 0) fail(`attendu 400, obtenu : ${bad.join(", ")}`);
    return `400 sur \`decision\` et sur \`actionHash\``;
  },
};

const C8: Property = {
  id: "C8",
  level: "core",
  title: "Sans credential valide, pas de décision",
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    const anonymous = await authorize(ctx, null, pay(ctx, belowCeiling));
    const wrong = await authorize(ctx, `conformance-${ctx.nonce()}`, pay(ctx, belowCeiling));

    for (const [label, reply] of [["sans credential", anonymous], ["credential inconnu", wrong]] as const) {
      if (!isRefusal(reply)) fail(`${label} : ${describe(reply)} au lieu d'un refus`);
      if ("decision" in reply.body) fail(`${label} : le corps porte une décision (${decisionOf(reply)})`);
    }
    const ok = await authorize(ctx, a.agent.token, pay(ctx, belowCeiling));
    if (ok.status !== 200) failPositive(`un credential valide a rendu ${describe(ok)}`);
    return `${describe(anonymous)} et ${describe(wrong)}, aucun corps ne porte de décision`;
  },
};

/* --------------------------------------------------------------- B. Grant */

const C10: Property = {
  id: "C10",
  level: "core",
  title: "Un grant s'exécute au plus une fois",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    const body = pay(ctx, belowCeiling);
    const g = await grantFor(ctx, a.agent.token, body);

    const first = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, g, body);
      if (run.status !== 200) failPositive(`la première présentation a rendu ${describe(run)}`);
    });
    if (first !== 1) failPositive(`la première présentation a produit Δ=${first}`);

    let replay = { status: 0 } as { status: number };
    const second = await delta(ctx, a.destination, async () => {
      replay = await execute(ctx, a.agent.token, g, body);
    });
    if (!isRefusal(replay as never)) fail(`le rejeu a rendu ${replay.status} au lieu d'un refus`);
    if (second !== 0) fail(`le rejeu a produit Δ=${second}`);

    /*
     * La course. Dix grants, deux présentations chacun émises sans attendre la
     * première réponse. Un PASS signifie qu'aucune course n'a été OBSERVÉE, pas
     * qu'il n'en existe aucune — c'est écrit dans SPEC.md et ce n'est pas une
     * précaution de style.
     */
    const grants: string[] = [];
    for (let i = 0; i < 10; i += 1) grants.push(await grantFor(ctx, a.agent.token, body));
    const raced = await delta(ctx, a.destination, async () => {
      await Promise.all(
        grants.flatMap((id) => [execute(ctx, a.agent.token, id, body), execute(ctx, a.agent.token, id, body)]),
      );
    });
    if (raced !== 10) fail(`20 présentations concurrentes sur 10 grants ont produit Δ=${raced}, attendu 10`);
    return `rejeu refusé (${describe(replay as never)}), Δ=0 ; 20 présentations concurrentes → Δ=10`;
  },
};

const C11: Property = {
  id: "C11",
  level: "core",
  title: "Un grant est lié à l'action exacte",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    const g = await grantFor(ctx, a.agent.token, pay(ctx, belowCeiling));
    let reply = { status: 0 } as { status: number };
    const moved = await delta(ctx, a.destination, async () => {
      reply = await execute(ctx, a.agent.token, g, pay(ctx, belowCeiling + 1));
    });
    if (!isRefusal(reply as never)) fail(`une action modifiée a été acceptée : ${reply.status}`);
    if (moved !== 0) fail(`une action modifiée a produit Δ=${moved}`);

    const g2 = await grantFor(ctx, a.agent.token, pay(ctx, belowCeiling));
    const ok = await execute(ctx, a.agent.token, g2, pay(ctx, belowCeiling));
    if (ok.status !== 200) failPositive(`l'action d'origine a rendu ${describe(ok)}`);
    return `montant modifié refusé (${describe(reply as never)}), Δ=0`;
  },
};

const C12: Property = {
  id: "C12",
  level: "core",
  title: "Un grant est lié à son agent",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    const body = pay(ctx, belowCeiling);
    const g = await grantFor(ctx, a.agent.token, body);
    let reply = { status: 0 } as { status: number };
    const other = await delta(ctx, a.destination, async () => {
      reply = await execute(ctx, a.agent2.token, g, body);
    });
    if (!isRefusal(reply as never)) fail(`un autre agent a pu présenter le grant : ${reply.status}`);
    if (other !== 0) fail(`un autre agent a produit Δ=${other}`);

    const ok = await execute(ctx, a.agent.token, g, body);
    if (ok.status !== 200) failPositive(`le titulaire a rendu ${describe(ok)} après le refus de l'autre`);
    return `agent étranger refusé (${describe(reply as never)}), titulaire toujours servi`;
  },
};

const C14: Property = {
  id: "C14",
  level: "core",
  title: "Un refus ne consomme pas le grant",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    const body = pay(ctx, belowCeiling);
    const causes: { label: string; attempt: (g: string) => Promise<{ status: number }> }[] = [
      { label: "action modifiée", attempt: (g) => execute(ctx, a.agent.token, g, pay(ctx, belowCeiling + 1)) },
      { label: "autre agent", attempt: (g) => execute(ctx, a.agent2.token, g, body) },
    ];

    const survived: string[] = [];
    for (const cause of causes) {
      const g = await grantFor(ctx, a.agent.token, body);
      const refused = await cause.attempt(g);
      if (!isRefusal(refused as never)) continue; // relève de C11 ou C12, pas d'ici
      const after = await delta(ctx, a.destination, async () => {
        const ok = await execute(ctx, a.agent.token, g, body);
        if (ok.status !== 200) fail(`après un refus pour « ${cause.label} », le titulaire obtient ${describe(ok)}`);
      });
      if (after !== 1) fail(`après un refus pour « ${cause.label} », l'exécution légitime a produit Δ=${after}`);
      survived.push(cause.label);
    }
    if (survived.length === 0) failPositive("aucune cause de refus n'a pu être provoquée");
    return `le grant survit à : ${survived.join(", ")}`;
  },
};

const C15: Property = {
  id: "C15",
  level: "core",
  title: "Un grant jamais émis n'autorise rien",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    let reply = { status: 0 } as { status: number };
    const forged = await delta(ctx, a.destination, async () => {
      reply = await execute(ctx, a.agent.token, `conformance-${ctx.nonce()}`, pay(ctx, belowCeiling));
    });
    if (!isRefusal(reply as never)) fail(`un identifiant forgé a rendu ${reply.status}`);
    if (forged !== 0) fail(`un identifiant forgé a produit Δ=${forged}`);
    return `identifiant forgé refusé (${describe(reply as never)}), Δ=0`;
  },
};

const C16: Property = {
  id: "C16",
  level: "core",
  title: "Le credential fixe l'agent",
  needs: ["C1"],
  async run(ctx) {
    const { a, belowCeiling } = ctx.state;
    if (!a.agent2.agentId) failPositive("l'état préparé ne nomme pas le second agent de A");
    const reply = await authorize(ctx, a.agent.token, { ...pay(ctx, belowCeiling), agentId: a.agent2.agentId });
    if (!isRefusal(reply)) fail(`nommer un autre agent a rendu ${describe(reply)}`);
    if ("decision" in reply.body) fail(`le corps porte une décision (${decisionOf(reply)})`);

    const ok = await authorize(ctx, a.agent2.token, pay(ctx, belowCeiling));
    if (ok.status !== 200) failPositive(`le credential du second agent a rendu ${describe(ok)}`);
    return `${describe(reply)} sans décision ; le second agent reste servi pour lui-même`;
  },
};

/* --------------------------------------------------------- C. Approbation */

/** Autorise au-dessus du plafond et rend le grant retenu plus son empreinte. */
async function heldGrant(ctx: Context, token: string): Promise<{ id: string; hash: string }> {
  const reply = await authorize(ctx, token, pay(ctx, ctx.state.aboveCeiling));
  const id = reply.body.grantId;
  const hash = reply.body.actionHash;
  if (decisionOf(reply) !== "APPROVAL_REQUIRED" || typeof id !== "string" || typeof hash !== "string") {
    failPositive(`au-dessus du plafond : ${decisionOf(reply)} ${describe(reply)} (grantId/actionHash attendus)`);
  }
  return { id, hash };
}

const C18: Property = {
  id: "C18",
  level: "core",
  title: "Un grant en attente ne s'exécute pas",
  needs: ["C1"],
  async run(ctx) {
    const { a, aboveCeiling } = ctx.state;
    const held = await heldGrant(ctx, a.agent.token);
    let reply = { status: 0 } as { status: number };
    const pending = await delta(ctx, a.destination, async () => {
      reply = await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
    });
    if (!isRefusal(reply as never)) fail(`un grant en attente a été exécuté : ${reply.status}`);
    if (pending !== 0) fail(`un grant en attente a produit Δ=${pending}`);

    const ok = await approve(ctx, a.admin.token, held.id, held.hash);
    if (ok.status !== 200) failPositive(`l'approbation par l'admin a rendu ${describe(ok)}`);
    const after = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
      if (run.status !== 200) failPositive(`après approbation, l'exécution a rendu ${describe(run)}`);
    });
    if (after !== 1) failPositive(`après approbation, Δ=${after}`);
    return `en attente : refus (${describe(reply as never)}), Δ=0 ; après approbation : Δ=1`;
  },
};

const C19: Property = {
  id: "C19",
  level: "extended",
  title: "Approuver ne livre rien",
  needs: ["C18"],
  async run(ctx) {
    const { a, aboveCeiling } = ctx.state;
    const held = await heldGrant(ctx, a.agent.token);
    const onApproval = await delta(ctx, a.destination, async () => {
      const ok = await approve(ctx, a.admin.token, held.id, held.hash);
      if (ok.status !== 200) failPositive(`l'approbation a rendu ${describe(ok)}`);
    });
    if (onApproval !== 0) fail(`l'approbation seule a produit Δ=${onApproval}`);
    const onExecute = await delta(ctx, a.destination, async () => {
      await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
    });
    if (onExecute !== 1) failPositive(`l'exécution après approbation a produit Δ=${onExecute}`);
    return "Δ=0 à l'approbation, Δ=1 à l'exécution";
  },
};

const C20: Property = {
  id: "C20",
  level: "core",
  title: "L'agent ne s'approuve pas lui-même",
  needs: ["C18"],
  async run(ctx) {
    const { a, aboveCeiling } = ctx.state;
    const held = await heldGrant(ctx, a.agent.token);
    const self = await approve(ctx, a.agent.token, held.id, held.hash);
    if (!isRefusal(self)) fail(`l'agent demandeur a pu approuver son propre grant : ${describe(self)}`);
    const after = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
      if (!isRefusal(run)) fail(`après une auto-approbation refusée, l'exécution a rendu ${describe(run)}`);
    });
    if (after !== 0) fail(`après une auto-approbation refusée, Δ=${after}`);

    const admin = await approve(ctx, a.admin.token, held.id, held.hash);
    if (admin.status !== 200) failPositive(`l'approbation par l'admin a rendu ${describe(admin)}`);
    return `auto-approbation refusée (${describe(self)}), approbation par l'admin acceptée`;
  },
};

const C21: Property = {
  id: "C21",
  level: "core",
  title: "Une nouvelle approbation ne réarme pas un grant consommé",
  needs: ["C10", "C18"],
  async run(ctx) {
    const { a, aboveCeiling } = ctx.state;
    const held = await heldGrant(ctx, a.agent.token);
    const first = await approve(ctx, a.admin.token, held.id, held.hash);
    if (first.status !== 200) failPositive(`la première approbation a rendu ${describe(first)}`);
    const used = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
      if (run.status !== 200) failPositive(`l'exécution approuvée a rendu ${describe(run)}`);
    });
    if (used !== 1) failPositive(`l'exécution approuvée a produit Δ=${used}`);

    const again = await approve(ctx, a.admin.token, held.id, held.hash);
    const rearmed = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
      if (!isRefusal(run)) fail(`un grant consommé puis réapprouvé a été exécuté : ${describe(run)}`);
    });
    if (rearmed !== 0) fail(`un grant consommé puis réapprouvé a produit Δ=${rearmed}`);
    return `réapprobation ${describe(again)}, puis exécution refusée, Δ=0`;
  },
};

const C22: Property = {
  id: "C22",
  level: "extended",
  title: "Un rejet est définitif",
  needs: ["C18"],
  async run(ctx) {
    const { a, aboveCeiling } = ctx.state;
    const held = await heldGrant(ctx, a.agent.token);
    const rejected = await ctx.http.send("POST", `/api/actions/grants/${held.id}/reject`, {
      token: a.admin.token,
      json: {},
    });
    if (rejected.status !== 200) failPositive(`le rejet a rendu ${describe(rejected)}`);

    const again = await approve(ctx, a.admin.token, held.id, held.hash);
    if (!isRefusal(again)) fail(`un grant rejeté a pu être approuvé : ${describe(again)}`);
    const after = await delta(ctx, a.destination, async () => {
      const run = await execute(ctx, a.agent.token, held.id, pay(ctx, aboveCeiling));
      if (!isRefusal(run)) fail(`un grant rejeté a été exécuté : ${describe(run)}`);
    });
    if (after !== 0) fail(`un grant rejeté a produit Δ=${after}`);
    return `rejet accepté, approbation ultérieure ${describe(again)}, Δ=0`;
  },
};

/* ----------------------------------------------------------- D. Isolation */

const C24: Property = {
  id: "C24",
  level: "core",
  title: "B ne peut pas approuver un grant de A",
  needs: ["C18"],
  async run(ctx) {
    const { a, b } = ctx.state;
    const held = await heldGrant(ctx, a.agent.token);
    const foreign = await approve(ctx, b.admin.token, held.id, held.hash);
    const absent = await approve(ctx, b.admin.token, `conformance-${ctx.nonce()}`, held.hash);
    if (!indistinguishable(foreign, absent)) {
      fail(`le grant de A répond ${describe(foreign)} là où un inexistant répond ${describe(absent)} — oracle d'existence`);
    }
    const mine = await approve(ctx, a.admin.token, held.id, held.hash);
    if (mine.status !== 200) failPositive(`l'admin de A n'a pas pu approuver son propre grant : ${describe(mine)}`);
    return `B obtient ${describe(foreign)}, identique à un identifiant inexistant`;
  },
};

const C26: Property = {
  id: "C26",
  level: "core",
  title: "B ne peut pas exécuter un grant de A",
  needs: ["C15"],
  async run(ctx) {
    const { a, b, belowCeiling } = ctx.state;
    const body = pay(ctx, belowCeiling);
    const g = await grantFor(ctx, a.agent.token, body);

    let foreign = { status: 0, body: {}, raw: "" };
    const crossed = await delta(ctx, a.destination, async () => {
      foreign = await execute(ctx, b.agent.token, g, body);
    });
    const absent = await execute(ctx, b.agent.token, `conformance-${ctx.nonce()}`, body);
    if (!indistinguishable(foreign as never, absent)) {
      fail(`le grant de A répond ${describe(foreign as never)} à B là où un inexistant répond ${describe(absent)}`);
    }
    if (crossed !== 0) fail(`B a produit Δ=${crossed} sur la destination de A`);

    const mine = await execute(ctx, a.agent.token, g, body);
    if (mine.status !== 200) failPositive(`A n'a pas pu exécuter son propre grant : ${describe(mine)}`);
    return `B obtient ${describe(foreign as never)}, indiscernable d'un inexistant ; Δ=0`;
  },
};

const C27: Property = {
  id: "C27",
  level: "core",
  title: "Lire un objet de A ne révèle pas son existence",
  needs: ["C1"],
  async run(ctx) {
    const { a, b, belowCeiling } = ctx.state;
    const body = pay(ctx, belowCeiling);
    const g = await grantFor(ctx, a.agent.token, body);
    const run = await execute(ctx, a.agent.token, g, body);
    const receiptId = run.body.receiptId;

    const checks: string[] = [];
    const paths: string[] = [`/api/actions/grants/${g}`];
    if (typeof receiptId === "string") paths.push(`/api/actions/receipts/${receiptId}`);

    for (const path of paths) {
      const foreign = await ctx.http.send("GET", path, { token: b.admin.token });
      const absentPath = path.replace(/[^/]+$/, `conformance-${ctx.nonce()}`);
      const absent = await ctx.http.send("GET", absentPath, { token: b.admin.token });
      if (!indistinguishable(foreign, absent)) {
        fail(`${path} : B obtient ${describe(foreign)} là où un inexistant donne ${describe(absent)}`);
      }
      const owner = await ctx.http.send("GET", path, { token: a.admin.token });
      if (owner.status !== 200) failPositive(`${path} : le propriétaire obtient ${describe(owner)}`);
      checks.push(`${path.split("/")[3]} ${describe(foreign)}`);
    }
    return `indiscernable d'un inexistant sur : ${checks.join(", ")}`;
  },
};

const C28: Property = {
  id: "C28",
  level: "core",
  title: "Les listes de B ne contiennent rien de A",
  needs: ["C1"],
  async run(ctx) {
    const { a, b, belowCeiling } = ctx.state;
    const body = pay(ctx, belowCeiling);
    const g = await grantFor(ctx, a.agent.token, body);
    const run = await execute(ctx, a.agent.token, g, body);
    const receiptId = run.body.receiptId;
    if (typeof receiptId !== "string") failPositive("l'exécution n'a pas rendu d'identifiant de reçu");

    const theirs = await ctx.http.send("GET", "/api/actions/receipts", { token: b.admin.token });
    if (theirs.status !== 200) fail(`la liste de B a rendu ${describe(theirs)}`);
    if (theirs.raw.includes(receiptId)) fail(`le reçu ${receiptId} de A apparaît dans la liste de B`);

    const ours = await ctx.http.send("GET", "/api/actions/receipts", { token: a.admin.token });
    if (!ours.raw.includes(receiptId)) failPositive(`le reçu de A n'apparaît pas dans sa propre liste (${describe(ours)})`);
    return `le reçu de A est absent de la liste de B et présent dans la sienne`;
  },
};

/* --------------------------------------------------------------- E. Audit */

/** Produit une action exécutée, pour qu'il y ait quelque chose à vérifier. */
async function executeOnce(ctx: Context): Promise<void> {
  const body = pay(ctx, ctx.state.belowCeiling);
  const g = await grantFor(ctx, ctx.state.a.agent.token, body);
  const run = await execute(ctx, ctx.state.a.agent.token, g, body);
  if (run.status !== 200) failPositive(`une exécution légitime a rendu ${describe(run)}`);
}

const C32: Property = {
  id: "C32",
  level: "core",
  title: "Une trace intacte se vérifie",
  needs: ["C1"],
  async run(ctx) {
    await executeOnce(ctx);
    const verified = await ctx.http.send("GET", "/api/actions/receipts/verify", {
      token: ctx.state.a.admin.token,
    });
    if (verified.status !== 200) fail(`la vérification a rendu ${describe(verified)}`);
    if (verified.body.ok !== true) fail(`la trace se déclare rompue : ${verified.raw.slice(0, 180)}`);
    const entries = Number(verified.body.entries ?? 0);
    if (!Number.isFinite(entries) || entries < 1) fail(`la trace compte ${entries} entrée(s)`);
    const head = verified.body.headHash;
    if (typeof head !== "string" || !/^[0-9a-f]{64}$/.test(head)) {
      fail(`tête de chaîne absente ou mal formée : ${String(head)}`);
    }
    return `${entries} entrée(s), tête ${head.slice(0, 12)}…`;
  },
};

const C33: Property = {
  id: "C33",
  level: "core",
  title: "La vérification est cadrée au locataire",
  needs: ["C32"],
  async run(ctx) {
    await executeOnce(ctx);
    const path = "/api/actions/receipts/verify";
    const mine = await ctx.http.send("GET", path, { token: ctx.state.a.admin.token });
    const theirs = await ctx.http.send("GET", path, { token: ctx.state.b.admin.token });
    if (mine.status !== 200 || theirs.status !== 200) {
      fail(`A ${describe(mine)}, B ${describe(theirs)} — les deux devaient répondre 200`);
    }
    /*
     * Ici l'égalité différentielle ne s'applique pas : la route ne nomme aucun objet,
     * donc il n'y a pas d'existence à révéler. Ce qui doit être vrai est plus simple et
     * plus fort — chaque locataire ne voit QUE sa propre chaîne.
     */
    if (mine.body.headHash === theirs.body.headHash) {
      fail("les deux locataires obtiennent la même tête de chaîne");
    }
    /*
     * CHAQUE LOCATAIRE DOIT POUVOIR VÉRIFIER LA SIENNE, et cette exigence a été ajoutée
     * parce qu'un mutant a montré que sans elle la propriété se satisfaisait pour la
     * mauvaise raison.
     *
     * `verification-globale` retire le cadrage par locataire de la lecture des reçus. Les
     * deux locataires voient alors les mêmes lignes — mais leurs têtes restent
     * DIFFÉRENTES, parce que la chaîne de A ne part pas du point de genèse de B : la
     * vérification de B ÉCHOUE, sa tête devient nulle, et « têtes distinctes » était
     * vrai. La propriété passait en décrivant une fuite comme un cloisonnement.
     *
     * Exiger `ok: true` des deux côtés ferme ce trou : un locataire qui ne peut plus
     * vérifier sa propre chaîne n'est pas cloisonné, il est cassé.
     */
    if (mine.body.ok !== true || theirs.body.ok !== true) {
      fail(
        `A ok=${String(mine.body.ok)}, B ok=${String(theirs.body.ok)} — chaque locataire doit ` +
          "pouvoir vérifier SA chaîne ; une vérification qui échoue n'est pas un cloisonnement",
      );
    }
    const aEntries = Number(mine.body.entries ?? 0);
    if (aEntries < 1) failPositive(`A obtient ${aEntries} entrée(s) après avoir exécuté`);
    return `A ${aEntries} entrée(s), B ${String(theirs.body.entries)} — têtes distinctes, les deux vérifient`;
  },
};

/* ------------------------------------------------- F. Honnêteté et contrat */

const C34: Property = {
  id: "C34",
  level: "core",
  title: "Chaque outil déclare s'il est simulé",
  async run(ctx) {
    const reply = await ctx.http.send("GET", "/api/tools", { token: ctx.state.a.admin.token });
    if (reply.status !== 200) fail(`l'inventaire a rendu ${describe(reply)}`);
    const items = reply.body.items;
    if (!Array.isArray(items) || items.length === 0) fail("l'inventaire est vide ou n'est pas un tableau");
    const offenders = items
      .filter((tool) => typeof (tool as Record<string, unknown>).simulated !== "boolean")
      .map((tool) => String((tool as Record<string, unknown>).id ?? "?"));
    if (offenders.length > 0) fail(`sans booléen \`simulated\` : ${offenders.join(", ")}`);
    return `${items.length} outil(s), chacun avec un booléen \`simulated\``;
  },
};

const C35: Property = {
  id: "C35",
  level: "extended",
  title: "Une erreur porte un code machine",
  async run(ctx) {
    /*
     * Jeu FIXE, émis ici. La v0.2 jugeait les réponses « collectées pendant le
     * passage » : son verdict dépendait donc de quelles autres propriétés avaient
     * tourné. Une propriété dont le résultat change avec l'ordre d'exécution est une
     * observation, pas une propriété.
     */
    const { a, belowCeiling } = ctx.state;
    const fixed = [
      ["grant inexistant", await ctx.http.send("GET", `/api/actions/grants/conformance-${ctx.nonce()}`, { token: a.admin.token })],
      ["corps invalide", await ctx.http.send("POST", "/api/actions/authorize", { token: a.agent.token, json: { action: 42 } })],
      ["credential absent", await authorize(ctx, null, pay(ctx, belowCeiling))],
    ] as const;

    const shape = /^[a-z][a-z0-9_]*$/;
    const bad: string[] = [];
    for (const [label, reply] of fixed) {
      if (reply.status >= 200 && reply.status < 300) {
        bad.push(`${label} : ${describe(reply)} n'est pas une erreur`);
        continue;
      }
      const code = codeOf(reply);
      if (!code || !shape.test(code)) bad.push(`${label} : code "${String(code)}"`);
    }
    if (bad.length > 0) fail(bad.join(" · "));

    // Complément, jamais fondement : ce que les autres propriétés ont croisé.
    const seen = ctx.http.errors.filter((r) => !codeOf(r) || !shape.test(codeOf(r)!));
    const extra = seen.length > 0 ? ` (${seen.length} réponse(s) croisée(s) sans code conforme)` : "";
    return `3 erreurs émises par la propriété, toutes avec un code conforme${extra}`;
  },
};

export const PROPERTIES: readonly Property[] = [
  C1, C2, C3, C4, C5, C6, C7, C8,
  C10, C11, C12, C14, C15, C16,
  C18, C19, C20, C21, C22,
  C24, C26, C27, C28,
  C32, C33,
  C34, C35,
];
