import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Plug,
  ShieldAlert,
  Gauge,
  BarChart3, MessageSquare,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  Terminal,
  Plus,
  LogOut,
  Rocket,
  History,
  FileSignature,
  ChevronRight,
  IdCard,
  Monitor,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoLockup, Logo } from "@/components/layout/Logo";
import { useAuth } from "@/lib/auth";
import { useLocalMode } from "@/lib/local-mode";
import { getLocalSettings, listRunningAgents } from "@/lib/api";
import { useARIA } from "@/lib/store";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

export function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const [location] = useLocation();
  const { approvals } = useARIA();
  const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
  const { identity, role, signOut, can } = useAuth();
  const canManage = can("manage");
  const local = useLocalMode();
  const signedInAs = identity?.name ?? "Operator";

  const items: NavItem[] = [
    /* Le démarrage guidé : connecter les outils, choisir le périmètre, vérifier. */
    { href: "/onboarding", label: "Get started", icon: Rocket },
    /*
     * EN PREMIER, et c'est le changement d'accent de ce chantier. Oathrion est un pare-feu
     * de gouvernance : l'écran qu'un opérateur garde ouvert est le journal d'interception
     * et la file d'approbation, pas un tableau de bord d'indicateurs.
     */
    { href: "/firewall", label: "Firewall", icon: ShieldAlert },
    /*
     * Juste après : « où en suis-je, et que faire ensuite ». C'est l'écran qu'un
     * exploitant ouvre le deuxième jour, et celui qui décide s'il peut passer en pilote.
     */
    { href: "/coverage", label: "Coverage", icon: Gauge },
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/executions", label: "Executions", icon: Terminal },
    { href: "/policies", label: "Policies", icon: ShieldCheck },
    { href: "/approvals", label: "Approvals", icon: ScrollText, badge: pendingApprovals },
    /* Le mandat vérifiable : ce que les agents peuvent faire au nom de l'organisation, signé par des personnes. */
    { href: "/mandates", label: "Mandates", icon: FileSignature },
    /*
     * « Connecteurs » est l'écran RÉEL : chaque état y vient d'un appel au fournisseur.
     * « Integrations » reste accessible par son URL mais quitte la navigation : il
     * n'affiche qu'un catalogue décoratif dont le bouton bascule un booléen, et le garder
     * à côté du vrai écran ferait lire « Connected » comme une connexion.
     */
    { href: "/connectors", label: "Connectors", icon: Plug },
    { href: "/analytics", label: "Analytics", icon: BarChart3 },
    { href: "/feedback", label: "Your feedback", icon: MessageSquare },
    { href: "/settings", label: "Settings", icon: Settings },
  ];
  /*
   * En local (`oathrion wrap`), depuis le 23 novembre, la console tourne autour du PASSEPORT de
   * chaque agent (`notes/CONSTRUCTION-CONSOLE-PASSEPORT.md`) : les passeports (l'accueil, et la page
   * de chaque agent, où vivent son fil, ses règles et ses reçus), les décisions qui attendent, la
   * machine (ce qui est couvert), et les retours. Le reste est rangé sous « Details », replié.
   */
  const localItems: NavItem[] = [
    { href: "/home", label: "Passports", icon: IdCard },
    { href: "/approvals", label: "Decisions", icon: ScrollText, badge: pendingApprovals },
    { href: "/protection", label: "This machine", icon: Monitor },
    /* 16 novembre : « la qualité du logiciel sera celle des retours » ; toujours à portée. */
    { href: "/feedback", label: "Send feedback", icon: MessageSquare },
  ];
  /*
   * 16 novembre (la passe de concentration) : un développeur seul avec son agent n'a que faire des
   * exécutions brutes, des statistiques, de l'équipe ou des réglages d'organisation ; ils lui
   * disaient « ce produit n'est pas pour moi ». Les pages existent toujours ; « Your team » est un
   * lien dans les réglages.
   */
  const localDetails: NavItem[] = [
    { href: "/settings", label: "Settings", icon: Settings },
    { href: "/activity", label: "Activity", icon: History },
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/servers", label: "Servers", icon: Plug },
    { href: "/policies", label: "Policies", icon: ShieldCheck },
  ];
  const shown = local ? localItems : items;
  /* « Details » s'ouvre tout seul quand on est sur l'une de ses pages. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inDetails = local && localDetails.some((item) => location === item.href || location.startsWith(`${item.href}/`));

  const isActive = (href: string) =>
    location === href ||
    location.startsWith(`${href}/`) ||
    (href === "/onboarding" && location === "/") ||
    (local && href === "/home" && location.startsWith("/passport/"));

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-[248px]",
      )}
      data-testid="nav-sidebar"
    >
      <div
        className={cn(
          "flex h-16 items-center border-b border-sidebar-border px-4",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {collapsed ? (
          <Logo className="h-7 w-7" />
        ) : (
          <>
            <LogoLockup />
            <button
              onClick={onToggle}
              aria-label="Collapse the menu"
              data-testid="button-collapse-sidebar"
              className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lg:block"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {canManage && !local && (
        <div className={cn("px-3 pt-4", collapsed && "px-2")}>
          <Link
            href="/agents/new"
          onClick={onNavigate}
          data-testid="link-new-agent-sidebar"
          className={cn(
            "flex h-9 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
            collapsed ? "w-full px-0" : "w-full px-3",
          )}
          title="New agent"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {!collapsed && <span>New agent</span>}
          </Link>
        </div>
      )}

      <nav className={cn("mt-4 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4", collapsed && "px-2")}>
        {shown.map(({ href, label, icon: Icon, badge }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              data-testid={`link-nav-${href.slice(1)}`}
              aria-current={active ? "page" : undefined}
              title={collapsed ? label : undefined}
              className={cn(
                "group relative flex h-9 items-center gap-3 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                collapsed ? "justify-center px-0" : "px-3",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-foreground/70 hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              {/* Le menu déplié n'a que des mots : une icône par entrée était le décor « tableau de bord IA » de série. Replié, l'icône reste le seul repère. */}
              {collapsed ? <Icon className={cn("h-4 w-4 shrink-0", active ? "text-sidebar-primary" : "text-muted-foreground group-hover:text-foreground")} aria-hidden /> : null}
              {!collapsed && <span className="truncate">{label}</span>}
              {!collapsed && badge ? (
                <span className="ml-auto rounded-full bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold tabular text-warning">
                  {badge}
                </span>
              ) : null}
              {collapsed && badge ? (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warning" />
              ) : null}
            </Link>
          );
        })}
        {local && !collapsed ? (
          <div className="pt-3">
            <button
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={detailsOpen || inDetails}
              data-testid="button-nav-details"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", (detailsOpen || inDetails) && "rotate-90")} aria-hidden />
              Details
            </button>
            {detailsOpen || inDetails
              ? localDetails.map(({ href, label }) => {
                  const active = isActive(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onNavigate}
                      data-testid={`link-nav-${href.slice(1)}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex h-8 items-center gap-3 rounded-lg pl-8 pr-3 text-[13px] transition-colors",
                        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/60 hover:bg-sidebar-accent/60 hover:text-foreground",
                      )}
                    >
                      <span className="truncate">{label}</span>
                    </Link>
                  );
                })
              : null}
          </div>
        ) : null}
      </nav>

      {local ? (
        <div className={cn("border-t border-sidebar-border p-3", collapsed && "p-2")}>
          <ProtectionStatus collapsed={collapsed} onNavigate={onNavigate} />
          {collapsed ? (
            <button
              onClick={onToggle}
              aria-label="Expand the menu"
              data-testid="button-expand-sidebar"
              className="mx-auto mt-2 block rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : (
      <div className={cn("border-t border-sidebar-border p-3", collapsed && "p-2")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={onToggle}
              aria-label="Expand the menu"
              data-testid="button-expand-sidebar"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
              {signedInAs.slice(0, 1)}
            </span>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-sidebar-border bg-background/60 px-3 py-2.5">
              {/*
                This block used to print a fixture organisation ("Acme Corp",
                plan "Enterprise") on every screen, with nothing marking it as
                invented — a pilot operator had no way to tell it was not their
                own tenant. The control plane has no organisation record, so
                there is nothing truthful to show here and the panel now names
                the signed-in identity only.
              */}
              <p className="text-xs font-medium text-muted-foreground">
                Signed in
              </p>
            </div>
            <div className="mt-2 flex items-center gap-2.5 rounded-lg px-2 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                {signedInAs.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" data-testid="text-identity-name">
                  {signedInAs}
                </p>
                <p className="text-xs capitalize text-muted-foreground" data-testid="text-identity-role">
                  {role ?? "—"}
                </p>
              </div>
              <button
                onClick={signOut}
                aria-label="Sign out"
                title="Sign out"
                data-testid="button-sign-out"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
      )}
    </aside>
  );
}

/**
 * En local, au pied du menu : d'un coup d'œil, la machine est-elle protégée (11 novembre) ?
 * Vert : la veille tourne et aucun agent n'attend hors de la prison ; ambre sinon, avec ce qui
 * manque. Un clic mène à « Protection ».
 */
function ProtectionStatus({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const settings = useQuery({ queryKey: ["/api/local/settings"], queryFn: getLocalSettings, retry: false, refetchInterval: 15_000 });
  const running = useQuery({ queryKey: ["/api/local/agents/running"], queryFn: listRunningAgents, retry: false, refetchInterval: 5_000 });
  if (!settings.data) return null;
  const agents = running.data ?? [];
  const waiting = agents.filter((a) => a.paused || (!a.jailed && !a.allowedOutside && !a.allowedOnce)).length;
  /* La veille n'existe que sous Linux : ailleurs, son absence n'est pas un avertissement permanent qu'on ne peut pas lever. */
  const linux = (settings.data.platform ?? "linux") === "linux";
  const watching = !linux || settings.data.watch.on;
  const good = watching && waiting === 0;
  const text = !watching
    ? "Agents without Oathrion are not watched"
    : waiting > 0
      ? `${String(waiting)} agent${waiting > 1 ? "s" : ""} waiting for you`
      : !linux
        ? "Protected · Oathrion is on"
        : agents.length > 0
          ? `Protected · ${String(agents.length)} agent${agents.length > 1 ? "s" : ""} watched`
          : "Protected · watching";
  return (
    <Link
      href={waiting > 0 ? "/home" : "/protection"}
      onClick={onNavigate}
      title={collapsed ? text : undefined}
      data-testid="protection-status"
      className={cn(
        "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] font-medium transition-colors",
        good ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300",
        collapsed && "justify-center px-0",
      )}
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {good ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" /> : null}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", good ? "bg-emerald-400" : "bg-amber-400")} />
      </span>
      {!collapsed && <span className="truncate">{text}</span>}
    </Link>
  );
}
