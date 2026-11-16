import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Bell, Menu, Moon, Search, Sun, X } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { useTheme } from "@/lib/theme";
import { useARIA } from "@/lib/store";
import { getOrganization } from "@/lib/api";
import { cn } from "@/lib/utils";

const TITLES: { match: (p: string) => boolean; label: string }[] = [
  { match: (p) => p === "/" || p.startsWith("/onboarding"), label: "Get started" },
  { match: (p) => p.startsWith("/home"), label: "Home" },
  { match: (p) => p.startsWith("/share"), label: "Share" },
  { match: (p) => p.startsWith("/dashboard"), label: "Dashboard" },
  { match: (p) => p.startsWith("/agents"), label: "Agents" },
  { match: (p) => p.startsWith("/executions"), label: "Executions" },
  { match: (p) => p.startsWith("/policies"), label: "Policies" },
  { match: (p) => p.startsWith("/approvals"), label: "Approvals" },
  { match: (p) => p.startsWith("/firewall"), label: "Firewall" },
  { match: (p) => p.startsWith("/coverage"), label: "Coverage" },
  { match: (p) => p.startsWith("/connectors"), label: "Connectors" },
  { match: (p) => p.startsWith("/integrations"), label: "Integrations (catalogue)" },
  { match: (p) => p.startsWith("/analytics"), label: "Analytics" },
  { match: (p) => p.startsWith("/feedback"), label: "Feedback" },
  { match: (p) => p.startsWith("/settings"), label: "Settings" },
  { match: (p) => p.startsWith("/activity"), label: "Activity" },
  { match: (p) => p.startsWith("/protection"), label: "Protection" },
  { match: (p) => p.startsWith("/mandates"), label: "Mandates" },
  { match: (p) => p.startsWith("/servers"), label: "Servers" },
  { match: (p) => p.startsWith("/team"), label: "Your team" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [location] = useLocation();
  const { theme, toggle } = useTheme();
  const { approvals } = useARIA();
  const pending = approvals.filter((a) => a.status === "pending").length;
  const crumb = TITLES.find((t) => t.match(location))?.label ?? "Oathrion";
  /*
   * Le nom de l'organisation RÉELLE. Ce fil d'Ariane affichait « Acme Corp » en dur, sur
   * tous les espaces : le premier écran d'un client lui montrait le nom d'un autre.
   */
  const organization = useQuery({ queryKey: ["/api/organization"], queryFn: getOrganization });

  return (
    <div className="oath-backdrop flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px]"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 animate-in-up">
            <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} />
          </div>
          <button
            aria-label="Close the menu"
            onClick={() => setMobileOpen(false)}
            className="absolute right-4 top-4 rounded-md bg-background p-2 shadow-md"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background/40 px-4 backdrop-blur-xl backdrop-saturate-150 md:px-8">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open the menu"
            data-testid="button-open-nav"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="h-4 w-4" />
          </button>

          <nav aria-label="Fil d'Ariane" className="hidden min-w-0 items-center gap-2 text-sm md:flex">
            <span className="text-muted-foreground">{organization.data?.name ?? ""}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium">{crumb}</span>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setSearchOpen(true)}
              data-testid="button-open-search"
              className="group flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <Search className="h-4 w-4" aria-hidden />
              <span className="hidden lg:inline">Search agents, executions, policies…</span>
              <kbd className="ml-2 hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] lg:inline">
                ⌘K
              </kbd>
            </button>

            <Link
              href="/approvals"
              aria-label={`Approvals: ${pending} pending`}
              data-testid="link-notifications"
              className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <Bell className="h-4 w-4" />
              {pending > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warning ring-2 ring-background" />
              )}
            </Link>

            <button
              onClick={toggle}
              aria-label="Change theme"
              data-testid="button-toggle-theme"
              className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <main className={cn("flex-1 overflow-y-auto")}>
          <div className="mx-auto w-full max-w-[1440px] px-4 py-8 md:px-8 md:py-10">{children}</div>
        </main>
      </div>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
