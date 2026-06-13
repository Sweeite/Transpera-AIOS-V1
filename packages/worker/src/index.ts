/**
 * @aios/worker — async worker tier (tech-stack §2, §5.4).
 * Queue is pgmq INSIDE the client's own Supabase — NO shared Redis (isolation layer 1, §8.2).
 * Runs the §5 routing gates on incoming content; drains ingestion/proposal/review queues; runs crons.
 */
import { TENANT_ID } from '@aios/core/dist/db/client.js';

const QUEUES = {
  ingest: 'ingest', // §5 routing gates
  proposal: 'memory_proposal', // review queue drain
  backfill: 'coldstart_backfill', // bounded, rate-limited (§10.3)
} as const;

const CRONS = {
  consolidate: '0 2 * * *', // nightly (§4.5)
  decay: '0 3 * * 0', // weekly Sun (§4.6)
  pruneChunks: '0 4 * * *', // chunk TTL (§6.8)
  schemaDrift: '0 5 * * *', // diff connector_schemas vs live SoR (§5)
  ingestAudit: '0 6 * * 1', // sampled false-drop audit (§11.8)
  embeddingCanary: '0 7 * * *', // re-embed probe set, alarm on drift (watching the watchers, §11.8)
  monitorWatchdog: '*/15 * * * *', // dead-man's switch: alert on any overdue monitor heartbeat (§11.8)
} as const;

export async function startWorker() {
  // TODO: connect pgmq; register queue consumers + cron schedules; emit heartbeat for fleet alerting (§5.4).
  console.log(`[worker] starting for tenant ${TENANT_ID}`, { QUEUES, CRONS });
  throw new Error('TODO: startWorker');
}

if (process.env.NODE_ENV !== 'test') {
  startWorker().catch((err) => {
    console.error(`[worker] boot failed for tenant ${TENANT_ID}:`, err);
    process.exit(1);
  });
}
