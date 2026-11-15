/**
 * LA DÉMONSTRATION DE CINQ MINUTES — un vrai outil, un ALLOW, un BLOCK.
 *
 *   DATABASE_URL=postgres://… npm run demo
 *
 * ## Ce que cette démonstration montre, et pourquoi elle existe
 *
 * Un pare-feu d'agents se vend mal en diapositives : la seule chose convaincante est de
 * voir une action **arriver** chez le fournisseur et une autre **ne pas y arriver**, le
 * fournisseur lui-même servant de témoin.
 *
 * C'est exactement ce que ce script fait. Il monte la chaîne complète — un faux
 * fournisseur HTTP, un serveur MCP local, et le **bundle de production** d'Oathrion devant
 * — puis il passe deux appels identiques à un détail près, et il affiche ce que le
 * fournisseur a reçu.
 *
 * ## Pourquoi un script et pas une page de `curl`
 *
 * Une démonstration qu'on ne peut pas rejouer n'est pas une démonstration. Les suites de
 * `curl` dans un document demandent toutes la même chose : « remplacez `<KEY>` par une
 * clé d'API » — et la clé vient d'un écran qu'il faut d'abord atteindre. Ici tout est
 * monté, la clé est créée par l'API, et la chaîne est détruite à la fin.
 *
 * ## Ce qui est RÉEL ici, et ce qui ne l'est pas
 *
 * Réel : le bundle de production (`dist/index.cjs`), PostgreSQL, le moteur de politiques,
 * la consommation du grant, la chaîne de reçus, le relais HTTP, et le journal du
 * fournisseur.
 *
 * Pas réel : le fournisseur. C'est un serveur local qui **ne refuse rien** — délibérément,
 * pour que la seule chose qui décide soit Oathrion. Aucun credential externe n'est lu,
 * aucun hôte extérieur n'est contacté, aucun argent ne bouge.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

import { createThrowawayDatabase, productionPostgresEnv } from "./lib/throwaway-postgres";
import { startMockDownstream, type MockDownstream } from "../server/mcp-local/mock-downstream";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5299;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DEST = "local-fixture";

const ADMIN_EMAIL = "demo@placet.test";
const ADMIN_PASSWORD = "demo-mot-de-passe-0123456789";
const SESSION_SECRET = `demo-${Math.random().toString(36).slice(2)}-0123456789012345`;
const PROVIDER_KEY = "cle-du-fournisseur-que-l-agent-ne-voit-jamais";
const AGENT_ID = "agt_demo";

type Child = ChildProcessByStdio<null, Readable, Readable>;

let log = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(
  pathname: string,
  init: { method?: string; body?: unknown; auth?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  /*
   * LE REFUS DE CONNEXION EST UNE RÉPONSE, PAS UNE EXCEPTION.
   *
   * La boucle d'attente appelle `/api/ready` avant qu'Oathrion écoute : `fetch` lève alors
   * `ECONNREFUSED`, et sans ce `catch` la démonstration mourait au premier tour au lieu
   * de réessayer. Rendre `status: 0` laisse l'appelant décider — la boucle réessaie, et
   * un appel métier qui reçoit 0 échoue avec un statut visible plutôt qu'une trace de
   * pile.
   */
  let res: Response;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    return {
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
      headers: new Headers(),
    };
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body, headers: res.headers };
}

/** L'appel de l'agent, tel qu'il l'écrirait vers l'API du fournisseur. */
async function agentCall(key: string, amount: number) {
  const res = await fetch(`${BASE}/api/v1/intercept/${DEST}/mock/refund`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ customer: "cus_demo", amount, currency: "EUR" }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return {
    status: res.status,
    body,
    decision: res.headers.get("x-oathrion-decision"),
    credentialInjected: res.headers.get("x-oathrion-credential-injected"),
  };
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("\nDATABASE_URL manquante. Le bundle de production ne tourne que sur PostgreSQL.");
    console.error("  docker run -d --name pg -e POSTGRES_PASSWORD=demo -p 55432:5432 postgres:17");
    console.error("  export DATABASE_URL=postgres://postgres:demo@127.0.0.1:55432/postgres");
    return 2;
  }

  console.log("\n" + "=".repeat(78));
  console.log("Oathrion — DÉMONSTRATION : un vrai outil, un ALLOW, un BLOCK");
  console.log("=".repeat(78));

  let mock: MockDownstream | undefined;
  let child: Child | undefined;
  let db: Awaited<ReturnType<typeof createThrowawayDatabase>> | undefined;

  try {
    /* ---------------------------------------------------- 1. LE FOURNISSEUR */
    mock = await startMockDownstream();
    console.log(`\n1. Le fournisseur (local, ne refuse rien)   ${mock.url}`);

    db = await createThrowawayDatabase("oathrion_demo");
    console.log("   Base PostgreSQL jetable                  créée et migrée");

    /* ------------------------------------------------------ 2. OATHRION DEVANT */
    /*
     * LA RÈGLE DU PARE-FEU. `amount` est lu DANS LE CORPS de la requête de l'agent :
     * l'agent n'annonce rien, c'est la requête qui parle. `divisor` convertit les
     * centimes de l'API en unités de la politique.
     */
    const rule = {
      id: "remboursements",
      destination: DEST,
      method: "POST",
      path: "/mock/refund",
      action: "purchase",
      target: "body.customer",
      amount: "body.amount",
      currency: "body.currency",
      /*
       * LES CENTIMES DE L'API, CONVERTIS EN UNITÉS DE LA POLITIQUE.
       *
       * Sans cette ligne, Oathrion lit `7500` comme 7 500 € et refuse un remboursement de
       * 75 €. C'est la faute que j'ai faite en écrivant cette démonstration, et elle vaut
       * d'être laissée visible : la plupart des APIs de paiement comptent en centimes, et
       * une politique qui dit « 100 € » comparée à des centimes refuse tout ou n'arrête
       * rien, selon le sens de l'erreur.
       */
      amountScale: 100,
      forwardHeaders: ["content-type"],
    };

    child = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...productionPostgresEnv(db.url),
        OATHRION_DB: undefined,
        PORT: String(PORT),
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: "",
        OATHRION_CONSOLE_USERS: `${ADMIN_EMAIL}:admin:${ADMIN_PASSWORD}`,
        OATHRION_SEED: "",
        OATHRION_LOCAL_MCP_URL: mock.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        OATHRION_INTERCEPTS: JSON.stringify([rule]),
        OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE: PROVIDER_KEY,
        OATHRION_KEK: Buffer.from(
          Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)),
        ).toString("base64"),
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    child.stdout.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr.on("data", (c: Buffer) => (log += c.toString()));

    let ready = false;
    for (let i = 0; i < 160 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      ready = (await call("/api/ready")).status === 200;
      if (!ready) await sleep(500);
    }
    if (!ready) {
      console.error("\nOathrion n'a pas démarré. Journal :\n" + log.slice(-2000));
      return 2;
    }
    console.log(`2. Oathrion (bundle de production)            ${BASE}`);

    /* ------------------------------------------- 3. UN AGENT ET UNE POLITIQUE */
    const session = await call("/api/auth/login", {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const token = String(session.body.token ?? "");
    if (token === "") {
      console.error("connexion impossible : " + JSON.stringify(session.body).slice(0, 200));
      return 2;
    }

    const agent = await call("/api/agents", {
      auth: token,
      body: {
        id: AGENT_ID,
        name: "Agent de démonstration",
        description: "Rembourse des clients à travers Oathrion.",
        provider: "openai",
        model: "gpt-4o",
        status: "active",
        owner: "finance",
        mandate: {
          maxTransactionAmount: 10_000,
          currency: "EUR",
          allowedCategories: [],
          blockedCategories: [],
          allowedDomains: [],
        },
        permissions: [
          {
            scope: "execute:payments",
            label: "Exécuter un paiement",
            description: "Sous mandat.",
            granted: true,
            risk: "high",
          },
        ],
        policyIds: [],
        tags: ["demo"],
      },
    });
    /*
     * LE STATUT EST VÉRIFIÉ. Sans cette ligne la démonstration continuait sur un agent
     * qui n'existait pas, et n'échouait que trois étapes plus loin, sur la création de
     * la clé — en désignant la mauvaise cause.
     */
    if (agent.status !== 201 && agent.status !== 200) {
      console.error(`agent non créé (${String(agent.status)}) : ${JSON.stringify(agent.body).slice(0, 300)}`);
      return 2;
    }

    /*
     * LA POLITIQUE : au-dessus de 100 €, c'est refusé. Une seule règle, parce qu'une
     * démonstration qui en montre dix ne montre rien.
     */
    const policy = await call("/api/policies", {
      auth: token,
      body: {
        id: "pol_demo_plafond",
        name: "Un remboursement au-dessus de 100 € est refusé",
        description: "Le plafond de la démonstration.",
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 100, currency: "EUR" },
        scope: "organization",
        appliesTo: "all agents",
        effect: "block",
        status: "enabled",
        action: "BLOCK",
        risk: "high",
        priority: 10,
      },
    });
    if (policy.status !== 201 && policy.status !== 200) {
      console.error(`politique non créée (${String(policy.status)}) : ${JSON.stringify(policy.body).slice(0, 300)}`);
      return 2;
    }
    console.log("3. Un agent, et UNE politique                au-dessus de 100 € : refusé");

    const key = await call("/api/keys", {
      auth: token,
      body: { name: "clé de démonstration", role: "operator", agentId: AGENT_ID },
    });
    const agentKey = String(key.body.secret ?? "");
    if (agentKey === "") {
      console.error("clé non créée : " + JSON.stringify(key.body).slice(0, 200));
      return 2;
    }

    /* ------------------------------------------------- 4. LES DEUX APPELS */
    console.log("\n" + "-".repeat(78));
    console.log("LES DEUX APPELS — identiques, à un montant près");
    console.log("-".repeat(78));

    const permis = await agentCall(agentKey, 7_500); // 75,00 €
    console.log(`\n  POST /mock/refund  amount=7500  (75 €)`);
    console.log(`    → HTTP ${String(permis.status)}   x-oathrion-decision: ${permis.decision ?? "(aucun)"}`);

    const refuse = await agentCall(agentKey, 45_000); // 450,00 €
    console.log(`\n  POST /mock/refund  amount=45000 (450 €)`);
    console.log(`    → HTTP ${String(refuse.status)}   x-oathrion-decision: ${refuse.decision ?? "(aucun)"}`);
    console.log(`    → ${String(refuse.body.reason ?? refuse.body.code ?? "")}`.slice(0, 160));

    /* --------------------------------- 5. LE TÉMOIN : LE FOURNISSEUR LUI-MÊME */
    console.log("\n" + "-".repeat(78));
    console.log("LE TÉMOIN — ce que le fournisseur a REÇU");
    console.log("-".repeat(78));
    const recus = mock.receivedOn("/mock/refund");
    console.log(`\n  requêtes arrivées chez le fournisseur : ${String(recus.length)}`);
    for (const r of recus) {
      const corps = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      console.log(`    amount=${/"amount":(\d+)/.exec(corps)?.[1] ?? "?"}`);
    }
    /*
     * LE POINT LE PLUS IMPORTANT DE LA DÉMONSTRATION, et il faut dire d'où il vient.
     *
     * L'agent n'a jamais eu la clé du fournisseur : Oathrion l'a injectée au passage. Donc
     * l'agent ne PEUT PAS appeler l'API en contournant Oathrion — le contournement n'est
     * pas déconseillé, il est impossible.
     *
     * Mais cette ligne est l'affirmation de OATHRION, pas le témoignage du fournisseur :
     * le faux fournisseur de ce dépôt n'enregistre pas les en-têtes reçus. L'injection
     * est prouvée ailleurs, contre le credential réellement présenté
     * (`npm run verify:intercept`, et `destination-credential.test.ts`). Ici on la
     * rapporte, on ne la démontre pas — et la différence est écrite pour qu'on ne la
     * confonde pas.
     */
    console.log(
      `\n  credential injecté par Oathrion : ${permis.credentialInjected ?? "(non dit)"}` +
        `   [affirmé par Oathrion ; le témoin n'enregistre pas les en-têtes]`,
    );

    /* ------------------------------------------------------- 6. LA TRAÇABILITÉ */
    const runs = await call("/api/executions", { auth: token });
    const liste = (runs.body.executions ?? runs.body) as { status?: string; action?: string }[];
    const compte = Array.isArray(liste) ? liste.length : 0;
    console.log("\n" + "-".repeat(78));
    console.log("LA TRACE — ce qu'un auditeur lira");
    console.log("-".repeat(78));
    console.log(`\n  exécutions enregistrées : ${String(compte)}`);
    if (Array.isArray(liste)) {
      for (const run of liste.slice(0, 4)) {
        console.log(`    ${String(run.action)} — ${String(run.status)}`);
      }
    }

    /* ------------------------------------------------------------ LE VERDICT */
    const ok =
      permis.status === 200 &&
      permis.decision === "ALLOW" &&
      refuse.status === 403 &&
      refuse.decision === "BLOCK" &&
      recus.length === 1;

    console.log("\n" + "=".repeat(78));
    if (ok) {
      console.log("DÉMONSTRATION RÉUSSIE");
      console.log("");
      console.log("  Deux appels partis de l'agent. UN SEUL est arrivé chez le fournisseur.");
      console.log("  Celui qui est arrivé portait un credential que l'agent n'a jamais vu.");
      console.log("  Celui qui a été refusé l'a été par une règle écrite en une ligne.");
    } else {
      console.log("DÉMONSTRATION EN ÉCHEC — et ce n'est pas un verdict favorable.");
      console.log(`  attendu : 200/ALLOW, 403/BLOCK, 1 requête reçue`);
      console.log(
        `  obtenu  : ${String(permis.status)}/${permis.decision ?? "-"}, ` +
          `${String(refuse.status)}/${refuse.decision ?? "-"}, ${String(recus.length)} reçue(s)`,
      );
    }
    console.log("=".repeat(78) + "\n");
    return ok ? 0 : 1;
  } finally {
    child?.kill("SIGTERM");
    await sleep(300);
    await mock?.close();
    await db?.dispose();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
