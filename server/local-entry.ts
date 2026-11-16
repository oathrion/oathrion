/**
 * Le point d'entrée du mode local (`oathrion wrap`), compilé dans `dist/oathrion-local.cjs`.
 *
 * ## L'ordre est la propriété
 *
 *   1. le mode local, AVANT tout autre module : la configuration de la base est lue à
 *      l'import de `db.ts` (d'où les imports dynamiques ci-dessous — un import statique
 *      serait évalué avant `enterLocalMode()`) ;
 *   2. le serveur MCP enveloppé, lancé et inscrit AVANT que le serveur n'accepte une
 *      requête : un espace construit avant l'inscription ne verrait pas ses outils ;
 *   3. l'espace, l'agent, sa clé et les règles (`local-bootstrap.ts`) ;
 *   4. seulement alors, le serveur HTTP. Quand `/api/ready` répond, tout est prêt : le
 *      lanceur n'a pas d'autre signal à attendre.
 *
 * Sans `OATHRION_WRAP_COMMAND`, c'est un Oathrion local nu (étapes 2 et 3 sautées).
 *
 * Voir `server/local-mode.ts` pour ce que ce mode change, et pourquoi il ne s'ouvre pas
 * par l'environnement.
 */
import "./net-patience";
import { enterLocalMode } from "./local-mode";

enterLocalMode();

async function main(): Promise<void> {
  /*
   * `oathrion receipts verify` : vérifier la chaîne d'une base locale, sans serveur ni enfant.
   * La sortie standard porte le verdict en JSON ; le code de sortie dit s'il est sain.
   */
  if (process.argv.includes("--verify-receipts")) {
    const { verifyLocalReceipts } = await import("./local-verify");
    const verdict = await verifyLocalReceipts();
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    process.exit(verdict.ok ? 0 : 1);
  }

  /*
   * Le relais d'`oathrion wrap` nous tient l'entrée standard ouverte, sans jamais y écrire.
   * Quand elle se ferme, il a disparu — même tué net, ce qu'aucun signal ne nous dirait.
   * Personne ne peut plus nous parler : on s'arrête, en drainant si le serveur tourne déjà,
   * sinon en arrêtant le serveur enveloppé. Trouvé le 28 octobre 2026 : Cursor arrête le
   * relais par un signal, et Oathrion local restait à l'écoute, console comprise, avec son
   * enfant (STRESS-TEST-LOG §5.49).
   */
  let stopChild: (() => Promise<void>) | null = null;
  if (process.env.OATHRION_LOCAL_PARENT_PIPE === "1") {
    const { lifecycleInstalled } = await import("./lifecycle");
    let gone = false;
    const parentGone = () => {
      if (gone) return;
      gone = true;
      if (lifecycleInstalled()) {
        process.kill(process.pid, "SIGTERM");
        return;
      }
      void (stopChild?.() ?? Promise.resolve()).finally(() => process.exit(0));
    };
    process.stdin.once("end", parentGone);
    process.stdin.once("close", parentGone);
    process.stdin.on("error", parentGone);
    process.stdin.resume();
  }

  /*
   * LE PIVOT : un seul Oathrion pour tous les serveurs et tous les clients de la machine
   * (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`). Aucun serveur au démarrage : les relais les
   * inscrivent (`POST /api/local/hub`). Il s'arrête quand plus aucun relais ni console n'y est
   * attaché, en drainant, et arrête ses enfants.
   */
  if (process.env.OATHRION_LOCAL_HUB === "1") {
    const { LocalHub, activateHub } = await import("./local-hub");
    /* Les durées se règlent par l'environnement (les tests les raccourcissent). */
    const knob = (name: string) => Number(process.env[name]) || undefined;
    const hub = new LocalHub(process.env.OATHRION_LOCAL_STATE_DIR?.trim() || ".", {
      holderTimeoutMs: knob("OATHRION_LOCAL_HUB_HOLDER_TIMEOUT_MS"),
      idleMs: knob("OATHRION_LOCAL_HUB_IDLE_MS"),
    });
    activateHub(hub);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void hub.shutdown();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    hub.startSweeping(() => {
      console.error("[oathrion] local hub: no client or console attached any more — stopping.");
      process.kill(process.pid, "SIGTERM");
    }, knob("OATHRION_LOCAL_HUB_SWEEP_MS"));
    /* Prévenir l'approbateur : le bureau par défaut, Slack s'il est configuré (`server/local-notifications.ts`). */
    const { readNotificationSettings, registerLocalNotifications } = await import("./local-notifications");
    const { HourPasses } = await import("./local-hour-passes");
    const { notifier } = await import("./notifications");
    const { existsSync: exists } = await import("node:fs");
    const { dirname: parentOf, join: joinPath } = await import("node:path");
    /* L'image d'Oathrion dans les notifications, en attendant la mascotte de chaque agent (`notes/CONCEPTION-MASCOTTES.md`). */
    const logo = joinPath(parentOf(process.argv[1] ?? ""), "public", "favicon.png");
    const notifyDir = process.env.OATHRION_LOCAL_STATE_DIR?.trim() || ".";
    /*
     * Les fenêtres et notifications d'Oathrion laissées par un pivot précédent : fermées (essai
     * réel du 10 novembre, d'anciennes notifications « Decide » réapparaissaient d'abord).
     */
    if (process.platform === "linux" && process.env.OATHRION_LOCAL_NOTIFY_DESKTOP !== "0") {
      const { spawnSync } = await import("node:child_process");
      const { POPUP_SCRIPT_NAME } = await import("./notifications/popup");
      spawnSync("pkill", ["-u", String(process.getuid?.() ?? ""), "-f", joinPath(notifyDir, POPUP_SCRIPT_NAME)], { stdio: "ignore" });
      spawnSync("pkill", ["-u", String(process.getuid?.() ?? ""), "-f", "^notify-send --app-name=Oathrion"], { stdio: "ignore" });
    }
    /* La mascotte de chaque agent, dans chaque notification (`notes/CONCEPTION-MASCOTTES.md`). */
    const { writeMascots } = await import("./local-mascots");
    const { shareOf } = await import("./local-feed");
    /* La mascotte et le nom choisis par la personne pour chaque agent (`local-mascot-choices.ts`), sinon ceux d'office. */
    const shipped = joinPath(parentOf(process.argv[1] ?? ""), "public", "mascots");
    writeMascots(notifyDir, shipped);
    const face = (agent: string) => hub.mascots.of(agent);
    const mascotFor = (agent: string) => {
      const chosen = face(agent);
      const drawn = joinPath(shipped, `${chosen.id}.png`);
      return { path: exists(drawn) ? drawn : joinPath(notifyDir, "mascots", `${chosen.id}.svg`), name: chosen.name, id: chosen.id };
    };
    const announce = registerLocalNotifications(notifier, {
      stateDir: notifyDir,
      mascotFor,
      /* `OATHRION_LOCAL_NOTIFY_POPUP=0` : la notification du système, jamais notre fenêtre (les essais). */
      popup: process.env.OATHRION_LOCAL_NOTIFY_POPUP !== "0",
      keepShareCard: (card) => hub.keepShareCard(card),
      /* L'identité sonore, livrée avec la console (`client/public/sounds/`, `script/make-sounds.py`). */
      sounds: { ask: joinPath(parentOf(shipped), "sounds", "oathrion.wav"), danger: joinPath(parentOf(shipped), "sounds", "oathrion-danger.wav") },
      decisions: hub.decisions,
      baseUrl: `http://127.0.0.1:${process.env.PORT?.trim() || "5000"}`,
      secret: process.env.OATHRION_SESSION_SECRET?.trim() ?? "",
      desktopAllowed: process.env.OATHRION_LOCAL_NOTIFY_DESKTOP !== "0",
      ...(exists(logo) ? { image: logo } : {}),
      /* « Approve » / « Reject » dans la notification : la même voie que la console. */
      decideApproval: async (approvalId, status, by) => (await import("./routes")).resolveLocalApproval(hub.organization, approvalId, status, by ?? "you, from the notification"),
      /* « Allow 1 hour » : une permission bornée, gardée dans le dossier du pivot (`local-hour-passes.ts`). */
      passes: new HourPasses(hub.dir),
      /* La question posée dans le client : la notification attend 10 s (20 avant le 9 novembre : trop long devant son écran), et ne part que si rien n'est décidé. */
      inClient: {
        asks: (agentId) => hub.asksInClient(agentId),
        pending: async (approvalId) => {
          if (!approvalId) return true;
          const { repositoriesFor } = await import("./repositories");
          return (await repositoriesFor(hub.organization).approvals.findById(approvalId))?.status === "pending";
        },
        graceMs: knob("OATHRION_LOCAL_NOTIFY_GRACE_MS") ?? 10_000,
      },
    });
    /* Un programme jamais vu, arrêté à l'entrée : « C'est le mien » / « Bloquer », sans console. */
    /* Chaque alerte et chaque décision vont aussi au fil d'actualité de la console (`local-events.ts`). */
    hub.onUnknownProgram = (program) => {
      const met = hub.events.record({ kind: "new-agent", agent: program.name, detail: program.description });
      announce({
        ...program,
        feedId: met.id,
        actions: [
          { id: "trust", label: "It's mine" },
          { id: "block", label: "Block it" },
        ],
        feedbackAbout: `stopped ${program.name} at the door`,
        onChoice: (choice) => {
          hub.programs.decide(program.id, choice === "trust" ? "trusted" : "blocked", "you, from the notification");
          const decided = hub.events.record({ kind: choice === "trust" ? "trusted" : "blocked", agent: program.name, by: "you, from the notification" });
          return { text: choice === "trust" ? `${program.name} confirmed: it goes on` : `${program.name} blocked`, share: shareOf(decided) };
        },
      });
    };
    /*
     * `oathrion demo` (11 novembre : le moment « waouh » en dix secondes, sans lancer un vrai agent
     * hors de la prison). La notification, telle quelle, sur un agent pour de faux : Nova. Rien de
     * réel n'est mis en pause ni arrêté, et rien ne va au fil d'actualité. La phrase à partager le
     * dit honnêtement : on a ESSAYÉ Oathrion.
     */
    hub.onDemo = (kind) => {
      if (readNotificationSettings(notifyDir).desktop === false) {
        return { shown: false, detail: "Desktop notifications are off. Turn them on in the console (Settings), or: oathrion notifications desktop on" };
      }
      const tried = "I tried Oathrion, the antivirus for AI agents: an agent acting without permission is paused, and I decide from the notification.";
      if (kind === "decoy") {
        announce({
          custom: true,
          danger: true,
          id: `demo_decoy_${Date.now().toString(36)}`,
          name: "demo",
          mascotOf: "decoy",
          title: "Something read one of your decoys",
          description: "A demo: nothing was read. For real, Oathrion lays fake secrets, and tells you the moment anything reads one.",
          share: "I tried Oathrion's decoys: fake secrets on my computer, and Oathrion tells me the moment anything reads one.",
          actions: [{ id: "open", label: "See what happened" }],
          feedbackAbout: "the decoy demo",
        });
        return { shown: true, detail: "decoy" };
      }
      const nova = face("agy").name;
      announce({
        custom: true,
        id: `demo_${Date.now().toString(36)}`,
        name: "demo",
        mascotOf: "agy",
        title: `${nova} (demo) is paused`,
        description: "A demo: no real agent was paused. Try Stop, then Share it.",
        actions: [
          { id: "stop", label: "Stop" },
          { id: "resume", label: "Resume this time" },
          { id: "allow", label: "Allow" },
        ],
        feedbackAbout: "the demo",
        /* La démo : sur le téléphone aussi tout de suite, c'est son « waouh » (`cli/wrap/onboarding.ts`). */
        phoneNow: true,
        onChoice: (choice) => ({
          text: choice === "stop" ? `Stopped. ${nova} won't do anything.` : choice === "allow" ? `${nova} may run without Oathrion's protection.` : `${nova} resumed, this time only.`,
          share: tried,
        }),
      });
      return { shown: true, detail: "pause" };
    };
    /* La veille des agents : un agent qui tourne hors d'une prison d'Oathrion, la personne est prévenue. */
    if (process.env.OATHRION_LOCAL_AGENT_WATCH !== "0") {
      const { pauseAgent, pausedHow, resumeAgent, stopAgent, stopRequested, sweepPauseGroups, tellInTerminal } = await import("./local-agent-pause");
      setInterval(() => {
        sweepPauseGroups();
        /* Arrêté par la personne pendant sa pause : dégelé, pour qu'il puisse s'arrêter vraiment (seulement si ce pivot met en pause). */
        if (!pauseOn) return;
        for (const agent of hub.runningAgents()) {
          if (pausedHow(agent.pid) && stopRequested(agent.pid)) {
            resumeAgent(agent.pid);
            hub.events.record({ kind: "stopped", agent: agent.agent, by: "you, from its terminal" });
          }
        }
      }, 3_000).unref();
      /*
       * Un agent hors de la prison, non autorisé là : figé aussitôt, comme un antivirus met en
       * quarantaine (10 novembre, « Oui, en pause »), et la personne décide. Jamais un processus
       * dont ce pivot descend lui-même. `OATHRION_LOCAL_AGENT_PAUSE=0` : seulement prévenir.
       */
      const pauseOn = process.env.OATHRION_LOCAL_AGENT_PAUSE !== "0";
      const ancestors = new Set<number>();
      try {
        for (let pid = process.ppid; pid > 1 && !ancestors.has(pid); ) {
          ancestors.add(pid);
          const stat = (await import("node:fs")).readFileSync(`/proc/${String(pid)}/stat`, "utf8");
          pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        }
      } catch {
        /* hors de Linux : pas de pause de toute façon */
      }
      hub.startAgentWatch((agent) => {
        /* Déjà en pause (un pivot relancé le retrouve) : la personne le sait déjà. */
        if (pausedHow(agent.pid)) return;
        const paused = pauseOn && !ancestors.has(agent.pid) ? pauseAgent(agent.pid) : null;
        const where = `${agent.exe}${agent.script ? ` ${agent.script}` : ""} (process ${String(agent.pid)})`;
        const caught = hub.events.record({ kind: paused ? "paused" : "reported", agent: agent.agent, detail: where });
        if (paused) {
          tellInTerminal(agent.pid, `Oathrion paused ${agent.agent}: it runs outside Oathrion's protection. Decide in the notification or the console: resume it, stop it, or start it again with « oathrion jail -- ${agent.agent} ».`);
        }
        announce({
          custom: true,
          feedId: caught.id,
          id: `outside_${agent.agent}`,
          name: agent.agent,
          /* Court, comme la maquette : le chemin et le processus sont dans la console (« details »). */
          title: paused ? `${face(agent.agent).name} (${agent.agent}) is paused` : `${face(agent.agent).name} (${agent.agent}) runs without Oathrion's protection`,
          description: paused ? "It was running without Oathrion's protection. Nothing is lost." : "It can go around Oathrion. Stop it, or allow it.",
          /* « Stop », le geste sûr, en premier (la maquette du 11 novembre) ; « Allow » : dehors, pour de bon. */
          actions: [
            { id: "stop", label: "Stop" },
            { id: "resume", label: paused ? "Resume this time" : "Leave it this time" },
            { id: "allow", label: "Allow" },
          ],
          feedbackAbout: `${paused ? "paused" : "reported"} ${agent.agent}, running without Oathrion's protection`,
          onChoice: (choice) => {
            const mascot = face(agent.agent).name;
            if (choice === "stop") {
              const stopped = stopAgent(agent.pid);
              if (!stopped) return `${agent.agent} could not be stopped`;
              return { text: `Stopped. ${mascot} won't do anything.`, share: shareOf(hub.events.record({ kind: "stopped", agent: agent.agent, by: "you, from the notification" })) };
            }
            if (choice === "allow") {
              /* Autorisé dehors, pour de bon, en le choisissant ici ; « Stop allowing » dans la console le défait. */
              hub.outsideAllowances.allow(agent.exe, agent.agent, "you, from the notification");
              resumeAgent(agent.pid);
              return { text: `${mascot} may run without Oathrion's protection.`, share: shareOf(hub.events.record({ kind: "allowed", agent: agent.agent, by: "you, from the notification" })) };
            }
            /* Pour cette fois seulement. */
            hub.allowLaunchOnce(agent.launch);
            resumeAgent(agent.pid);
            return {
              text: `${mascot} ${paused ? "resumed" : "left running"}, this time only.`,
              share: shareOf(hub.events.record({ kind: "resumed-once", agent: agent.agent, by: "you, from the notification" })),
            };
          },
        });
      }, knob("OATHRION_LOCAL_AGENT_WATCH_MS"));
    }
    /* Le fil-piège : un leurre lu, par qui que ce soit (agent reconnu ou non), la personne est prévenue. */
    if (process.env.OATHRION_LOCAL_AGENT_WATCH !== "0") {
      hub.startTripwire((event) => {
        const outside = hub.runningAgents().filter((agent) => !agent.jailed);
        const home = process.env.HOME ?? "";
        const shown = home && event.path.startsWith(`${home}/`) ? `~${event.path.slice(home.length)}` : event.path;
        const read = hub.events.record({ kind: "decoy", agent: "decoy", detail: shown });
        announce({
          custom: true,
          danger: true,
          feedId: read.id,
          share: shareOf(read),
          id: `decoy_${event.path}`,
          name: "decoy",
          title: "Something read one of your decoys",
          description: `No honest task does that: ${shown} was read. ${outside.length > 0 ? `Running without Oathrion's protection at that moment: ${outside.map((a) => `${a.agent} (process ${String(a.pid)})`).join(", ")}.` : "No AI agent was running outside the jail at that moment."} If it was you, or a backup or search tool, you can ignore it.`,
          actions: [{ id: "open", label: "See what happened" }],
          feedbackAbout: `reported that ${shown} was read`,
        });
      });
    }
    console.error("[oathrion] local hub ready: servers register on demand.");
    await import("./index");
    return;
  }

  const { readWrapConfig, childEnvironment, bootstrapLocalWorkspace } = await import("./local-bootstrap");
  const config = readWrapConfig(process.env);
  if (config) {
    const { launchWrappedServer } = await import("./gateway/tools/stdio-mcp-tool");
    const { selectAcceptedTools } = await import("./local-pins");
    const stateDir = process.env.OATHRION_LOCAL_STATE_DIR?.trim() || ".";
    let held: { name: string; status: string; changedFields: string[] }[] = [];
    let firstLaunch = false;
    const tool = await launchWrappedServer({
      name: config.name,
      command: config.command,
      args: config.args,
      env: childEnvironment(process.env),
      /*
       * Le dossier où la personne (ou son client) a lancé `oathrion wrap` — pas le dossier
       * d'état, où ce processus tourne : `node ./outils/serveur.js` y serait introuvable.
       */
      cwd: process.env.OATHRION_WRAP_CWD?.trim() || undefined,
      timeoutMs: 60_000,
      /* Étape E5 : seuls les outils dont la définition est acceptée sont inscrits. */
      select: (declared) => {
        const selection = selectAcceptedTools(config.name, stateDir, declared);
        held = selection.held;
        firstLaunch = selection.firstLaunch;
        return selection.accepted;
      },
    });
    stopChild = () => tool.shutdown();
    const shutdown = () => void tool.shutdown();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    const agentKey = process.env.OATHRION_LOCAL_AGENT_KEY?.trim() ?? "";
    if (agentKey.length < 32) throw new Error("OATHRION_LOCAL_AGENT_KEY is missing or too short: the launcher provides it.");
    const port = process.env.PORT?.trim() || "5000";
    const baseUrl = `http://127.0.0.1:${port}`;
    await bootstrapLocalWorkspace({
      server: config.name,
      entries: tool.entries(),
      agentKey,
      approverKey: process.env.OATHRION_LOCAL_APPROVER_KEY?.trim() || undefined,
      baseUrl,
      stateDir,
    });

    const classes = { read: 0, write: 0, destructive: 0 };
    for (const entry of tool.entries()) classes[entry.toolClass] += 1;
    const byName = tool.entries().filter((entry) => entry.readBasis === "name").map((entry) => entry.original);
    const info = tool.childInfo;
    console.error(
      [
        "",
        `[oathrion wrap] server "${config.name}"${info.name ? ` (${info.name}${info.version ? ` ${info.version}` : ""})` : ""}: ` +
          `${String(classes.read)} read(s) allowed, ${String(classes.write)} write(s) on approval, ` +
          `${String(classes.destructive)} destructive tool(s) blocked.`,
        byName.length > 0
          ? `[oathrion wrap] ${String(byName.length)} tool(s) classified as reads from their name alone, as the server does not annotate them: ` +
            `${byName.slice(0, 8).join(", ")}${byName.length > 8 ? ", …" : ""}. A rule in the console can put them under approval.`
          : "",
        firstLaunch
          ? `[oathrion wrap] first launch: the definitions of ${String(tool.entries().length)} tool(s) are pinned. A definition that changes later will be withdrawn until you approve it.`
          : "",
        ...(held.length > 0
          ? [
              `[oathrion wrap] ${String(held.length)} tool(s) WITHDRAWN until you approve: ` +
                held
                  .map((review) => (review.status === "new" ? `${review.name} (new)` : `${review.name} (changed: ${review.changedFields.join(", ")})`))
                  .join(", ") +
                `.`,
              `[oathrion wrap] voir : oathrion tools list --name ${config.name} · accepter : oathrion tools accept --name ${config.name} <outil>`,
            ]
          : []),
        /* Pas de lien à garder : `oathrion console` en imprime un neuf, qui connecte directement. */
        `[oathrion wrap] console: "oathrion console --name ${config.name}" opens it, signed in (${baseUrl}/console).`,
        "",
      ].join("\n"),
    );
  }
  await import("./index");
}

main().catch((error: unknown) => {
  console.error(`[oathrion wrap] cannot start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
