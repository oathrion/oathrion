/**
 * The SIMULATED tools of the MVP.
 *
 * Every tool in this file is SIMULATED. None of them reaches a real external
 * service: they stand in for a procurement API, an SMTP gateway, a production
 * database driver, a payment processor and a CRM. They return a constructed
 * result. No real money moves, and no real record is destroyed.
 *
 * They perform no authorization check of their own — reaching a tool's `run()`
 * already means the Gateway cleared the action. That is deliberate, and it is
 * also why the invocation counter inherited from `CountingTool` matters: it is
 * how a test proves the *negative*, that a BLOCKed or not-yet-approved action
 * never arrived here.
 *
 * `RefundTool` and `CustomerTool` exist so that the three reference scenarios
 * are genuinely executable end to end. Before them, `refund` and
 * `delete_customer` were catalogued but wired to nothing, so the Gateway marked
 * every run "skipped" and "the tool was never called" was true for an
 * uninteresting reason. In particular `CustomerTool` is wired on purpose: a
 * BLOCK is only evidence if the thing being blocked could otherwise have run.
 */

import { formatAmount } from "@shared/policy/matchers";
import { CountingTool, type ToolContext, type ToolResult } from "./types";
import { callDownstreamTool, downstreamMcpUrl, type ToolMode } from "./mcp-client";

function readAmount(metadata: Record<string, unknown>): number {
  const raw = metadata.amount;
  // `€` has to be stripped alongside `$`: the deployment is denominated in
  // euros, so `"€1 200"` is the realistic string form of an amount, and it used
  // to parse as NaN and silently report a €0 purchase.
  const value = typeof raw === "string" ? Number(raw.replace(/[$€,\s]/g, "")) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class PurchaseTool extends CountingTool {
  readonly id = "purchase_tool";
  readonly name = "Purchase tool";
  readonly description = "Places a purchase order with the procurement provider.";

  protected async run(context: ToolContext): Promise<ToolResult> {
    const amount = readAmount(context.metadata);
    return {
      ok: true,
      /*
       * Rendered in the TENANT's currency, which arrives on the context. Hard-coding
       * `$` + `en-US` here once printed euro amounts with a dollar sign, so the tool
       * summary contradicted the decision reason beside it on the same execution; a
       * deployment-wide constant then made a franc CFA amount read as euros for the same
       * reason, one layer up.
       */
      summary: `Purchase order placed for ${formatAmount(amount, context.currency)} with ${context.target}.`,
      data: {
        orderId: `po_${context.executionId.slice(4)}`,
        amount,
        vendor: context.target,
      },
    };
  }
}

export class SendEmailTool extends CountingTool {
  readonly id = "send_email_tool";
  readonly name = "Send email tool";
  readonly description = "Sends an outbound email through the workspace mail gateway.";

  protected async run(context: ToolContext): Promise<ToolResult> {
    const recipient =
      typeof context.metadata.recipient === "string" ? context.metadata.recipient : context.target;
    return {
      ok: true,
      summary: `Email delivered to ${recipient}.`,
      data: {
        messageId: `msg_${context.executionId.slice(4)}`,
        recipient,
      },
    };
  }
}

/**
 * SIMULATED payment reversal.
 *
 * Reaching this method means the control plane released the refund: either the
 * decision was ALLOW, or a human approved it and the Gateway resumed the
 * execution. It never means the amount was re-checked here — the ceiling lives
 * in the policy engine, not in the tool.
 */
export class RefundTool extends CountingTool {
  readonly id = "refund_tool";
  readonly name = "Refund tool";
  readonly description = "Returns funds to a customer through the payment provider. SIMULATED.";

  /**
   * The only tool whose answer is not a constant, and it reads the SAME function
   * its `run` branches on a few lines below. Two readers of one condition, never
   * two conditions: an inventory that said "simulated" while the next call
   * dispatched to a real provider would be exactly the kind of claim this
   * codebase refuses to make.
   */
  override get simulated(): boolean {
    return downstreamMcpUrl() === null;
  }

  protected async run(context: ToolContext): Promise<ToolResult> {
    const amount = readAmount(context.metadata);
    const reference =
      typeof context.metadata.reference === "string" ? context.metadata.reference : context.target;

    /*
     * When a downstream MCP server is configured, the refund is dispatched to
     * it for real over MCP instead of being constructed here. Reaching this
     * line already means the Gateway decided ALLOW — see `mcp-client.ts` for
     * why this does not constitute a second path to the tool.
     */
    if (downstreamMcpUrl()) {
      const downstream = await callDownstreamTool({
        tool: "stripe.refund",
        /*
         * The tenant's currency, not a literal. This field used to be `"EUR"`, so a
         * refund Oathrion authorised in francs CFA would have been requested from the
         * provider in euros — the amount approved and the amount asked for would have
         * differed by a factor of 655.
         */
        arguments: { customer: context.target, amount, currency: context.currency },
        executionId: context.executionId,
      });
      return {
        ok: downstream.ok,
        summary: `Refund of ${formatAmount(amount, context.currency)} dispatched to ${context.target} via the local MCP server.`,
        data: {
          ...downstream.data,
          amount,
          customer: context.target,
          reference,
          mode: "LOCAL_MCP" satisfies ToolMode,
          simulated: false,
        },
      };
    }

    return {
      ok: true,
      summary: `Refund of ${formatAmount(amount, context.currency)} issued to ${context.target}.`,
      data: {
        // Derived from the Execution id, so the same execution replayed cannot
        // produce two different refund references.
        refundId: `rfnd_${context.executionId.slice(4)}`,
        amount,
        customer: context.target,
        reference,
        mode: "SIMULATED" satisfies ToolMode,
        simulated: true,
      },
    };
  }
}

/**
 * SIMULATED customer-record deletion.
 *
 * Wired to the `delete_customer` verb specifically so that the BLOCK scenario
 * has something to prove: the org policy denies the action, and
 * `toolExecutionCount` stays at zero even though a working destructive path
 * exists behind it.
 */
export class CustomerTool extends CountingTool {
  readonly id = "customer_tool";
  readonly name = "Customer record tool";
  readonly description = "Deletes a customer record from the CRM. SIMULATED.";

  protected async run(context: ToolContext): Promise<ToolResult> {
    // Wired to the real downstream for the same reason the tool is wired at
    // all: a BLOCK is only evidence if the action could otherwise have
    // happened. With a downstream configured, an unblocked `delete_customer`
    // really does issue an HTTP request to a server that really does delete.
    if (downstreamMcpUrl()) {
      const downstream = await callDownstreamTool({
        tool: "customer.delete",
        arguments: { customer: context.target },
        executionId: context.executionId,
      });
      return {
        ok: downstream.ok,
        summary: `Customer record ${context.target} deleted via the local MCP server.`,
        data: {
          ...downstream.data,
          customer: context.target,
          irreversible: true,
          mode: "LOCAL_MCP" satisfies ToolMode,
          simulated: false,
        },
      };
    }

    return {
      ok: true,
      summary: `Customer record ${context.target} deleted.`,
      data: {
        customer: context.target,
        deletedRecords: 1,
        irreversible: true,
        mode: "SIMULATED" satisfies ToolMode,
        simulated: true,
      },
    };
  }
}

export class DatabaseTool extends CountingTool {
  readonly id = "database_tool";
  readonly name = "Database tool";
  readonly description = "Reads from or writes to a connected datastore.";

  protected async run(context: ToolContext): Promise<ToolResult> {
    return {
      ok: true,
      summary: `Query executed against ${context.target}.`,
      data: {
        database: context.target,
        rows: 0,
        statement: typeof context.metadata.query === "string" ? context.metadata.query : "SELECT 1",
      },
    };
  }
}
