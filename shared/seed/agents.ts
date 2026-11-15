import type { AgentMandate } from "@shared/policy/mandate";
import type { Agent, Permission, PermissionScope, RiskLevel } from "@shared/types";

/** Convenience builder — every field is explicit so mandates read like a contract. */
const M = (m: Partial<AgentMandate> = {}): AgentMandate => ({
  maxTransactionAmount: null,
      currency: "EUR",
  allowedCategories: [],
  blockedCategories: [],
  allowedDomains: [],
  ...m,
});

const P = (
  scope: PermissionScope,
  label: string,
  description: string,
  risk: RiskLevel,
  granted = true,
): Permission => ({ scope, label, description, risk, granted });

export const PERMISSION_CATALOG: Permission[] = [
  P("read:crm", "Read CRM", "Read accounts, contacts and opportunities.", "low", false),
  P("write:crm", "Write CRM", "Create or update CRM records.", "medium", false),
  P("read:email", "Read email", "Read inbox threads the agent is scoped to.", "medium", false),
  P("send:email", "Send email", "Send outbound email on behalf of the org.", "high", false),
  P("read:database", "Read database", "Run read-only queries on analytics replicas.", "medium", false),
  P("write:database", "Write database", "Mutate rows in production databases.", "critical", false),
  P("read:files", "Read files", "Read documents in connected drives.", "low", false),
  P("write:files", "Write files", "Create or edit documents.", "medium", false),
  P("execute:payments", "Execute payments", "Initiate purchases and transfers.", "critical", false),
  P("call:external-api", "Call external APIs", "Reach third-party HTTP endpoints.", "medium", false),
  P("read:analytics", "Read analytics", "Query dashboards and warehouse metrics.", "low", false),
  P("manage:tickets", "Manage tickets", "Create, update and close support tickets.", "medium", false),
  // Scopes for the dangerous verbs declared in `shared/policy/actions.ts`
  // (`publish`/`post`, `execute`, `deploy`). Offered here so an operator can
  // deliberately grant them; ungranted, those verbs are blocked at the
  // permission barrier before any policy runs.
  P("publish:content", "Publish content", "Make content publicly visible.", "high", false),
  P("execute:code", "Execute code", "Run arbitrary code or shell commands.", "critical", false),
  P(
    "deploy:infrastructure",
    "Deploy infrastructure",
    "Ship code or configuration to an environment.",
    "critical",
    false,
  ),
  // The connector scopes (GitHub, Slack, Linear, Stripe). Read and write are split so an
  // agent that summarises a channel or an issue does not carry the right to write.
  P("read:repository", "Read repositories", "Read GitHub repositories, issues and pull requests.", "low", false),
  P("write:repository", "Write repositories", "Open or comment GitHub issues.", "medium", false),
  P("read:chat", "Read chat", "List Slack channels and read recent messages where the bot is invited.", "medium", false),
  P("write:chat", "Post to chat", "Post a message in a Slack channel where the bot is invited.", "medium", false),
  P("read:tasks", "Read tasks", "List Linear teams and read their issues.", "low", false),
  P("write:tasks", "Write tasks", "Create or comment Linear issues.", "medium", false),
  P("read:payments", "Read payments", "Read the balance, payments and customers of a Stripe account.", "medium", false),
  P("mcp:read", "Read through a wrapped MCP server", "Call the read tools of an MCP server wrapped by oathrion wrap.", "low", false),
  P("mcp:write", "Write through a wrapped MCP server", "Call the write tools of an MCP server wrapped by oathrion wrap.", "medium", false),
  P("mcp:destructive", "Destructive tools of a wrapped MCP server", "Delete, pay, run commands: the tools of a wrapped MCP server classed destructive.", "high", false),
];

/** The procurement categories the mandate UI offers. */
export const CATEGORY_CATALOG = [
  "Office supplies",
  "Software",
  "Equipment",
  "Travel",
  "Financial services",
  "Cryptocurrency",
] as const;

export const agents: Agent[] = [
  {
    id: "agt_sales",
    name: "Sales Agent",
    description:
      "Qualifies inbound leads, enriches accounts and drafts follow-ups for the revenue team.",
    provider: "openai",
    model: "gpt-4.1",
    status: "active",
    currentTask: "Analyzing leads",
    owner: "Alex Moreau",
    createdAt: "2026-02-11",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "medium",
    permissions: [
      P("read:crm", "Read CRM", "Read accounts, contacts and opportunities.", "low"),
      P("write:crm", "Write CRM", "Create or update CRM records.", "medium"),
      P("send:email", "Send email", "Send outbound email on behalf of the org.", "high"),
      P("execute:payments", "Execute payments", "Initiate purchases and transfers.", "critical"),
      P("read:analytics", "Read analytics", "Query dashboards and warehouse metrics.", "low"),
    ],
    mandate: M({ maxTransactionAmount: 250,
      currency: "EUR", blockedCategories: ["Cryptocurrency", "Financial services"] }),
    policyIds: ["pol_email_approval", "pol_api_spend"],
    tags: ["revenue", "outbound"],
  },
  {
    id: "agt_procurement",
    name: "Procurement Agent",
    description:
      "Compares supplier quotes, negotiates renewals and files purchase requests above threshold.",
    provider: "anthropic",
    model: "claude-sonnet-4.5",
    status: "active",
    currentTask: "Comparing suppliers",
    owner: "Alex Moreau",
    createdAt: "2026-03-02",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "high",
    permissions: [
      P("read:files", "Read files", "Read documents in connected drives.", "low"),
      P("call:external-api", "Call external APIs", "Reach third-party HTTP endpoints.", "medium"),
      P("execute:payments", "Execute payments", "Initiate purchases and transfers.", "critical"),
      P("send:email", "Send email", "Send outbound email on behalf of the org.", "high"),
    ],
    mandate: M({
      maxTransactionAmount: 500,
      currency: "EUR",
      allowedCategories: ["Office supplies", "Software", "Equipment"],
      blockedCategories: ["Financial services", "Cryptocurrency"],
      allowedDomains: ["amazon.com", "staples.com", "vendor.company.com", "supplier-x.com"],
    }),
    policyIds: ["pol_purchase_limit", "pol_email_approval"],
    tags: ["finance", "vendors"],
  },
  {
    id: "agt_support",
    name: "Support Agent",
    description: "Triages tickets, answers tier-1 questions and escalates when confidence is low.",
    provider: "openai",
    model: "gpt-4.1-mini",
    status: "active",
    currentTask: "Handling tickets",
    owner: "Nadia Sy",
    createdAt: "2026-01-19",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "low",
    permissions: [
      P("manage:tickets", "Manage tickets", "Create, update and close support tickets.", "medium"),
      P("read:files", "Read files", "Read documents in connected drives.", "low"),
      P("send:email", "Send email", "Send outbound email on behalf of the org.", "high"),
      P("execute:payments", "Execute payments", "Initiate purchases and transfers.", "critical"),
    ],
    mandate: M({ maxTransactionAmount: 100,
      currency: "EUR", blockedCategories: ["Cryptocurrency"] }),
    policyIds: ["pol_email_approval"],
    tags: ["support"],
  },
  {
    id: "agt_finance",
    name: "Finance Agent",
    description: "Builds month-end reporting packs and reconciles spend across providers.",
    provider: "google",
    model: "gemini-2.5-pro",
    status: "review",
    currentTask: "Generating report",
    owner: "Ibrahima Fall",
    createdAt: "2026-04-08",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "high",
    permissions: [
      P("read:database", "Read database", "Run read-only queries on analytics replicas.", "medium"),
      P("read:analytics", "Read analytics", "Query dashboards and warehouse metrics.", "low"),
      P("write:files", "Write files", "Create or edit documents.", "medium"),
    ],
    mandate: M({ maxTransactionAmount: 2_000,
      currency: "EUR", blockedCategories: ["Cryptocurrency"] }),
    policyIds: ["pol_db_prod", "pol_api_spend"],
    tags: ["finance", "reporting"],
  },
  {
    id: "agt_data",
    name: "Data Analyst",
    description: "Runs scheduled warehouse queries and keeps executive dashboards fresh.",
    provider: "anthropic",
    model: "claude-haiku-4.5",
    status: "active",
    currentTask: "Processing data",
    owner: "Nadia Sy",
    createdAt: "2026-02-27",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "medium",
    permissions: [
      P("read:database", "Read database", "Run read-only queries on analytics replicas.", "medium"),
      P("read:analytics", "Read analytics", "Query dashboards and warehouse metrics.", "low"),
      P("write:files", "Write files", "Create or edit documents.", "medium"),
      P("execute:payments", "Execute payments", "Initiate purchases and transfers.", "critical"),
    ],
    mandate: M(),
    policyIds: ["pol_db_prod"],
    tags: ["data"],
  },
  {
    id: "agt_recruiting",
    name: "Recruiting Agent",
    description: "Screens applications and schedules interviews with hiring managers.",
    provider: "openai",
    model: "gpt-4.1-mini",
    status: "paused",
    currentTask: null,
    owner: "Alex Moreau",
    createdAt: "2026-05-14",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "low",
    permissions: [
      P("read:email", "Read email", "Read inbox threads the agent is scoped to.", "medium"),
      P("read:files", "Read files", "Read documents in connected drives.", "low"),
    ],
    mandate: M({ maxTransactionAmount: 1_000,
      currency: "EUR", blockedCategories: ["Cryptocurrency"] }),
    policyIds: ["pol_email_approval"],
    tags: ["people"],
  },
  {
    id: "agt_infra",
    name: "Infra Copilot",
    description: "Proposes infrastructure changes and drafts runbooks. Not yet released.",
    provider: "custom",
    model: "internal-llm-v2",
    status: "draft",
    currentTask: null,
    owner: "Ibrahima Fall",
    createdAt: "2026-07-30",
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "critical",
    permissions: [
      P("read:database", "Read database", "Run read-only queries on analytics replicas.", "medium"),
      P("write:database", "Write database", "Mutate rows in production databases.", "critical", false),
    ],
    mandate: M({ maxTransactionAmount: 5_000,
      currency: "EUR", allowedCategories: ["Software", "Equipment"] }),
    policyIds: ["pol_db_prod"],
    tags: ["platform"],
  },
  {
    /*
     * The agent the three reference scenarios act as.
     *
     * It exists rather than reusing `agt_support` for one reason: on
     * `agt_support` the binding constraint on a €750 refund is its own €100
     * mandate ceiling, so the decision is correct but the *explanation* is
     * "the agent's mandate", and the €500 organisation threshold never gets a
     * chance to be the reason. Since the mandate ceiling and the org policy
     * both return APPROVAL_REQUIRED, the outcome would look identical while
     * demonstrating the wrong mechanism.
     *
     * So the ceiling here is set ABOVE the org threshold (€2,000 > €500)
     * deliberately: the mandate stays silent across the whole demonstrated
     * range, and `pol_refund_approval` is unambiguously the rule that decides.
     * The mandate is still present rather than `null`, because a financial verb
     * with no ceiling of any kind trips the engine's "ungoverned money
     * movement" invariant — which is the correct behaviour and not what these
     * scenarios are about.
     *
     * It holds `write:crm` on purpose too. Without that scope, `delete_customer`
     * would be refused at the permission barrier before any policy ran, and the
     * BLOCK scenario would prove that an unauthorised agent is stopped — true,
     * already covered by `rbac.test.ts`, and not the claim being made. Granting
     * the scope forces the denial to come from `pol_customer_deletion` itself.
     */
    id: "agt_billing",
    name: "Billing Agent",
    description:
      "Handles customer billing enquiries and issues refunds within the organisation's refund policy.",
    provider: "anthropic",
    model: "claude-sonnet-4.5",
    status: "active",
    currentTask: "Processing refund requests",
    owner: "Nadia Sy",
    createdAt: "2026-09-02",
    // No activity has been measured for this agent. See the note on the seeded
    // metrics above: these fields are rendered verbatim in the console.
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "high",
    permissions: [
      P("execute:payments", "Execute payments", "Initiate purchases and transfers.", "critical"),
      P("read:crm", "Read CRM", "Read accounts, contacts and opportunities.", "low"),
      P("write:crm", "Write CRM", "Create or update CRM records.", "medium"),
      P("manage:tickets", "Manage tickets", "Create, update and close support tickets.", "medium"),
    ],
    mandate: M({
      maxTransactionAmount: 2_000,
      currency: "EUR",
      blockedCategories: ["Cryptocurrency", "Financial services"],
    }),
    policyIds: ["pol_refund_approval", "pol_customer_deletion"],
    tags: ["billing", "support"],
  },
];

export const PROVIDER_LABEL: Record<Agent["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  custom: "Custom / internal",
};

export const PROVIDER_MODELS: Record<Agent["provider"], string[]> = {
  openai: ["gpt-4.1", "gpt-4.1-mini", "o4-mini"],
  anthropic: ["claude-sonnet-4.5", "claude-haiku-4.5", "claude-opus-4.1"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
  custom: ["internal-llm-v2", "self-hosted-mixtral", "mcp-router"],
};
