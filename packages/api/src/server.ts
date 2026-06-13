/**
 * @aios/api — Fastify app: REST + chat streaming. Loads core, mounts the tenant from env (tech-stack §2).
 * Supabase Auth handles AUTHENTICATION; the engine owns AUTHORIZATION (§8.1a).
 */
import { TENANT_ID } from '@aios/core/dist/db/client.js';
import { loadPluginForTenant } from '@aios/core/dist/hooks/registry.js';

export async function buildServer() {
  // TODO: const app = Fastify();
  // TODO: verify Supabase JWT → resolve principal; every request carries a principal (§7.5).
  // Routes:
  //   POST /chat           — intent router → query (retrieve→provenance answer/abstain) or command (agent/workflow)
  //   GET  /memories       — inspector, permission-filtered to the asker (§11.2)
  //   POST /ingest         — manual upload → routing gates
  //   GET  /inbox          — the single push destination (§7.5)
  //   POST /inbox/:id/answer — resume a paused task (clarification interrupt, §7.3)
  //   GET  /traces, /audit, /dashboards/* — observability (§11)
  //   GET  /healthz        — heartbeat for fleet alerting (tech-stack §5.4)
  await loadPluginForTenant(TENANT_ID, {} as never);
  throw new Error('TODO: buildServer');
}

if (process.env.NODE_ENV !== 'test') {
  buildServer().catch((err) => {
    console.error(`[api] boot failed for tenant ${TENANT_ID}:`, err);
    process.exit(1);
  });
}
