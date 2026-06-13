/**
 * Monitoring integrity — "watching the watchers" (silent-failure guards, Brief §11.8, §3.1).
 * The detectors themselves must not fail silently. No system is immune to silent failure; these shrink
 * the residual surface to: (a) eval-coverage gaps, (b) the monitors dying, (c) genuinely novel modes.
 */

/**
 * Dead-man's switch: every monitor/cron stamps a heartbeat after each run. If a heartbeat is overdue,
 * alert on the ABSENCE of signal — losing a detector silently is itself the failure we're guarding against.
 */
export async function heartbeat(_monitor: string): Promise<void> {
  // TODO: upsert last_run_at; a separate watchdog alerts when any monitor's heartbeat is overdue.
  throw new Error('TODO: heartbeat');
}

export async function checkOverdueMonitors(): Promise<Array<{ monitor: string; overdueBy: number }>> {
  // TODO: compare each monitor's last_run_at vs its expected cadence; return the overdue ones for alerting.
  throw new Error('TODO: checkOverdueMonitors');
}

/**
 * Embedding canary: periodically re-embed a fixed probe set and compare to stored vectors. A provider
 * silently changing the model behind a version shifts the vector space — this catches the drift you
 * otherwise can't see (embedding_version only helps if YOU bump it).
 */
export async function runEmbeddingCanary(): Promise<{ drift: number; alarming: boolean }> {
  // TODO: embed the probe set, cosine-compare to baseline; alarm if drift exceeds a configured threshold.
  throw new Error('TODO: runEmbeddingCanary');
}

/**
 * Completeness critic: the eval-fixture set is NEVER "done". Mine real misses/low-rated answers for
 * scenarios the fixtures don't cover and propose new fixtures — coverage gaps are themselves silent failures.
 */
export async function proposeFixtureGaps(): Promise<Array<{ scenario: string; evidence: string }>> {
  // TODO: cluster recent misses; surface uncovered scenarios for human review → new fixtures.
  throw new Error('TODO: proposeFixtureGaps');
}
