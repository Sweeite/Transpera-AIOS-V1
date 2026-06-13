import type { Answer, Claim, ProvenanceLabel } from '@aios/shared';
import { cn } from '@/lib/utils';

/**
 * The signature, product-defining component (Brief §6). Renders an answer per CLAIM, each tagged with
 * where it came from. "General inference" is rendered visually distinct and never as a business fact.
 * This is the differentiating ~30% you build on top of prompt-kit's message primitives — own it.
 */

const LABEL_META: Record<ProvenanceLabel, { text: string; chip: string; dot: string }> = {
  memory: { text: 'I know this', chip: 'text-[--color-prov-memory] border-[--color-prov-memory]/30 bg-[--color-prov-memory]/5', dot: 'bg-[--color-prov-memory]' },
  live: { text: 'This is live', chip: 'text-[--color-prov-live] border-[--color-prov-live]/30 bg-[--color-prov-live]/5', dot: 'bg-[--color-prov-live]' },
  'failed-fetch': { text: "Couldn't reach source", chip: 'text-[--color-prov-failed] border-[--color-prov-failed]/30 bg-[--color-prov-failed]/5', dot: 'bg-[--color-prov-failed]' },
  'general-inference': { text: 'General inference', chip: 'text-[--color-prov-inference] border-dashed border-[--color-prov-inference]/40 bg-transparent italic', dot: 'bg-[--color-prov-inference]' },
};

function ProvenanceChip({ label, asOf }: { label: ProvenanceLabel; asOf?: string }) {
  const m = LABEL_META[label];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', m.chip)}>
      <span className={cn('size-1.5 rounded-full', m.dot)} />
      {m.text}
      {asOf && <span className="opacity-70">· as of {asOf}</span>}
    </span>
  );
}

function ClaimRow({ claim }: { claim: Claim }) {
  const isInference = claim.label === 'general-inference';
  return (
    <div className={cn('flex flex-col gap-1 py-1', isInference && 'opacity-80')}>
      <p className={cn('text-sm leading-relaxed', isInference && 'italic text-muted-foreground')}>{claim.text}</p>
      <div className="flex items-center gap-2">
        <ProvenanceChip label={claim.label} asOf={claim.asOf} />
        {claim.sourceId && claim.label === 'memory' && (
          <button className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">source</button>
        )}
      </div>
    </div>
  );
}

/** Abstention is a first-class state, not an error — the brain says "I don't know" honestly (Brief §6). */
function Abstention() {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">I don't have durable knowledge on this.</p>
      <p className="mt-1">
        Here's what the systems of record show — and want me to capture an answer if someone knows?
      </p>
      {/* TODO: render any live SoR results here; offer a "teach the brain" action that seeds a memory. */}
    </div>
  );
}

export function ProvenanceMessage({ answer }: { answer: Answer }) {
  if (answer.abstained) return <Abstention />;
  return (
    <div className="divide-y divide-border/60">
      {answer.claims.map((claim, i) => (
        <ClaimRow key={i} claim={claim} />
      ))}
    </div>
  );
}
