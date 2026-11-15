import { cn } from "@/lib/utils";
import type { AgentStatus, ExecutionStatus, PolicyStatus, ApprovalStatus, RiskLevel } from "@/types";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-muted text-muted-foreground",
};

export function Pill({
  tone = "neutral",
  children,
  dot = false,
  className,
  ...rest
}: {
  tone?: Tone;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const AGENT_TONE: Record<AgentStatus, { tone: Tone; label: string }> = {
  active: { tone: "success", label: "Active" },
  paused: { tone: "neutral", label: "Paused" },
  draft: { tone: "info", label: "Draft" },
  review: { tone: "warning", label: "To review" },
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const s = AGENT_TONE[status];
  return (
    <Pill tone={s.tone} dot data-testid={`status-agent-${status}`}>
      {s.label}
    </Pill>
  );
}

const EXEC_TONE: Record<ExecutionStatus, { tone: Tone; label: string }> = {
  allowed: { tone: "success", label: "Allowed" },
  blocked: { tone: "danger", label: "Blocked" },
  pending: { tone: "warning", label: "Pending" },
  failed: { tone: "neutral", label: "Failed" },
};

export function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  const s = EXEC_TONE[status];
  return (
    <Pill tone={s.tone} dot data-testid={`status-execution-${status}`}>
      {s.label}
    </Pill>
  );
}

const RISK_TONE: Record<RiskLevel, Tone> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
};

const RISK_LABEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return (
    <Pill tone={RISK_TONE[risk]} data-testid={`status-risk-${risk}`}>
      {RISK_LABEL[risk] ?? risk}
    </Pill>
  );
}

const POLICY_TONE: Record<PolicyStatus, { tone: Tone; label: string }> = {
  enabled: { tone: "success", label: "Active" },
  disabled: { tone: "neutral", label: "Disabled" },
  draft: { tone: "info", label: "Draft" },
};

export function PolicyStatusBadge({ status }: { status: PolicyStatus }) {
  const s = POLICY_TONE[status];
  return <Pill tone={s.tone} dot>{s.label}</Pill>;
}

const APPROVAL_TONE: Record<ApprovalStatus, { tone: Tone; label: string }> = {
  pending: { tone: "warning", label: "To approve" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
  /*
   * Neutral, not `danger`: nothing went wrong and nobody refused anything — the
   * window closed. Colouring it like a rejection would tell an operator a human
   * made a decision that no human made.
   */
  expired: { tone: "neutral", label: "Expired" },
};

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  const s = APPROVAL_TONE[status];
  return <Pill tone={s.tone} dot>{s.label}</Pill>;
}
