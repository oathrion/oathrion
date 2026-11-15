/**
 * LES RÉGLAGES DE LA CONSOLE LOCALE (11 novembre : « enlever tout ce qui rend l'expérience
 * complexe ») : l'état de chaque protection de la machine, en une page. Les notifications se
 * règlent ici d'un clic ; la veille, la prison par défaut et les leurres se posent par une
 * commande, que la page donne (ils installent des services et des fichiers). L'organisation, les
 * membres, les clés API : « Details », « Advanced settings ».
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Bell, Eye, KeyRound, ShieldCheck, Smartphone, Users } from "lucide-react";

import { PageHeader, Surface } from "@/components/common/primitives";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getLocalSettings, setDesktopNotifications } from "@/lib/api";
import { cn } from "@/lib/utils";

function Row({ icon: Icon, title, state, on, children }: { icon: typeof Bell; title: string; state: string; on: boolean; children: React.ReactNode }) {
  return (
    <Surface className="flex items-start gap-4 p-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-sidebar-primary ring-1 ring-inset ring-primary/25">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", on ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>{state}</span>
        </p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </Surface>
  );
}

const Command = ({ children }: { children: string }) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>;

export default function LocalSettingsPage() {
  const settings = useQuery({ queryKey: ["/api/local/settings"], queryFn: getLocalSettings });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const data = settings.data;
  /* La veille et la prison n'existent que sous Linux : ailleurs, ce n'est pas « Off » à allumer. */
  const linux = (data?.platform ?? "linux") === "linux";

  const toggleDesktop = async (desktop: boolean) => {
    try {
      await setDesktopNotifications(desktop);
      await queryClient.invalidateQueries({ queryKey: ["/api/local/settings"] });
    } catch (error) {
      toast({ title: "That did not work", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="How Oathrion protects this machine." />
      {data ? (
        <div className="space-y-3">
          <Row icon={Bell} title="Notifications" state={data.notifications.desktop ? "On" : "Off"} on={data.notifications.desktop}>
            <div className="flex items-center justify-between gap-3">
              <span>Oathrion's window, with your agent's mascot: decide without opening the console.{data.notifications.slack ? " Also on Slack." : ""}</span>
              <Switch checked={data.notifications.desktop} onCheckedChange={(value) => void toggleDesktop(value)} aria-label="Desktop notifications" data-testid="switch-desktop-notifications" />
            </div>
          </Row>
          <Row icon={Smartphone} title="Your phone" state={data.phone?.paired ? "Paired" : "Not paired"} on={data.phone?.paired === true}>
            {data.phone?.paired ? (
              <>Requests reach you on Telegram (@{data.phone.bot}), with Approve and Reject, anywhere. To unpair: <Command>oathrion phone off</Command></>
            ) : (
              <>Leave your computer at home and decide from your phone, on Telegram: <Command>oathrion phone telegram</Command> (it asks for the token of a bot made with @BotFather).</>
            )}
          </Row>
          <Row icon={Eye} title="The agent watch" state={!linux ? "Linux only, for now" : data.watch.on ? "On, all the time" : "Off"} on={data.watch.on}>
            {!linux ? (
              <>Not on this system yet. Here, your agents' actions go through Oathrion's approvals and receipts.</>
            ) : data.watch.on ? (
              <>An AI agent running outside the jail is paused, and you are asked. To turn it off: <Command>oathrion watch --always --undo</Command></>
            ) : (
              <>Like an antivirus for AI agents: <Command>npx oathrion</Command> turns it on.</>
            )}
          </Row>
          <Row icon={ShieldCheck} title="The jail, by default" state={!linux ? "Linux only, for now" : data.jail.agents.length > 0 ? data.jail.agents.join(", ") : "Off"} on={data.jail.agents.length > 0}>
            {!linux ? (
              <>Not on this system yet: it is built on a Linux sandbox (bubblewrap).</>
            ) : data.jail.agents.length > 0 ? (
              <>Typed in a terminal, these agents start where they cannot go around Oathrion. To undo: <Command>oathrion jail --always --undo</Command></>
            ) : (
              <>Your agents start where they cannot reach your secrets: <Command>npx oathrion</Command> sets it up (Linux).</>
            )}
          </Row>
          <Row icon={KeyRound} title="Decoys" state={data.decoys.count > 0 ? `${String(data.decoys.count)} laid` : "None"} on={data.decoys.count > 0}>
            {data.decoys.count > 0 ? (
              <>Fake secrets no honest task reads: you are told when anything does. To take them away: <Command>oathrion decoys remove</Command></>
            ) : (
              <>Fake secrets no honest task reads, and you are told when anything does: <Command>oathrion decoys plant</Command></>
            )}
          </Row>
          <Row icon={Users} title="For a team" state="Available" on={false}>
            Someone else approves, from Slack or their phone; receipts for your auditor or bank. <Link href="/team" className="text-primary underline-offset-2 hover:underline">See what it adds</Link>
          </Row>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{settings.isError ? "The settings could not be read." : "Reading…"}</p>
      )}
    </div>
  );
}
