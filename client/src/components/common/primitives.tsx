import { ArrowDownRight, ArrowUpRight, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/* ── Surface ─────────────────────────────────────────────────────── */

export function Surface({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-card-border bg-card shadow-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Surface className={cn("overflow-hidden", className)}>
      <div className="flex items-start justify-between gap-4 border-b border-card-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className={cn(bodyClassName)}>{children}</div>
    </Surface>
  );
}

/* ── PageHeader ──────────────────────────────────────────────────── */

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.025em]" data-testid="text-page-title">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[15px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ── StatCard ────────────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  delta,
  deltaLabel,
  icon: Icon,
  tone = "neutral",
  betterWhen = "up",
  testId,
}: {
  label: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  icon?: LucideIcon;
  tone?: "neutral" | "danger";
  betterWhen?: "up" | "down";
  testId?: string;
}) {
  const improving = betterWhen === "down" ? (delta ?? 0) <= 0 : (delta ?? 0) >= 0;
  const DeltaIcon = (delta ?? 0) >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <Surface className="p-5" data-testid={testId}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {Icon && (
          <Icon
            className={cn(
              "h-4 w-4",
              tone === "danger" ? "text-danger" : "text-muted-foreground/70",
            )}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight tabular">{value}</div>
      {(delta !== undefined || deltaLabel) && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          {delta !== undefined && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-medium",
                improving ? "text-success" : "text-danger",
              )}
            >
              <DeltaIcon className="h-3.5 w-3.5" aria-hidden />
              {Math.abs(Math.round(delta * 10) / 10)}%
            </span>
          )}
          <span className="text-muted-foreground">{deltaLabel ?? "vs. yesterday"}</span>
        </div>
      )}
    </Surface>
  );
}

export function StatCardSkeleton() {
  return (
    <Surface className="p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-4 h-7 w-20" />
      <Skeleton className="mt-3 h-3 w-32" />
    </Surface>
  );
}

/* ── SearchInput ─────────────────────────────────────────────────── */

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  testId = "input-search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testId}
        aria-label={placeholder}
        className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
      />
    </div>
  );
}

/* ── EmptyState ──────────────────────────────────────────────────── */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}
      data-testid="state-empty"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-muted/60">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ── ErrorState ──────────────────────────────────────────────────── */

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-danger/25 bg-danger-soft px-6 py-12 text-center"
      data-testid="state-error"
    >
      <h3 className="text-sm font-semibold text-danger">Something went wrong</h3>
      <p className="mt-1 max-w-sm text-sm text-danger/80">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          data-testid="button-retry"
          className="mt-5 rounded-lg border border-danger/30 bg-background px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/* ── Table skeleton ──────────────────────────────────────────────── */

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-card-border" data-testid="state-loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-4 px-5 py-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={c === 0 ? "h-4 w-3/4" : "h-4 w-1/2"} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── FilterTabs ──────────────────────────────────────────────────── */

export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-[10px] bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          data-testid={`button-filter-${o.value}`}
          aria-pressed={value === o.value}
          className={cn(
            "rounded-lg px-3 py-1 text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            value === o.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined && (
            <span className="ml-1.5 tabular text-muted-foreground">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ── KeyValue ────────────────────────────────────────────────────── */

export function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
