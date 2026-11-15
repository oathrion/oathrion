/**
 * LE PARCOURS GUIDÉ (12 novembre 2026, « le graal du parcours utilisateur ») : après
 * `npx oathrion`, plus aucune commande à taper, rien à deviner. Chaque étape d'une touche :
 *
 *   · relancer son client : Oathrion attend, et dit « ✓ protégé » dès qu'il revient ;
 *   · voir Oathrion arrêter un agent (la démo, avec la fenêtre et le son) ;
 *   · décider depuis son téléphone, partout (Telegram : BotFather s'ouvre sur l'ordinateur, où
 *     copier le jeton est facile ; puis le QR code, puis « Start »).
 *
 * Entrée pour oui, « n » pour plus tard ; sans terminal, avec `--yes`, ou pour `--undo`, rien
 * n'est demandé (`cli/bin.ts`).
 */

export interface OnboardingIo {
  out: (line: string) => void;
  /** Une réponse tapée ; `null` sans terminal (alors on s'arrête là). */
  ask: (question: string) => Promise<string | null>;
  /** Le jeton, tapé sans écho. */
  askSecret: (question: string) => Promise<string | null>;
  /** `oathrion demo` : la notification de Nova, sur l'ordinateur (et le téléphone s'il est appairé). */
  demo: (quiet: boolean) => Promise<number>;
  /** `oathrion phone telegram <jeton>`. */
  pairPhone: (token: string) => Promise<number>;
  phonePaired: () => boolean;
  /** Les clients à relancer (`npx oathrion` les a nommés) ; vide : rien à attendre. */
  restart: string[];
  /** Attendre qu'un client relancé passe par Oathrion ; Entrée passe. */
  waitForAgent: (question: string) => Promise<"seen" | "skip" | "timeout">;
  /** Ouvrir une adresse dans le navigateur de l'ordinateur. */
  open: (url: string) => void;
}

const later = (answer: string | null) => answer === null || /^(n|no|non|later|plus tard)$/i.test(answer.trim());

const named = (clients: string[]) => (clients.length > 1 ? `${clients.slice(0, -1).join(", ")} or ${clients[clients.length - 1]}` : clients[0] ?? "your agent");

export async function runOnboarding(io: OnboardingIo): Promise<number> {
  const steps = (io.restart.length > 0 ? 1 : 0) + 2;
  let at = 0;
  const step = () => `${String((at += 1))}/${String(steps)} ·`;
  io.out("");
  io.out("A minute more, nothing to type: Enter to go, n for later.");
  io.out("");

  /* 0. Relancer son client : sans ça, rien n'est encore protégé — et la personne ne le saurait pas. */
  if (io.restart.length > 0) {
    /* Claude Code en ligne de commande se « relance » en ouvrant une nouvelle session. */
    const apps = io.restart.filter((c) => c !== "Claude Code");
    const claude = io.restart.includes("Claude Code");
    const verb = apps.length === 0 ? "Start a new Claude Code session" : `Restart ${named(apps)}${claude ? ", or start a new Claude Code session" : ""}`;
    const seen = await io.waitForAgent(`${step()} ${verb}: I will tell you when it is protected (Enter to skip) `);
    if (seen === "seen") io.out("      ✓ Protected: your agent's calls now go through Oathrion.");
    else if (seen === "timeout") io.out("      Not seen yet: it is protected as soon as you restart it.");
    io.out("");
  }

  /* 1. Le premier « waouh » : sans attendre qu'un vrai agent agisse. */
  const see = await io.ask(`${step()} See Oathrion stop an AI agent (a pretend one: nothing real is touched) [Enter] `);
  if (see === null) return 0;
  if (!later(see)) {
    if ((await io.demo(false)) === 0) {
      await io.ask("      When you have clicked « Stop » in the notification, press Enter. ");
    }
  }

  /* 2. Le téléphone : la machine peut rester à la maison. */
  io.out("");
  if (io.phonePaired()) {
    io.out(`${step()} ✓ Your phone is already paired: requests reach you on Telegram, anywhere.`);
  } else {
    const phone = await io.ask(`${step()} Decide from your phone, anywhere, even with this computer left at home (Telegram) [Enter] `);
    if (phone === null) return 0;
    if (!later(phone)) {
      /* Le jeton se copie mal d'un téléphone vers un ordinateur : BotFather s'ouvre ici. */
      io.open("https://t.me/BotFather");
      io.out("      BotFather opens on this computer (Telegram, or « Open in Web »): send /newbot,");
      io.out("      pick a name, then a username ending in « bot ». Copy the token it gives you.");
      const token = (await io.askSecret("      Paste the token here, it is not shown (Enter to do it later): "))?.trim() ?? "";
      if (token !== "") {
        if ((await io.pairPhone(token)) === 0) {
          /* Le « waouh » du téléphone : la même démo, cette fois aussi dans la poche. */
          if ((await io.demo(true)) === 0) io.out("      Look at your phone: Nova is paused there too. Tap « Stop » in Telegram.");
        }
      } else {
        io.out("      Later: oathrion phone telegram");
      }
    } else {
      io.out("      Later: oathrion phone telegram");
    }
  }

  io.out("");
  io.out("✓ Oathrion is set up. You can forget about it: it tells you when something needs you.");
  return 0;
}
