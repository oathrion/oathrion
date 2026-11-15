import { useEffect } from "react";
import { useLocation } from "wouter";
import { Bot, ScrollText, ShieldCheck, Terminal } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useARIA } from "@/lib/store";

export function GlobalSearch({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const { agents, executions, policies, approvals } = useARIA();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const go = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* cmdk only filters mounted items, so results must not be truncated before search. */}
      <CommandInput placeholder="Search agents, executions, policies…" data-testid="input-global-search" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Agents">
          {agents.map((a) => (
            <CommandItem key={a.id} value={`agent ${a.name}`} onSelect={() => go(`/agents/${a.id}`)}>
              <Bot className="mr-2 h-4 w-4 text-muted-foreground" />
              {a.name}
              <span className="ml-auto text-xs text-muted-foreground">{a.model}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Executions">
          {executions.map((e) => (
            <CommandItem
              key={e.id}
              value={`execution ${e.action} ${e.agentName} ${e.id}`}
              onSelect={() => go(`/executions/${e.id}`)}
            >
              <Terminal className="mr-2 h-4 w-4 text-muted-foreground" />
              {e.action}
              <span className="ml-auto text-xs text-muted-foreground">{e.agentName}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Policies">
          {policies.map((p) => (
            <CommandItem key={p.id} value={`policy ${p.name}`} onSelect={() => go("/policies")}>
              <ShieldCheck className="mr-2 h-4 w-4 text-muted-foreground" />
              {p.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Approvals">
          {approvals.map((a) => (
            <CommandItem
              key={a.id}
              value={`approval ${a.title} ${a.agentName}`}
              onSelect={() => go("/approvals")}
            >
              <ScrollText className="mr-2 h-4 w-4 text-muted-foreground" />
              {a.title}
              <span className="ml-auto text-xs text-muted-foreground">{a.agentName}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
