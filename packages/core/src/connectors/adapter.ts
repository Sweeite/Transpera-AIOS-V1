/**
 * Connector adapter interface + registry — the first-class extension point for integrations (Brief §10, §12).
 * "Add an integration" = implement this interface + register it. Adding the 5th or 20th is uniform, not bespoke.
 *
 * Two kinds (Brief §5, §10.1):
 *   - structured (Gate-2 eligible: tags field metadata, schema-backed, fetch-live)   e.g. GHL, Xero, Asana
 *   - unstructured (interpretive by default, skips Gate 2)                            e.g. Gmail, Drive, meeting-bot
 */
import type { IncomingItem } from '../routing/gates.js';
import type { Principal } from '@aios/shared';

export interface ConnectorMeta {
  type: string; // 'ghl' | 'gmail' | 'xero' | 'asana' | 'meeting-bot' | ...
  structured: boolean; // drives Gate 2 (§5)
  live: boolean; // live (fetch current-state) vs interpretive
  ownership: 'org' | 'per-user'; // tier (§10.1)
  defaultTrust: 'high' | 'low'; // anti-poisoning: gates promotion to semantic (§5, §6.7)
  defaultSensitivity?: number; // e.g. meeting-bot is conservative (§10.2)
}

export interface Connector {
  meta: ConnectorMeta;

  /** Pull new/changed content as IncomingItems for the routing gates. Used for sync + cold-start backfill (§10.3). */
  sync(args: { since?: string; principal: Principal; limit?: number }): AsyncIterable<IncomingItem>;

  /** Live current-state fetch by canonical-entity external id — federation-on-read (§4.9, §4.10). Deadline-bounded by caller. */
  fetchLive(args: { externalId: string; fields?: string[]; principal: Principal }): Promise<Record<string, unknown>>;

  /** Structured connectors expose their field schema → feeds connector_schemas + drift detection (§5). Empty for unstructured. */
  schema(): Promise<Array<{ field: string; type: string }>>;

  /** Resolve the credential/token for this run's principal. Per-user connectors require a user principal (§7.5). */
  authFor(principal: Principal): Promise<{ token: string } | null>;

  /** Cheap liveness for the connections-health dashboard + fleet alerting (§11.9, tech-stack §5.4). */
  healthCheck(): Promise<{ ok: boolean; lastSyncAt?: string; detail?: string }>;
}

const registry = new Map<string, Connector>();

/** Register a connector by type. Core ships the common ones; plugins MAY register more via the SDK (§8.2). */
export function registerConnector(c: Connector): void {
  registry.set(c.meta.type, c);
}

export function getConnector(type: string): Connector | undefined {
  return registry.get(type);
}

export function listConnectors(): Connector[] {
  return [...registry.values()];
}
