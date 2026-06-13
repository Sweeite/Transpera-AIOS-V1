import { useState } from 'react';
import type { Answer } from '@aios/shared';
import { ProvenanceMessage } from '@/components/provenance/ProvenanceMessage';
import { ask } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The chat front door — the M0 tracer-bullet slice (Brief §7.1, issue #5/#38).
 * One box; the intent router decides query vs command server-side. This stub renders the query path:
 * ask → provenance-labelled answer (or abstention).
 *
 * NOTE: swap the textarea + bubble for prompt-kit's <PromptInput> + <Message>/<ChatContainer> once added
 * via the prompt-kit registry — they share these Tailwind tokens. The ProvenanceMessage stays ours.
 */

type Turn = { role: 'user'; text: string } | { role: 'brain'; answer: Answer };

// Demo answer so the slice renders before the API is wired (issue #5). Replace with `ask()`.
const DEMO: Answer = {
  abstained: false,
  claims: [
    { text: 'Acme prefers monthly reporting, delivered async.', label: 'memory', sourceId: 'mem_123', asOf: '2026-03-14' },
    { text: 'Their deal is currently in the Proposal stage.', label: 'live', sourceId: 'ghl:deal_456' },
    { text: 'Teams that report monthly often expect a mid-month nudge.', label: 'general-inference' },
  ],
};

export function ChatView() {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setTurns((t) => [...t, { role: 'user', text }]);
    setBusy(true);
    try {
      // TODO: const answer = await ask(text);
      const answer = DEMO; // placeholder until #5 wires the API
      void ask;
      setTurns((t) => [...t, { role: 'brain', answer }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col">
      <header className="border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold">AIOS — Brain</h1>
        <p className="text-xs text-muted-foreground">Ask anything. Answers carry honest provenance.</p>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">{turn.text}</div>
            </div>
          ) : (
            <div key={i} className="rounded-2xl border border-border bg-card p-3">
              <ProvenanceMessage answer={turn.answer} />
            </div>
          ),
        )}
        {busy && <p className="text-xs text-muted-foreground">checking sources…</p>}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask the brain…"
            className={cn(
              'flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-ring',
            )}
          />
          <button
            onClick={() => void send()}
            disabled={busy}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
