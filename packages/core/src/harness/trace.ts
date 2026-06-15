/**
 * The TRACE store (PRD §6.9) — one of the two observability stores, with the OPPOSITE properties of the audit
 * log (audit/audit-log.ts). NEVER conflate them:
 *   traces    — MAY hold content, EPHEMERAL (TTL-pruned), permission-TAGGED (filtered on read like memories/
 *               chunks). This file. Powers the activity log, cost monitor, quality monitor.
 *   audit_log — NEVER content, PERMANENT (append-only, never pruned), tamper-evident hash chain. Other file.
 * (The audit `auditEvent`/permission-change class re-homed to audit/events.ts — keeping the stores unconflated.)
 *
 * THE CLEARANCE TAG (the Watch — "don't let a trace become a permanent shadow copy that bypasses the
 * permission model"): every span row carries `zone` + `sensitivity_level` + `namespace`, the SAME columns
 * memories/chunks carry, so a future trace READ (#37/#32) filters with rbac.retrievalWhereSql VERBATIM. The
 * tag is the clearance of the CONTENT the span carries (NOT the principal's authority) — so a later reader is
 * gated by what the content IS. `emitSpan` REQUIRES the tag (compile-time) — a span can't be written untagged.
 *
 * (The filtered READ itself is #37/#32; #11 owns the COLUMN + the write-time tag.)
 */
import type { Namespace, Principal, SensitivityLevel, TraceSpan, Zone } from '@aios/shared';
import type { QueryFn } from '../audit/audit-log.js';
import type { GatewaySpan } from './gateway.js';
import { defaultFor } from '../config/system-config.js';

/** The fail-closed sentinel for an unknown / multi-valued zone or namespace: no clearance's allowed list ever
 *  contains it, so a span tagged with it is invisible to everyone until tagged with a real, single value. */
export const UNTAGGED = '_untagged';
/** The max sensitivity ceiling — the fail-closed default when no content sensitivity is known. */
const MAX_SENSITIVITY: SensitivityLevel = 5;

/** A span's content clearance tag — mirrors the memory/chunk access label so the same predicate filters it. */
export interface ClearanceTag {
  zone: Zone | typeof UNTAGGED;
  sensitivityLevel: SensitivityLevel;
  namespace: Namespace | typeof UNTAGGED;
}

/** One content source the span touched — its access label (a retrieved memory/chunk carries exactly these). */
export interface TagSource {
  zone: Zone;
  sensitivityLevel: SensitivityLevel;
  namespace: Namespace;
}

/**
 * Derive a span's tag from the content it carried. Zones are UNORDERED — there is no sound "union zone", so a
 * MULTI-zone span gets the fail-closed sentinel (invisible to any single-zone clearance), never one picked
 * zone. Same for namespace. Sensitivity IS ordered, so it takes the MAX (the most restrictive). A span that
 * carried NO content gets the fully fail-closed sentinel tag (a caller that knows a span is content-free tags
 * it explicitly instead).
 */
export function tagFromSources(sources: TagSource[]): ClearanceTag {
  if (sources.length === 0) return { zone: UNTAGGED, sensitivityLevel: MAX_SENSITIVITY, namespace: UNTAGGED };
  const zones = new Set(sources.map((s) => s.zone));
  const namespaces = new Set(sources.map((s) => s.namespace));
  const maxSensitivity = sources.reduce<SensitivityLevel>((m, s) => (s.sensitivityLevel > m ? s.sensitivityLevel : m), 1);
  return {
    zone: zones.size === 1 ? [...zones][0]! : UNTAGGED,
    sensitivityLevel: maxSensitivity,
    namespace: namespaces.size === 1 ? [...namespaces][0]! : UNTAGGED,
  };
}

/** The span payload `emitSpan` writes — a `TraceSpan` minus the DB-assigned `id`. */
export type SpanInput = Omit<TraceSpan, 'id'>;

export interface TraceDeps {
  query: QueryFn;
  /** LOUD alarm for a trace write failure (never silent — the observability layer's own failure is the one you
   *  can't otherwise see). Defaults to stderr. The write is non-fatal to the caller (see emitSpan / gatewayOnSpan). */
  onError?: (err: unknown, span: SpanInput) => void;
}

function defaultOnError(err: unknown, span: SpanInput): void {
  console.error(
    `[traces] WRITE FAILED for a ${span.kind} span (task=${span.taskId}, model=${span.model ?? 'n/a'}): ` +
      `${err instanceof Error ? err.message : String(err)}. The trace was NOT recorded — observability gap, ` +
      `but the originating call is NOT failed for it (non-fatal). Audit_log is unaffected.`,
  );
}

/**
 * Write one span to the `traces` store, tagged with the content's clearance. `created_at` (the TTL clock) and
 * `id` are DB-assigned. WRITE-PATH LOUDNESS ASYMMETRY (vs the audit log): a trace write failure is LOUD (logged
 * / alertable) but RETHROWN here so a direct caller can decide; the gateway wiring (gatewayOnSpan) makes it
 * NON-fatal (a trace-store hiccup must never crash a model call). Either way it is never silently swallowed.
 */
export async function emitSpan(span: SpanInput, tag: ClearanceTag, deps: TraceDeps): Promise<string> {
  try {
    const inserted = await deps.query(
      `INSERT INTO traces
         (task_id, agent, principal, trigger, kind, model, tokens_in, tokens_out, cost_usd, duration_ms, rating,
          zone, sensitivity_level, namespace)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        span.taskId,
        span.agent ?? null,
        JSON.stringify(span.principal),
        span.trigger,
        span.kind,
        span.model ?? null,
        span.tokensIn ?? null,
        span.tokensOut ?? null,
        span.costUsd ?? null,
        span.durationMs,
        span.rating ?? null,
        tag.zone,
        tag.sensitivityLevel,
        tag.namespace,
      ],
    );
    return String(inserted.rows[0].id);
  } catch (err) {
    (deps.onError ?? defaultOnError)(err, span); // LOUD — surfaced, never swallowed
    throw err; // direct callers decide; gatewayOnSpan catches → non-fatal
  }
}

/** The run context the gateway does NOT own — supplied by the caller that wires the sink. */
export interface SpanContext {
  taskId: string;
  principal: Principal;
  trigger: TraceSpan['trigger'];
  agent?: string;
  /** The clearance of the content fed to this call — see tagFromSources. */
  contentTag: ClearanceTag;
}

/**
 * Wire the gateway's `onSpan` (GatewaySpan) → `emitSpan` (a kind='model' trace), folding in the run context the
 * gateway can't see (taskId/principal/trigger/agent) + the content tag. The returned sink is fire-and-forget +
 * NON-FATAL: emitSpan already logs loud on failure, so the catch here just prevents a trace hiccup from
 * crashing the model call. Records EVEN a failed call (ok=false): the spend is real and the failure alertable.
 */
export function gatewayOnSpan(ctx: SpanContext, deps: TraceDeps): (gw: GatewaySpan) => void {
  return (gw) => {
    const span: SpanInput = {
      taskId: ctx.taskId,
      principal: ctx.principal,
      trigger: ctx.trigger,
      kind: 'model',
      model: gw.model,
      durationMs: gw.durationMs,
      ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
      ...(gw.tokensIn !== undefined ? { tokensIn: gw.tokensIn } : {}),
      ...(gw.tokensOut !== undefined ? { tokensOut: gw.tokensOut } : {}),
      ...(gw.costUsd !== undefined ? { costUsd: gw.costUsd } : {}),
    };
    void emitSpan(span, ctx.contentTag, deps).catch(() => {
      /* already logged loud in emitSpan; non-fatal to the model call */
    });
  };
}

/**
 * Auto-prune: delete traces older than `trace_ttl_days` (§6.9). Idempotent (re-running deletes nothing new) and
 * touches `traces` ONLY — the audit log is PERMANENT and is never in scope here. Returns the number pruned.
 * `ttlDays` overrides the bounded config default (used by tests); production reads the declared default.
 */
export async function pruneTraces(query: QueryFn, opts: { ttlDays?: number } = {}): Promise<number> {
  const ttlDays = opts.ttlDays ?? (defaultFor('trace_ttl_days') as number);
  const { rows } = await query(
    `DELETE FROM traces WHERE created_at < now() - make_interval(days => $1) RETURNING id`,
    [ttlDays],
  );
  return rows.length;
}
