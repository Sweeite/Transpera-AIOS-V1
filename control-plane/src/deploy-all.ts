/**
 * deploy-all — roll the single shared engine image to every client's Railway service (Brief §8.2, §8.4).
 * One image, N isolated runtimes. Only deploys to projects whose schema is current (gated by migrate-all).
 */
export async function deployAll(_args: { imageTag: string }): Promise<{ deployed: string[]; skipped: string[] }> {
  // TODO: skip un-migrated projects (expand/contract safety); per-client version + rollout state.
  throw new Error('TODO: deployAll');
}
