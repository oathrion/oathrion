import { plainAction } from "@/lib/plain-action";
import { cn } from "@/lib/utils";

/** Ce qu'un agent a fait, en mots, puis le code exact en petit (`lib/plain-action.ts`). */
export function ActionWords({ action, target, className }: { action: string; target: string; className?: string }) {
  const { title, detail } = plainAction(action, target);
  return (
    <div className={cn("min-w-0", className)}>
      <p className="truncate text-[14px] font-medium" title={action}>
        {title}
      </p>
      {detail ? (
        <p className="truncate text-[12px] text-muted-foreground" title={detail}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}
