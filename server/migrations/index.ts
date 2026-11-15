/**
 * The migration registry.
 *
 * Order is the source of truth for schema history. Append only — never renumber,
 * never rename, never edit an applied migration. The runner refuses a database
 * whose ledger disagrees with this list, which is what makes that rule enforceable
 * rather than aspirational.
 */

import { baseline } from "./001-baseline";
import { legacyColumns } from "./002-legacy-columns";
import { tenancy } from "./003-tenancy";
import { users } from "./004-users";
import { apiKeys } from "./005-api-keys";
import { rateLimitBuckets } from "./006-rate-limit";
import { usageCounters } from "./007-usage-counters";
import { identity } from "./008-identity";
import { approvalExpiry } from "./009-approval-expiry";
import { credentialAgentBinding } from "./010-credential-agent-binding";
import { usageCounterTimestamp } from "./011-usage-counter-timestamp";
import { actionAuthority } from "./012-action-authority";
import { receiptOrdering } from "./013-receipt-ordering";
import { authorityTimestamptz } from "./014-authority-timestamptz";
import { organizationCurrency } from "./015-organization-currency";
import { actionPolicyTenantKey } from "./016-action-policy-tenant-key";
import { organizationQuotas } from "./017-organization-quotas";
import { organizationNameKeyUnique } from "./018-organization-name-key";
import { productFeedback } from "./019-feedback";
import { tenantErasure } from "./020-tenant-erasure";
import { connectorCredentials } from "./021-connector-credentials";
import { pendingInterceptions } from "./022-pending-interceptions";
import { ssoIdentities } from "./023-sso-identities";
import { pendingSuccessField } from "./024-pending-success-field";
import { agentDoors } from "./025-agent-doors";
import { reconcileMemory } from "./026-reconcile";
import { grantConsumptionIndex } from "./027-grant-consumption-index";
import { quotaPeriodCounts } from "./028-quota-period-counts";
import { receiptChainCheckpoints } from "./029-receipt-chain-checkpoints";
import { mandates } from "./030-mandates";
import { mandateReceipts } from "./031-mandate-receipts";
import type { Migration } from "./types";

export const MIGRATIONS: readonly Migration[] = [
  baseline,
  legacyColumns,
  tenancy,
  users,
  apiKeys,
  rateLimitBuckets,
  usageCounters,
  identity,
  approvalExpiry,
  credentialAgentBinding,
  usageCounterTimestamp,
  actionAuthority,
  receiptOrdering,
  authorityTimestamptz,
  organizationCurrency,
  actionPolicyTenantKey,
  organizationQuotas,
  organizationNameKeyUnique,
  productFeedback,
  tenantErasure,
  connectorCredentials,
  pendingInterceptions,
  ssoIdentities,
  pendingSuccessField,
  agentDoors,
  reconcileMemory,
  grantConsumptionIndex,
  quotaPeriodCounts,
  receiptChainCheckpoints,
  mandates,
  mandateReceipts,
];

/** The version a fully migrated database sits at for this build. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export { createSqliteMigrationDriver } from "./sqlite-driver";
export {
  createPostgresMigrationDriver,
  migratePostgres,
  runMigrationsAsync,
  INSPECTED_TABLES,
} from "./postgres-driver";
export type { AsyncMigrationDriver } from "./postgres-driver";
export { RATE_LIMIT_TABLE } from "./006-rate-limit";
export { USAGE_COUNTERS_TABLE } from "./007-usage-counters";
export {
  ACTIONS_TABLE,
  ACTION_GRANTS_TABLE,
  ACTION_POLICIES_TABLE,
  ACTION_RECEIPTS_TABLE,
} from "./012-action-authority";
export { IDENTITY_TOKENS_TABLE } from "./008-identity";
export { ORGANIZATION_QUOTAS_TABLE } from "./017-organization-quotas";
export { FEEDBACK_TABLE } from "./019-feedback";
export { TENANT_ERASURES_TABLE } from "./020-tenant-erasure";
export { SSO_IDENTITIES_TABLE } from "./023-sso-identities";
export { AGENT_DOORS_TABLE } from "./025-agent-doors";
export { RECONCILE_RUNS_TABLE, RECONCILE_FINDINGS_TABLE } from "./026-reconcile";
export { QUOTA_PERIOD_COUNTS_TABLE } from "./028-quota-period-counts";
export { RECEIPT_CHAIN_CHECKPOINTS_TABLE } from "./029-receipt-chain-checkpoints";
export { MANDATES_TABLE, MANDATE_KEYS_TABLE, MANDATE_GRANTS_TABLE } from "./030-mandates";
export { MANDATE_RECEIPTS_TABLE } from "./031-mandate-receipts";
export { APPROVAL_BACKFILL_TTL_SECONDS } from "./009-approval-expiry";
export { LEDGER_TABLE, migrationHistory, runMigrations, schemaVersion, assertRegistryIsSound } from "./runner";
export type { MigrationDriver, MigrationResult } from "./runner";
export { MigrationError } from "./types";
export type { AppliedMigration, Dialect, Migration, SchemaInspect } from "./types";
