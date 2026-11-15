import type { Execution } from "@shared/types";

export const executions: Execution[] = [
  {
    "id": "exe_7100",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Draft reply",
    "target": "zendesk.Ticket/44133",
    "status": "allowed",
    "risk": "low",
    "durationMs": 3543,
    "cost": 0.227,
    "timestamp": "2026-08-09T01:42:00Z",
    "input": {
      "scope": "manage:tickets",
      "payloadBytes": 3205,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T01:42:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Draft reply \u2192 zendesk.Ticket/44133"
      },
      {
        "at": "2026-08-09T01:42:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T01:42:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:42:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7101",
    "agentId": "agt_data",
    "agentName": "Data Analyst",
    "action": "Run scheduled query",
    "target": "warehouse.dim_customer",
    "status": "allowed",
    "risk": "low",
    "durationMs": 1892,
    "cost": 0.033,
    "timestamp": "2026-08-09T01:32:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 953,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T01:32:00Z",
        "actor": "Data Analyst",
        "event": "execution.requested",
        "detail": "Run scheduled query \u2192 warehouse.dim_customer"
      },
      {
        "at": "2026-08-09T01:32:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T01:32:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:32:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7102",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Enrich account",
    "target": "salesforce.Account/8842",
    "status": "allowed",
    "risk": "low",
    "durationMs": 2578,
    "cost": 0.169,
    "timestamp": "2026-08-09T01:24:00Z",
    "input": {
      "scope": "read:crm",
      "payloadBytes": 2021,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T01:24:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Enrich account \u2192 salesforce.Account/8842"
      },
      {
        "at": "2026-08-09T01:24:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T01:24:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:24:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7103",
    "agentId": "agt_data",
    "agentName": "Data Analyst",
    "action": "Run scheduled query",
    "target": "warehouse.dim_customer",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 2394,
    "cost": 0.053,
    "timestamp": "2026-08-09T01:20:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 2737,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T01:20:00Z",
        "actor": "Data Analyst",
        "event": "execution.requested",
        "detail": "Run scheduled query \u2192 warehouse.dim_customer"
      },
      {
        "at": "2026-08-09T01:20:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T01:20:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:20:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7104",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Send follow-up email",
    "target": "mail:priya@northwind.io",
    "status": "allowed",
    "risk": "high",
    "durationMs": 2423,
    "cost": 0.3,
    "timestamp": "2026-08-09T01:14:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 4833,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T01:14:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Send follow-up email \u2192 mail:priya@northwind.io"
      },
      {
        "at": "2026-08-09T01:14:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-09T01:14:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:14:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7105",
    "agentId": "agt_data",
    "agentName": "Data Analyst",
    "action": "Run scheduled query",
    "target": "warehouse.dim_customer",
    "status": "failed",
    "risk": "medium",
    "durationMs": 2087,
    "cost": 0.248,
    "timestamp": "2026-08-09T01:05:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 3922,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Upstream provider returned an error (HTTP 503).",
    "audit": [
      {
        "at": "2026-08-09T01:05:00Z",
        "actor": "Data Analyst",
        "event": "execution.requested",
        "detail": "Run scheduled query \u2192 warehouse.dim_customer"
      },
      {
        "at": "2026-08-09T01:05:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T01:05:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:05:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7106",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Draft reply",
    "target": "zendesk.Ticket/44133",
    "status": "allowed",
    "risk": "low",
    "durationMs": 2532,
    "cost": 0.129,
    "timestamp": "2026-08-09T01:00:00Z",
    "input": {
      "scope": "manage:tickets",
      "payloadBytes": 4265,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T01:00:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Draft reply \u2192 zendesk.Ticket/44133"
      },
      {
        "at": "2026-08-09T01:00:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T01:00:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T01:00:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7107",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Update ledger row",
    "target": "postgres.prod.ledger",
    "status": "blocked",
    "risk": "critical",
    "durationMs": 2276,
    "cost": 0.178,
    "timestamp": "2026-08-09T00:53:00Z",
    "input": {
      "scope": "write:database",
      "payloadBytes": 6412,
      "model": "gemini-2.5-pro"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": "Block production database access",
    "policyId": "pol_db_prod",
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-09T00:53:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Update ledger row \u2192 postgres.prod.ledger"
      },
      {
        "at": "2026-08-09T00:53:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Block production database access"
      },
      {
        "at": "2026-08-09T00:53:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-09T00:53:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7108",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Notify vendor",
    "target": "mail:sales@fastcarton.fr",
    "status": "blocked",
    "risk": "high",
    "durationMs": 4120,
    "cost": 0.282,
    "timestamp": "2026-08-09T00:46:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 6473,
      "model": "gemini-2.5-pro"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-09T00:46:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Notify vendor \u2192 mail:sales@fastcarton.fr"
      },
      {
        "at": "2026-08-09T00:46:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-09T00:46:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-09T00:46:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7109",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Escalate to tier 2",
    "target": "zendesk.Ticket/44098",
    "status": "failed",
    "risk": "medium",
    "durationMs": 3620,
    "cost": 0.043,
    "timestamp": "2026-08-09T00:39:00Z",
    "input": {
      "scope": "manage:tickets",
      "payloadBytes": 2421,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Upstream provider returned an error (HTTP 503).",
    "audit": [
      {
        "at": "2026-08-09T00:39:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Escalate to tier 2 \u2192 zendesk.Ticket/44098"
      },
      {
        "at": "2026-08-09T00:39:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T00:39:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T00:39:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7110",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Enrich account",
    "target": "salesforce.Account/8842",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 3115,
    "cost": 0.164,
    "timestamp": "2026-08-09T00:30:00Z",
    "input": {
      "scope": "read:crm",
      "payloadBytes": 5687,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T00:30:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Enrich account \u2192 salesforce.Account/8842"
      },
      {
        "at": "2026-08-09T00:30:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T00:30:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T00:30:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7111",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Score inbound lead",
    "target": "warehouse.leads",
    "status": "allowed",
    "risk": "low",
    "durationMs": 659,
    "cost": 0.209,
    "timestamp": "2026-08-09T00:21:00Z",
    "input": {
      "scope": "read:analytics",
      "payloadBytes": 1997,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T00:21:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Score inbound lead \u2192 warehouse.leads"
      },
      {
        "at": "2026-08-09T00:21:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-09T00:21:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T00:21:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7112",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Fetch supplier quote",
    "target": "api.vendorhub.com/quotes",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 510,
    "cost": 0.073,
    "timestamp": "2026-08-09T00:15:00Z",
    "input": {
      "scope": "call:external-api",
      "payloadBytes": 3500,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Redact PII in external calls",
    "policyId": "pol_pii",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T00:15:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Fetch supplier quote \u2192 api.vendorhub.com/quotes"
      },
      {
        "at": "2026-08-09T00:15:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Redact PII in external calls"
      },
      {
        "at": "2026-08-09T00:15:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T00:15:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7113",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Notify vendor",
    "target": "mail:sales@fastcarton.fr",
    "status": "allowed",
    "risk": "high",
    "durationMs": 1881,
    "cost": 0.414,
    "timestamp": "2026-08-09T00:06:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 5802,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T00:06:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Notify vendor \u2192 mail:sales@fastcarton.fr"
      },
      {
        "at": "2026-08-09T00:06:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-09T00:06:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T00:06:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7114",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Fetch supplier quote",
    "target": "api.vendorhub.com/quotes",
    "status": "allowed",
    "risk": "low",
    "durationMs": 1130,
    "cost": 0.278,
    "timestamp": "2026-08-09T00:03:00Z",
    "input": {
      "scope": "call:external-api",
      "payloadBytes": 308,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Redact PII in external calls",
    "policyId": "pol_pii",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-09T00:03:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Fetch supplier quote \u2192 api.vendorhub.com/quotes"
      },
      {
        "at": "2026-08-09T00:03:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Redact PII in external calls"
      },
      {
        "at": "2026-08-09T00:03:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-09T00:03:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7115",
    "agentId": "agt_data",
    "agentName": "Data Analyst",
    "action": "Run scheduled query",
    "target": "warehouse.dim_customer",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 776,
    "cost": 0.178,
    "timestamp": "2026-08-08T23:57:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 3234,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T23:57:00Z",
        "actor": "Data Analyst",
        "event": "execution.requested",
        "detail": "Run scheduled query \u2192 warehouse.dim_customer"
      },
      {
        "at": "2026-08-08T23:57:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T23:57:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T23:57:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7116",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Request purchase order",
    "target": "erp.PurchaseOrder",
    "status": "pending",
    "risk": "high",
    "durationMs": 1787,
    "cost": 0.17,
    "timestamp": "2026-08-08T23:46:00Z",
    "input": {
      "scope": "execute:payments",
      "payloadBytes": 3438,
      "model": "gpt-4.1"
    },
    "decision": "require_approval",
    "decisionReason": "Escalated to a human approver.",
    "policyEvaluated": "Maximum purchase amount",
    "policyId": "pol_purchase_limit",
    "result": "Waiting for human approval.",
    "audit": [
      {
        "at": "2026-08-08T23:46:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Request purchase order \u2192 erp.PurchaseOrder"
      },
      {
        "at": "2026-08-08T23:46:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Maximum purchase amount"
      },
      {
        "at": "2026-08-08T23:46:00Z",
        "actor": "Oathrion",
        "event": "decision.require_approval",
        "detail": "Escalated to a human approver."
      },
      {
        "at": "2026-08-08T23:46:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7117",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Reconcile provider spend",
    "target": "warehouse.fct_ai_spend",
    "status": "allowed",
    "risk": "low",
    "durationMs": 1035,
    "cost": 0.187,
    "timestamp": "2026-08-08T23:43:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 1110,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T23:43:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Reconcile provider spend \u2192 warehouse.fct_ai_spend"
      },
      {
        "at": "2026-08-08T23:43:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T23:43:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T23:43:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7118",
    "agentId": "agt_data",
    "agentName": "Data Analyst",
    "action": "Run scheduled query",
    "target": "warehouse.dim_customer",
    "status": "allowed",
    "risk": "low",
    "durationMs": 799,
    "cost": 0.227,
    "timestamp": "2026-08-08T23:32:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 3188,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T23:32:00Z",
        "actor": "Data Analyst",
        "event": "execution.requested",
        "detail": "Run scheduled query \u2192 warehouse.dim_customer"
      },
      {
        "at": "2026-08-08T23:32:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T23:32:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T23:32:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7119",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Send follow-up email",
    "target": "mail:priya@northwind.io",
    "status": "allowed",
    "risk": "high",
    "durationMs": 2778,
    "cost": 0.109,
    "timestamp": "2026-08-08T23:28:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 3055,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T23:28:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Send follow-up email \u2192 mail:priya@northwind.io"
      },
      {
        "at": "2026-08-08T23:28:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-08T23:28:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T23:28:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7120",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Query revenue table",
    "target": "warehouse.fct_revenue",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 2147,
    "cost": 0.205,
    "timestamp": "2026-08-08T23:19:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 913,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T23:19:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Query revenue table \u2192 warehouse.fct_revenue"
      },
      {
        "at": "2026-08-08T23:19:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T23:19:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T23:19:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7121",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Update opportunity stage",
    "target": "salesforce.Opportunity/1190",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 841,
    "cost": 0.219,
    "timestamp": "2026-08-08T23:10:00Z",
    "input": {
      "scope": "write:crm",
      "payloadBytes": 1891,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T23:10:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Update opportunity stage \u2192 salesforce.Opportunity/1190"
      },
      {
        "at": "2026-08-08T23:10:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T23:10:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T23:10:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7122",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Request purchase order",
    "target": "erp.PurchaseOrder",
    "status": "pending",
    "risk": "high",
    "durationMs": 3031,
    "cost": 0.356,
    "timestamp": "2026-08-08T23:08:00Z",
    "input": {
      "scope": "execute:payments",
      "payloadBytes": 4456,
      "model": "gemini-2.5-pro"
    },
    "decision": "require_approval",
    "decisionReason": "Escalated to a human approver.",
    "policyEvaluated": "Maximum purchase amount",
    "policyId": "pol_purchase_limit",
    "result": "Waiting for human approval.",
    "audit": [
      {
        "at": "2026-08-08T23:08:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Request purchase order \u2192 erp.PurchaseOrder"
      },
      {
        "at": "2026-08-08T23:08:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Maximum purchase amount"
      },
      {
        "at": "2026-08-08T23:08:00Z",
        "actor": "Oathrion",
        "event": "decision.require_approval",
        "detail": "Escalated to a human approver."
      },
      {
        "at": "2026-08-08T23:08:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7123",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Compare supplier pricing",
    "target": "drive/quotes-q3.xlsx",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 1093,
    "cost": 0.259,
    "timestamp": "2026-08-08T22:56:00Z",
    "input": {
      "scope": "read:files",
      "payloadBytes": 6668,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T22:56:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Compare supplier pricing \u2192 drive/quotes-q3.xlsx"
      },
      {
        "at": "2026-08-08T22:56:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T22:56:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:56:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7124",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Notify vendor",
    "target": "mail:sales@fastcarton.fr",
    "status": "allowed",
    "risk": "high",
    "durationMs": 2300,
    "cost": 0.209,
    "timestamp": "2026-08-08T22:53:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 6198,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T22:53:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Notify vendor \u2192 mail:sales@fastcarton.fr"
      },
      {
        "at": "2026-08-08T22:53:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-08T22:53:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:53:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7125",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Update opportunity stage",
    "target": "salesforce.Opportunity/1190",
    "status": "failed",
    "risk": "medium",
    "durationMs": 3016,
    "cost": 0.256,
    "timestamp": "2026-08-08T22:46:00Z",
    "input": {
      "scope": "write:crm",
      "payloadBytes": 3030,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Upstream provider returned an error (HTTP 503).",
    "audit": [
      {
        "at": "2026-08-08T22:46:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Update opportunity stage \u2192 salesforce.Opportunity/1190"
      },
      {
        "at": "2026-08-08T22:46:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T22:46:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:46:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7126",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Escalate to tier 2",
    "target": "zendesk.Ticket/44098",
    "status": "allowed",
    "risk": "low",
    "durationMs": 1109,
    "cost": 0.2,
    "timestamp": "2026-08-08T22:40:00Z",
    "input": {
      "scope": "manage:tickets",
      "payloadBytes": 2976,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T22:40:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Escalate to tier 2 \u2192 zendesk.Ticket/44098"
      },
      {
        "at": "2026-08-08T22:40:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T22:40:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:40:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7127",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Query revenue table",
    "target": "warehouse.fct_revenue",
    "status": "failed",
    "risk": "medium",
    "durationMs": 527,
    "cost": 0.351,
    "timestamp": "2026-08-08T22:28:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 1192,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Upstream provider returned an error (HTTP 503).",
    "audit": [
      {
        "at": "2026-08-08T22:28:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Query revenue table \u2192 warehouse.fct_revenue"
      },
      {
        "at": "2026-08-08T22:28:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T22:28:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:28:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7128",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Notify vendor",
    "target": "mail:sales@fastcarton.fr",
    "status": "allowed",
    "risk": "high",
    "durationMs": 3412,
    "cost": 0.269,
    "timestamp": "2026-08-08T22:23:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 920,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T22:23:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Notify vendor \u2192 mail:sales@fastcarton.fr"
      },
      {
        "at": "2026-08-08T22:23:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-08T22:23:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:23:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7129",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Reconcile provider spend",
    "target": "warehouse.fct_ai_spend",
    "status": "allowed",
    "risk": "low",
    "durationMs": 700,
    "cost": 0.015,
    "timestamp": "2026-08-08T22:18:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 5049,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T22:18:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Reconcile provider spend \u2192 warehouse.fct_ai_spend"
      },
      {
        "at": "2026-08-08T22:18:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T22:18:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:18:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7130",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Notify vendor",
    "target": "mail:sales@fastcarton.fr",
    "status": "allowed",
    "risk": "high",
    "durationMs": 2427,
    "cost": 0.232,
    "timestamp": "2026-08-08T22:11:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 385,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T22:11:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Notify vendor \u2192 mail:sales@fastcarton.fr"
      },
      {
        "at": "2026-08-08T22:11:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-08T22:11:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T22:11:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7131",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Send follow-up email",
    "target": "mail:priya@northwind.io",
    "status": "blocked",
    "risk": "high",
    "durationMs": 3563,
    "cost": 0.368,
    "timestamp": "2026-08-08T22:04:00Z",
    "input": {
      "scope": "send:email",
      "payloadBytes": 439,
      "model": "gemini-2.5-pro"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": "Require approval for external emails",
    "policyId": "pol_email_approval",
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-08T22:04:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Send follow-up email \u2192 mail:priya@northwind.io"
      },
      {
        "at": "2026-08-08T22:04:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Require approval for external emails"
      },
      {
        "at": "2026-08-08T22:04:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-08T22:04:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7132",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Compare supplier pricing",
    "target": "drive/quotes-q3.xlsx",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 2409,
    "cost": 0.178,
    "timestamp": "2026-08-08T21:56:00Z",
    "input": {
      "scope": "read:files",
      "payloadBytes": 1283,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T21:56:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Compare supplier pricing \u2192 drive/quotes-q3.xlsx"
      },
      {
        "at": "2026-08-08T21:56:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:56:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T21:56:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7133",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Search knowledge base",
    "target": "kb.acme.com",
    "status": "blocked",
    "risk": "low",
    "durationMs": 801,
    "cost": 0.222,
    "timestamp": "2026-08-08T21:47:00Z",
    "input": {
      "scope": "read:files",
      "payloadBytes": 363,
      "model": "claude-haiku-4.5"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-08T21:47:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Search knowledge base \u2192 kb.acme.com"
      },
      {
        "at": "2026-08-08T21:47:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:47:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-08T21:47:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7134",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Request purchase order",
    "target": "erp.PurchaseOrder",
    "status": "pending",
    "risk": "high",
    "durationMs": 2119,
    "cost": 0.262,
    "timestamp": "2026-08-08T21:43:00Z",
    "input": {
      "scope": "execute:payments",
      "payloadBytes": 1195,
      "model": "gpt-4.1"
    },
    "decision": "require_approval",
    "decisionReason": "Escalated to a human approver.",
    "policyEvaluated": "Maximum purchase amount",
    "policyId": "pol_purchase_limit",
    "result": "Waiting for human approval.",
    "audit": [
      {
        "at": "2026-08-08T21:43:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Request purchase order \u2192 erp.PurchaseOrder"
      },
      {
        "at": "2026-08-08T21:43:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Maximum purchase amount"
      },
      {
        "at": "2026-08-08T21:43:00Z",
        "actor": "Oathrion",
        "event": "decision.require_approval",
        "detail": "Escalated to a human approver."
      },
      {
        "at": "2026-08-08T21:43:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7135",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Search knowledge base",
    "target": "kb.acme.com",
    "status": "allowed",
    "risk": "low",
    "durationMs": 963,
    "cost": 0.119,
    "timestamp": "2026-08-08T21:36:00Z",
    "input": {
      "scope": "read:files",
      "payloadBytes": 6536,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T21:36:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Search knowledge base \u2192 kb.acme.com"
      },
      {
        "at": "2026-08-08T21:36:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:36:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T21:36:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7136",
    "agentId": "agt_data",
    "agentName": "Data Analyst",
    "action": "Refresh dashboard",
    "target": "looker.Dashboard/12",
    "status": "allowed",
    "risk": "low",
    "durationMs": 1513,
    "cost": 0.259,
    "timestamp": "2026-08-08T21:27:00Z",
    "input": {
      "scope": "read:analytics",
      "payloadBytes": 4351,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T21:27:00Z",
        "actor": "Data Analyst",
        "event": "execution.requested",
        "detail": "Refresh dashboard \u2192 looker.Dashboard/12"
      },
      {
        "at": "2026-08-08T21:27:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:27:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T21:27:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7137",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Search knowledge base",
    "target": "kb.acme.com",
    "status": "failed",
    "risk": "low",
    "durationMs": 2323,
    "cost": 0.369,
    "timestamp": "2026-08-08T21:18:00Z",
    "input": {
      "scope": "read:files",
      "payloadBytes": 2336,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Upstream provider returned an error (HTTP 503).",
    "audit": [
      {
        "at": "2026-08-08T21:18:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Search knowledge base \u2192 kb.acme.com"
      },
      {
        "at": "2026-08-08T21:18:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:18:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T21:18:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7138",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Write monthly report",
    "target": "drive/finance/aug-2026.docx",
    "status": "blocked",
    "risk": "low",
    "durationMs": 1990,
    "cost": 0.135,
    "timestamp": "2026-08-08T21:13:00Z",
    "input": {
      "scope": "write:files",
      "payloadBytes": 5708,
      "model": "claude-sonnet-4.5"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-08T21:13:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Write monthly report \u2192 drive/finance/aug-2026.docx"
      },
      {
        "at": "2026-08-08T21:13:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:13:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-08T21:13:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7139",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Query revenue table",
    "target": "warehouse.fct_revenue",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 3854,
    "cost": 0.327,
    "timestamp": "2026-08-08T21:09:00Z",
    "input": {
      "scope": "read:database",
      "payloadBytes": 6076,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T21:09:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Query revenue table \u2192 warehouse.fct_revenue"
      },
      {
        "at": "2026-08-08T21:09:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:09:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T21:09:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7140",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Compare supplier pricing",
    "target": "drive/quotes-q3.xlsx",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 3238,
    "cost": 0.4,
    "timestamp": "2026-08-08T21:01:00Z",
    "input": {
      "scope": "read:files",
      "payloadBytes": 3472,
      "model": "claude-haiku-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T21:01:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Compare supplier pricing \u2192 drive/quotes-q3.xlsx"
      },
      {
        "at": "2026-08-08T21:01:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T21:01:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T21:01:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7141",
    "agentId": "agt_procurement",
    "agentName": "Procurement Agent",
    "action": "Fetch supplier quote",
    "target": "api.vendorhub.com/quotes",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 1834,
    "cost": 0.145,
    "timestamp": "2026-08-08T20:51:00Z",
    "input": {
      "scope": "call:external-api",
      "payloadBytes": 1813,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": "Redact PII in external calls",
    "policyId": "pol_pii",
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T20:51:00Z",
        "actor": "Procurement Agent",
        "event": "execution.requested",
        "detail": "Fetch supplier quote \u2192 api.vendorhub.com/quotes"
      },
      {
        "at": "2026-08-08T20:51:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Redact PII in external calls"
      },
      {
        "at": "2026-08-08T20:51:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T20:51:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7142",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Resolve ticket",
    "target": "zendesk.Ticket/44120",
    "status": "allowed",
    "risk": "low",
    "durationMs": 2449,
    "cost": 0.195,
    "timestamp": "2026-08-08T20:46:00Z",
    "input": {
      "scope": "manage:tickets",
      "payloadBytes": 5970,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T20:46:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Resolve ticket \u2192 zendesk.Ticket/44120"
      },
      {
        "at": "2026-08-08T20:46:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T20:46:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T20:46:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7143",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Update ledger row",
    "target": "postgres.prod.ledger",
    "status": "blocked",
    "risk": "critical",
    "durationMs": 4115,
    "cost": 0.031,
    "timestamp": "2026-08-08T20:37:00Z",
    "input": {
      "scope": "write:database",
      "payloadBytes": 6668,
      "model": "claude-sonnet-4.5"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": "Block production database access",
    "policyId": "pol_db_prod",
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-08T20:37:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Update ledger row \u2192 postgres.prod.ledger"
      },
      {
        "at": "2026-08-08T20:37:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Block production database access"
      },
      {
        "at": "2026-08-08T20:37:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-08T20:37:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7144",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Enrich account",
    "target": "salesforce.Account/8842",
    "status": "allowed",
    "risk": "medium",
    "durationMs": 3890,
    "cost": 0.328,
    "timestamp": "2026-08-08T20:34:00Z",
    "input": {
      "scope": "read:crm",
      "payloadBytes": 2425,
      "model": "claude-sonnet-4.5"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T20:34:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Enrich account \u2192 salesforce.Account/8842"
      },
      {
        "at": "2026-08-08T20:34:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T20:34:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T20:34:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7145",
    "agentId": "agt_finance",
    "agentName": "Finance Agent",
    "action": "Update ledger row",
    "target": "postgres.prod.ledger",
    "status": "blocked",
    "risk": "critical",
    "durationMs": 2377,
    "cost": 0.386,
    "timestamp": "2026-08-08T20:26:00Z",
    "input": {
      "scope": "write:database",
      "payloadBytes": 4884,
      "model": "claude-haiku-4.5"
    },
    "decision": "block",
    "decisionReason": "Denied by an organization policy.",
    "policyEvaluated": "Block production database access",
    "policyId": "pol_db_prod",
    "result": "Action denied. Nothing was executed downstream.",
    "audit": [
      {
        "at": "2026-08-08T20:26:00Z",
        "actor": "Finance Agent",
        "event": "execution.requested",
        "detail": "Update ledger row \u2192 postgres.prod.ledger"
      },
      {
        "at": "2026-08-08T20:26:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "Block production database access"
      },
      {
        "at": "2026-08-08T20:26:00Z",
        "actor": "Oathrion",
        "event": "decision.block",
        "detail": "Denied by an organization policy."
      },
      {
        "at": "2026-08-08T20:26:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7146",
    "agentId": "agt_support",
    "agentName": "Support Agent",
    "action": "Resolve ticket",
    "target": "zendesk.Ticket/44120",
    "status": "allowed",
    "risk": "low",
    "durationMs": 930,
    "cost": 0.181,
    "timestamp": "2026-08-08T20:15:00Z",
    "input": {
      "scope": "manage:tickets",
      "payloadBytes": 803,
      "model": "gemini-2.5-pro"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T20:15:00Z",
        "actor": "Support Agent",
        "event": "execution.requested",
        "detail": "Resolve ticket \u2192 zendesk.Ticket/44120"
      },
      {
        "at": "2026-08-08T20:15:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T20:15:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T20:15:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  },
  {
    "id": "exe_7147",
    "agentId": "agt_sales",
    "agentName": "Sales Agent",
    "action": "Enrich account",
    "target": "salesforce.Account/8842",
    "status": "allowed",
    "risk": "low",
    "durationMs": 3687,
    "cost": 0.097,
    "timestamp": "2026-08-08T20:09:00Z",
    "input": {
      "scope": "read:crm",
      "payloadBytes": 2376,
      "model": "gpt-4.1"
    },
    "decision": "allow",
    "decisionReason": "All matching policies evaluated to allow.",
    "policyEvaluated": null,
    "policyId": null,
    "result": "Completed successfully.",
    "audit": [
      {
        "at": "2026-08-08T20:09:00Z",
        "actor": "Sales Agent",
        "event": "execution.requested",
        "detail": "Enrich account \u2192 salesforce.Account/8842"
      },
      {
        "at": "2026-08-08T20:09:00Z",
        "actor": "Oathrion Policy Engine",
        "event": "policy.evaluated",
        "detail": "No matching policy"
      },
      {
        "at": "2026-08-08T20:09:00Z",
        "actor": "Oathrion",
        "event": "decision.allow",
        "detail": "All matching policies evaluated to allow."
      },
      {
        "at": "2026-08-08T20:09:00Z",
        "actor": "Event log",
        "event": "event.recorded",
        "detail": "Hash-chained audit entry written."
      }
    ]
  }
];
