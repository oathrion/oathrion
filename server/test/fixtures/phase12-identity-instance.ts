/**
 * PHASE 12 — une instance Oathrion réelle, dans son propre processus.
 *
 * Ce fixture est lancé comme processus enfant par
 * `server/test/phase12-multiprocess-identity.test.ts`. Chaque lancement est une
 * instance Oathrion distincte : son propre thread d'identité, sa propre connexion
 * PostgreSQL, son propre registre de modules. Rien n'est partagé entre deux
 * instances **sauf la base de données** — ce qui est précisément l'affirmation à
 * prouver : la vérité de sécurité (sessions, clés d'API, credentials, révocations)
 * vit dans PostgreSQL et non dans un processus.
 *
 * Pourquoi pas `Promise.all` dans un seul test : deux appels dans le même processus
 * partagent le cache de modules et la même connexion. N'importe quel état en mémoire
 * ferait passer le test sans rien démontrer d'un déploiement à plusieurs répliques.
 *
 * Contrat : le plan d'opérations arrive en JSON sur argv[2], le résultat sort sur
 * stdout précédé de `RESULT:`. Le code de sortie est 0 même quand une opération
 * refuse — un refus est un résultat, pas un plantage.
 */

import { organizationId as toOrganizationId } from "@shared/tenancy";
import type { Role } from "@shared/roles";

interface Operation {
  op: string;
  [key: string]: unknown;
}

/**
 * Le nom d'affichage d'une organisation de fixture, DISTINCT par identifiant.
 *
 * Les trois appels à `organizationStore.ensure` de ce fichier passaient le même
 * littéral « Test Org » quel que soit l'identifiant reçu. Depuis la migration 18 le nom
 * d'une organisation est unique : trois identifiants portant le même nom faisaient
 * échouer la migration sur l'index. Suffixer par l'identifiant garde l'intention — une
 * étiquette lisible — et respecte la règle du produit au lieu de la contourner.
 */
function organizationLabel(configured: unknown, org: string): string {
  return typeof configured === "string" && configured.trim() !== ""
    ? configured
    : `Test Org ${org}`;
}

async function main(): Promise<void> {
  const plan = JSON.parse(process.argv[2] ?? "{}") as { ops?: Operation[] };
  const ops = plan.ops ?? [];

  // Importé ici, après que le parent a fixé l'environnement : `server/db.ts` ouvre le
  // plan d'identité au chargement du module.
  const { login, resolveBearer, changePassword } = await import("../../auth");
  const { generateKey } = await import("../../api-keys");
  const { hashPassword } = await import("../../passwords");
  const { userStore } = await import("../../repositories/users");
  const { organizationStore } =
    await import("../../repositories/organizations");
  const { sessionStore } = await import("../../repositories/sessions");
  const { apiKeyStore } = await import("../../repositories/api-keys");
  const { identityTokenStore } = await import("../../repositories/identity-tokens");
  const { IDENTITY_PLANE, closeDatabase } = await import("../../db");

  const results: unknown[] = [];

  for (const operation of ops) {
    /*
     * Une opération qui échoue est enregistrée et n'interrompt pas le plan : le test
     * « base indisponible → fail closed » a besoin de voir l'erreur exacte, et un refus
     * est un résultat attendu, pas un plantage du fixture.
     */
    try {
      switch (operation.op) {
        case "plane": {
          results.push({ op: "plane", plane: IDENTITY_PLANE });
          break;
        }

        case "seedUser": {
          const org = toOrganizationId(String(operation.organization));
          organizationStore.ensure(org, organizationLabel(operation.organizationName, org));
          const user = userStore.ensure({
            email: String(operation.email),
            name: String(operation.name ?? "Test User"),
            passwordHash: hashPassword(String(operation.password)),
            passwordSource: "user",
          });
          userStore.setPassword(
            user.id,
            hashPassword(String(operation.password)),
            "user",
          );
          userStore.grant(org, user.id, (operation.role as Role) ?? "admin");
          results.push({ op: "seedUser", userId: user.id });
          break;
        }

        case "setOrganizationActive": {
          const org = toOrganizationId(String(operation.organization));
          results.push({
            op: "setOrganizationActive",
            changed: organizationStore.setActive(
              org,
              Boolean(operation.active),
            ),
            isActive: organizationStore.isActive(org),
          });
          break;
        }

        case "login": {
          const result = login(
            String(operation.email),
            String(operation.password),
            operation.organization
              ? toOrganizationId(String(operation.organization))
              : undefined,
          );
          results.push({
            op: "login",
            ok: result.session !== null,
            failure: result.failure,
            // Le jeton porteur est l'identifiant de session : c'est ce qu'une autre
            // instance recevra dans l'en-tête Authorization.
            sessionId: result.session?.session.id ?? null,
            token: result.session?.token ?? null,
            role: result.session?.identity.role ?? null,
            organizationId: result.session?.session.organizationId ?? null,
          });
          break;
        }

        case "resolve": {
          const identity = resolveBearer(String(operation.credential));
          results.push({
            op: "resolve",
            authenticated: identity !== null,
            id: identity?.id ?? null,
            organizationId: identity?.organizationId ?? null,
            role: identity?.role ?? null,
            agentId: identity?.agentId ?? null,
            sessionId: identity?.sessionId ?? null,
            kind: identity?.kind ?? null,
          });
          break;
        }

        case "revokeSession": {
          results.push({
            op: "revokeSession",
            revoked: sessionStore.revoke(
              String(operation.sessionId),
              String(operation.by ?? "test"),
              toOrganizationId(String(operation.organization)),
            ),
          });
          break;
        }

        case "listSessions": {
          const rows = sessionStore.list(
            toOrganizationId(String(operation.organization)),
            100,
          );
          results.push({
            op: "listSessions",
            count: rows.length,
            ids: rows.map((r) => r.id),
          });
          break;
        }

        case "changePassword": {
          const outcome = changePassword(
            String(operation.userId),
            String(operation.currentPassword),
            String(operation.newPassword),
          );
          results.push({ op: "changePassword", outcome });
          break;
        }

        case "createApiKey": {
          const org = toOrganizationId(String(operation.organization));
          organizationStore.ensure(org, organizationLabel(operation.organizationName, org));
          const generated = generateKey();
          const record = apiKeyStore.create({
            id: `key_${Math.random().toString(16).slice(2, 14)}`,
            organizationId: org,
            name: String(operation.name ?? "phase12"),
            role: (operation.role as Role) ?? "operator",
            secretHash: generated.hash,
            prefix: generated.displayPrefix,
            source: "user",
            createdBy: "phase12",
            expiresAt:
              (operation.expiresAt as string | null | undefined) ?? null,
            agentId: (operation.agentId as string | null | undefined) ?? null,
          });
          results.push({
            op: "createApiKey",
            id: record.id,
            secret: generated.secret,
            agentId: record.agentId,
          });
          break;
        }

        case "revokeApiKey": {
          results.push({
            op: "revokeApiKey",
            revoked: apiKeyStore.revoke(
              toOrganizationId(String(operation.organization)),
              String(operation.id),
              "phase12",
              String(operation.reason ?? "test revocation"),
            ),
          });
          break;
        }

        case "findApiKey": {
          const found = apiKeyStore.findIn(
            toOrganizationId(String(operation.organization)),
            String(operation.id),
          );
          results.push({
            op: "findApiKey",
            // `findIn` renvoie `undefined` pour un id absent ou appartenant à un autre
          // tenant ; comparer à `null` seulement rendrait le test toujours vrai.
          found: found !== undefined && found !== null,
            revokedAt: found?.revokedAt ?? null,
            agentId: found?.agentId ?? null,
          });
          break;
        }

        case "createIdentityToken": {
        const org = toOrganizationId(String(operation.organization));
        organizationStore.ensure(org, organizationLabel(operation.organizationName, org));
        const issued = identityTokenStore.create({
          organizationId: org,
          purpose: (operation.purpose as "invite" | "reset") ?? "invite",
          email: String(operation.email),
          role: (operation.role as Role) ?? "operator",
          createdBy: "phase12",
        });
        results.push({
          op: "createIdentityToken",
          id: issued.record.id,
          token: issued.token,
        });
        break;
      }

      case "resolveIdentityToken": {
        const record = identityTokenStore.resolve(String(operation.token));
        results.push({
          op: "resolveIdentityToken",
          found: record !== undefined && record !== null,
          consumedAt: record?.consumedAt ?? null,
          organizationId: record?.organizationId ?? null,
        });
        break;
      }

      case "consumeIdentityToken": {
        results.push({
          op: "consumeIdentityToken",
          consumed: identityTokenStore.consume(String(operation.id), "phase12"),
        });
        break;
      }

        /*
         * Chantier 1 — per-tenant quota ceilings held in PostgreSQL. Imported lazily, like
         * every store above, so `server/db.ts` opens the plane this process was given.
         */
        case "quotaLimits": {
          const { quotaLimitsFor } = await import("../../quotas");
          results.push({
            op: "quotaLimits",
            limits: quotaLimitsFor(toOrganizationId(String(operation.organization))),
          });
          break;
        }

        case "setOrganizationQuota": {
          const { setOrganizationQuota } = await import("../../quotas");
          setOrganizationQuota(
            toOrganizationId(String(operation.organization)),
            String(operation.counter) as "agents",
            operation.ceiling as number,
          );
          results.push({ op: "setOrganizationQuota", ok: true });
          break;
        }

        case "importQuotas": {
          const { importQuotaOverrides } = await import("../../quotas");
          results.push({
            op: "importQuotas",
            ...importQuotaOverrides(organizationStore.list().map((o) => o.id)),
          });
          break;
        }

        case "touchFile": {
          // The other half of `waitForFile`: lets the parent know this instance reached
          // a point in its plan (chantier 1 — "A has read its ceiling, now change it").
          const fs = await import("node:fs");
          fs.writeFileSync(String(operation.path), "");
          results.push({ op: "touchFile" });
          break;
        }

      case "sleep": {
          await new Promise((resolve) =>
            setTimeout(resolve, Number(operation.ms ?? 100)),
          );
          results.push({ op: "sleep" });
          break;
        }

        case "waitForFile": {
          // Point de rendez-vous avec le processus parent : le test arrête et redémarre
          // réellement PostgreSQL pendant que cette instance reste vivante, puis crée le
          // fichier. L'opération suivante doit fonctionner sur la même instance.
          const fs = await import("node:fs");
          const path = String(operation.path);
          const deadline = Date.now() + Number(operation.timeoutMs ?? 60_000);
          let seen = false;
          while (Date.now() < deadline) {
            if (fs.existsSync(path)) {
              seen = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          results.push({ op: "waitForFile", seen });
          break;
        }

        case "sql": {
          // Lecture directe dans PostgreSQL, pour prouver que ce que le magasin a écrit
          // est réellement dans la base et pas dans un cache de processus.
          const { rawDb } = await import("../../db");
          const rows = rawDb
            .prepare(String(operation.sql))
            .all(...((operation.params as unknown[]) ?? []));
          results.push({ op: "sql", rows });
          break;
        }

        default:
          results.push({ op: operation.op, error: "unknown operation" });
      }
    } catch (error) {
      results.push({
        op: operation.op,
        error: error instanceof Error ? error.message : String(error),
        authenticated: false,
      });
    }
  }

  process.stdout.write(`RESULT:${JSON.stringify(results)}\n`);
  closeDatabase();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stdout.write(
      `RESULT:${JSON.stringify([{ op: "fatal", error: error instanceof Error ? error.message : String(error) }])}\n`,
    );
    process.exit(0);
  },
);
