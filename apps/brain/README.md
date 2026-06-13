# apps/brain — client-brain frontend (agency staff)

**Stack (locked):** Vite + React + TypeScript · Tailwind v4 · **shadcn/ui** (base) + **prompt-kit** (chat surface) · TanStack Query + TanStack Table · Recharts · Supabase JS (auth → JWT → engine resolves principal).

A **static SPA** that talks to the per-client Fastify engine (`packages/api`). No SSR: the engine is the backend, and a static build keeps the "one build, N runtimes" model and avoids an extra Node process per client (tech-stack §1).

## Why this stack
- **prompt-kit is built on shadcn/ui** → one Tailwind/Radix token system across chat *and* the 12 dashboards.
- **Copy-paste ownership** (shadcn + prompt-kit drop source into the repo) — essential because the **provenance renderer, abstention states, agent-trace tree, and RBAC-gated rendering are custom and core**, not something to hand to a black-box chat lib.
- The kit gives ~70% (chat shell, input, markdown, streaming, tables, forms); you own the differentiating ~30%.

## Layout
```
src/
├── main.tsx · App.tsx               app shell (QueryClient; add router as it grows — Brief §13 nav)
├── index.css                        Tailwind v4 + shadcn tokens + the provenance palette
├── lib/{utils,api}.ts               cn() helper · thin client to /api (Supabase JWT → principal)
├── components/
│   ├── ui/                          shadcn components (add via `npx shadcn@latest add …`)
│   └── provenance/ProvenanceMessage.tsx   ← the signature component (Brief §6): per-claim labels, abstention
└── features/chat/ChatView.tsx       the M0 tracer-bullet slice: ask → provenance answer / abstention
```

## Getting started
```bash
pnpm install
# add the base components (run from this dir):
npx shadcn@latest init           # writes full token set + components/ui
npx shadcn@latest add button textarea card badge table dialog tabs
# add chat primitives from the prompt-kit registry:
#   see prompt-kit.com — add PromptInput, Message, ChatContainer, Markdown, Reasoning, Loader
pnpm --filter @aios/brain dev
```

## Build order (issue #38)
1. M0 slice (this) → wire `ask()` to `POST /api/chat` (#5), swap textarea/bubble for prompt-kit `PromptInput`/`Message`.
2. Grow nav: Knowledge (memory inspector) · Work · Agents · Automate · Observe (the 12 dashboards) · Admin.
3. Provenance, abstention, and agent-trace components stay ours; the prototype HTML is superseded — don't maintain two.
