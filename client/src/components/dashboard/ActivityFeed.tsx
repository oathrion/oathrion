import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/common/primitives";
import type { ActivityEvent } from "@/types";

const DOT: Record<ActivityEvent["kind"], string> = {
  success: "bg-success",
  pending: "bg-warning",
  blocked: "bg-danger",
  info: "bg-info",
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet"
        description="Your agents' events will show up here as soon as they get to work."
      />
    );
  }

  return (
    <ol className="divide-y divide-card-border" data-testid="list-activity">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3 px-5 py-3.5">
          <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
            <span className={cn("h-2 w-2 rounded-full", DOT[e.kind])} />
            {e.kind === "pending" && (
              <span className={cn("absolute inline-flex h-2 w-2 animate-ping rounded-full opacity-60", DOT[e.kind])} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-snug">{e.actor}</p>
            <p className="truncate text-sm text-muted-foreground">{e.message}</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{e.at}</span>
        </li>
      ))}
    </ol>
  );
}
