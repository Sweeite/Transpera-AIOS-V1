# AIOS — Tech Stack & Scaffolding

*Companion to `AIOS_PRD.md`. Recommends a stack, justifies it against the brief's constraints, and lays out the monorepo with key file stubs.*

Version 0.1 — 13 June 2026

---

## 1. Stack recommendation (and why)

**TypeScript / Node.js monorepo.** Justification, against the brief's actual constraints:

- **The plugin architecture is already TS-shaped.** The architecture decision doc describes `core/engine.js`, hook registration, plugins loaded by tenant ID. That's a Node module-loading pattern. Building it in TS keeps the engine, plugins, and the prototype's eventual real frontend in one language.
- **One language across the stack** — engine, workers, both web apps (client brain + agency console), and the plugin SDK. Smaller team, less context-switching, shared types end-to-end (a `Memory` type defined once, used in the DB layer, the API, and the UI).
- **Postgres + pgvector is first-class in Node** (via `pg` / Drizzle / Prisma) — and Supabase *is* Postgres with pgvector built in, so the brief's whole data model drops straight in with no exotic store. Supabase also gives auth + storage for free.
- **The harness components map cleanly to TS libraries:** the Vercel AI SDK or the official Anthropic/OpenAI SDKs for the LLM gateway, **`pgmq` (Postgres-in-Supabase) for the worker/queue tier** (not Redis — isolation, §5.4), Zod for structured-output validation, all idiomatic.
- **Why not Python:** Python is the obvious default for ML, but you're not training models — you're orchestrating API calls and managing Postgres. Python would split the stack (Python engine + TS frontend), double the type definitions, and complicate the single-image deploy. The ML-grade libraries Python wins on aren't needed here.

**Supporting choices:**
- **Supabase (Postgres + pgvector)** — the data plane, one project per client. pgvector is built in. Also provides auth (authentication only — the engine still owns authorization) and storage. (Brief §4, §8.1a, §12)
- **Railway** — the compute plane, one engine service per client, running the Docker image. Chosen over Render for its scriptable provisioning API (the agency console depends on standing up clients programmatically); Render is an acceptable substitute. Railway runs the container only — the DB lives in Supabase. (§8.1a)
- **Drizzle ORM** — typed schema, lightweight, good migration story (matters: migrations run per-tenant across N Supabase projects as a control-plane job, §8.1a).
- **`pgmq` (Postgres-backed queue) inside each client's own Supabase** — the async worker tier for routing gates, ingestion, consolidation/decay crons. **No shared Redis** — a shared queue would be a cross-tenant data path and shared failure domain, which per-client isolation forbids (brief §8.2 layer 1). The worker runs within the per-client Railway service. (graphile-worker is an acceptable substitute; both keep the queue in the per-client data plane.) (§12)
- **Fastify** (or Nest if you want more structure) — the API layer.
- **Anthropic SDK** as primary LLM provider, with other providers behind the gateway abstraction — *generation* is routed multi-provider by task to save cost, quality-gated by eval fixtures. **Embeddings are pinned to one model+version** (recorded per vector row); never cost-routed; changing it is a gated full re-embed.
- **Docker** — single engine image, deployed per client to Railway. (§8.1a)
- **Frontend (locked)** — **Vite + React + TypeScript SPA**, not Next.js. The engine is a separate Fastify service, so Next's server layer (RSC/SSR/API routes) buys nothing here, and a Next server would add an always-on Node process *per client* against the cost/ops discipline (§5.1). A static SPA matches "one build, N runtimes" and is served by the engine container or a CDN. Everything is auth-gated, user-specific, streaming — no SEO, no SSR benefit.
  - **UI kit:** **shadcn/ui** (base: tables, forms, dialogs, tabs — the 12 dashboards + memory inspector + settings) + **prompt-kit** (the chat surface: prompt input, message, streaming, reasoning/trace). prompt-kit is *built on* shadcn/ui, so it's one Tailwind/Radix token system across chat and dashboards. Both are **copy-paste/owned** (source lives in the repo) — essential because the **provenance renderer, abstention states, agent-trace tree, and RBAC-gated rendering are custom and core**, not something to delegate to a black-box chat library. The kit gives ~70%; you own the differentiating ~30%.
  - **Data/charts:** TanStack Query (server state) + TanStack Table; Recharts (or Tremor) for dashboards. Supabase JS for auth → JWT → the engine resolves the principal.
  - **Two apps:** `apps/brain` (built) and `apps/console` (deferred, §8.4). The prototype HTML is a throwaway vision artifact — the real `apps/brain` M0 slice supersedes it; don't maintain both.

## 2. Monorepo layout

Workspaces (pnpm). The split mirrors the brief's sealed-core-plus-plugins decision (§8.2) and the two-products split (§8.4).

```
aios/
├── packages/
│   ├── core/                    ← THE SEALED ENGINE. Never knows a client exists.
│   │   ├── src/
│   │   │   ├── harness/         ← the AI runtime (PRD §6)
│   │   │   │   ├── gateway.ts          LLM gateway: routing, fallback, retry, structured output
│   │   │   │   ├── context.ts          context assembly + token budgeting
│   │   │   │   ├── retrieval.ts         hybrid RRF + reranker floor; selectivity-aware fail-closed filter (exact vs HNSW); namespace-scoped
│   │   │   │   ├── provenance.ts        label + abstention layer
│   │   │   │   ├── tools.ts             tool-calling loop + federation fetches + action confirmation gate (blast-radius)
│   │   │   │   ├── guardrails.ts        injection defence, anti-poisoning (trust-tiered writes), output validation, PII
│   │   │   │   ├── trace.ts             structured trace spans + cost accounting
│   │   │   │   └── monitors.ts          watching-the-watchers: dead-man's switch, embedding canary, completeness critic (§11.8)
│   │   │   ├── connectors/
│   │   │   │   └── adapter.ts           Connector interface + registry — the integration extension point (§10); structured vs unstructured
│   │   │   ├── routing/
│   │   │   │   └── gates.ts             §5 decision tree (Gate 2 = deterministic, no LLM)
│   │   │   ├── memory/
│   │   │   │   ├── store.ts             read/write/invalidate (invalidate-don't-overwrite)
│   │   │   │   ├── identity.ts          identity map: mention → canonical entity → per-SoR ids (read + write)
│   │   │   │   ├── consolidate.ts       cron: episodic→semantic, watermark + dup/contradict classifier + slots
│   │   │   │   └── decay.ts             cron: type-aware utility decay (SOPs exempt)
│   │   │   ├── agents/
│   │   │   │   ├── runner.ts            single-agent execution
│   │   │   │   └── orchestrator.ts      multi-agent delegation tree + clarification interrupt (pause/resume on durable task_state)
│   │   │   ├── workflows/
│   │   │   │   └── runner.ts            executes JSON workflow definitions from tenant DB
│   │   │   ├── intent/
│   │   │   │   └── router.ts            query vs command (chat front door)
│   │   │   ├── config/
│   │   │   │   └── system-config.ts     gated/scoped/bounded/audited tunables
│   │   │   ├── rbac/
│   │   │   │   └── permissions.ts       clearance model {allowed_zones, max_sensitivity}; fail-closed read filter + action authz (intersection w/ principal)
│   │   │   ├── db/
│   │   │   │   ├── schema.ts            Drizzle schema (memories[+entity_ref/attribute/value slots, zone, sensitivity], chunks[+zone, sensitivity], connector_schemas, connections[+trust_level], identity_map, ingestion_log, inbox_items, task_state, user_clearance/roles…; +embedding_model/version, +principal)
│   │   │   │   └── client.ts            per-tenant connection
│   │   │   └── hooks/
│   │   │       └── registry.ts          registerAgent/Step/Prompt/Scorer — the plugin boundary
│   │   └── package.json
│   │
│   ├── plugin-sdk/              ← types + helpers plugins import (the only core surface they touch)
│   │   └── src/index.ts
│   │
│   ├── api/                     ← Fastify app: REST + chat streaming. Loads core, mounts tenant.
│   │   └── src/server.ts
│   │
│   ├── worker/                  ← pgmq workers (in the client's own Supabase): ingestion gates, consolidation, decay, jobs; uses a SESSION-mode connection (§5.4)
│   │   └── src/index.ts
│   │
│   └── shared/                  ← types shared across everything (Memory, Provenance, Trace…)
│       └── src/types.ts
│
├── plugins/                     ← client custom code, isolated, loaded by tenant ID at boot
│   └── .gitkeep                       (e.g. meridian/custom-scorer.ts — kept rare, §8.3)
│
├── apps/
│   ├── brain/                   ← client-brain frontend — Vite+React+Tailwind+shadcn/ui+prompt-kit (SPA); ProvenanceMessage is the signature component
│   └── console/                 ← agency console frontend (the operator) — DEFERRED (§8.4); scripts only for now
│
├── control-plane/               ← provisioning/migration SCRIPTS (built now): provision-client, migrate-all, deploy-all (§8.4)
├── deployments/                 ← env + infra config ONLY, zero logic (§8.2)
│   └── _template/.env.example
│
├── migrations/                  ← per-tenant migrations, run by control-plane/migrate-all
├── tests/
│   ├── core/
│   └── tenant-fixtures/         ← eval cases: question → expected behaviour (PRD §6.10)
├── docker/Dockerfile
├── pnpm-workspace.yaml
└── package.json
```

**The load-bearing rule (§8.2):** `core/` contains no client name and no client-specific branch. Plugins extend via `hooks/registry.ts` only, and may never touch `gateway`, `rbac`, `db`, or billing. If two clients want the same plugin, it's promoted into core as config (§8.3).

## 3. Key file stubs

See the actual stub files generated alongside this doc under `scaffold/`. They are intentionally skeletal — real signatures and contracts, `TODO`-bodied — so the shape is right before logic is filled in. Highlights:

- `harness/gateway.ts` — the `callModel()` chokepoint with routing/fallback/structured-output.
- `routing/gates.ts` — the four-gate `route()` function, Gate 2 explicitly deterministic.
- `memory/store.ts` — `writeMemory()` with provenance/sensitivity/namespace, `invalidate()` not overwrite.
- `harness/retrieval.ts` — `retrieve()` that permission-filters at the vector layer.
- `harness/provenance.ts` — `labelAnswer()` and the abstention decision.
- `hooks/registry.ts` — the plugin boundary.
- `config/system-config.ts` — the gated/scoped/bounded/audited config accessor.

## 4. Build order (suggested)

**0. Tracer-bullet vertical slice first (before the machinery).** Manual SOP upload → embed → fail-closed retrieve → provenance-labelled answer → abstention. This exercises the riskiest core (retrieval + the embedding model + provenance) end-to-end on real data, validates the #1 one-way door (embedding choice — see §5), and produces a demoable artifact. Grow the gates/crons/agents around a spine that already works.

1. **DB schema + per-tenant connection** (`db/`) — everything sits on this. Every migration is **expand/contract** from row one (additive → deploy → cleanup), because the shared image must tolerate schema N and N-1 during fleet rollout (§5).
2. **system_config + RBAC** — needed by everything else, fail-closed from day one. **Adversarial leak fixtures the moment retrieval exists** (restricted user, cross-namespace, chunk leakage) — a leak found late is reputation-ending.
3. **LLM gateway + tracing** — the chokepoint; nothing calls a model directly. Includes **prompt caching of stable prefixes** + **per-client API keys** (BYO) from the start.
4. **Memory store + retrieval** — write, invalidate, hybrid fail-closed retrieve. **Validate the embedding model on real data before committing** (one-way door, §5).
5. **Routing gates + identity map** — ingestion can now decide and write; entity resolution sets namespaces (write) and powers federated fetch (read). Gate decisions land in the ingestion-decision log. Gate 3 runs a **cheap pre-classifier before the LLM** (LLM only on ambiguous items).
6. **Provenance + intent router + chat** — the front door works end to end.
7. **Agents + tools + orchestrator** — the workforce (incl. the clarification interrupt → the **Inbox**, the single per-user push destination — brief §7.5).
8. **Crons** (consolidate w/ dup-contradict classifier + slots, decay) + **eval harness + ingestion-miss audit** — the system maintains itself and watches its own blind spots; eval fixtures are the arbiter of config/self-improvement changes.
9. **Workflow runner + hooks/plugins** — extensibility.
10. **API + brain frontend + provisioning scripts** (`provision-client` = create Supabase project via Management API → run migrations → deploy Railway service via API; plus `migrate-all`/`deploy-all`). The operator-**console UI is deferred** (brief §8.4) — scripts ship now, dashboard later. Provisioning also **seeds the Identity Map from connected SoRs and kicks off the bounded cold-start backfill** (brief §10.3), so the brain answers live from day one.

Each step is independently testable and maps to a PRD acceptance criterion.

---

## 5. Stack limitations, economics & operations

*Output of the third (scoped) adversarial pass: stack limits, unit economics, and the operational disciplines that protect the model. The product architecture survived two prior passes; this one targets ops/economics, where the real risks live for a fleet of isolated client deployments.*

### 5.1 Commercial model (the lens for everything below)

Pricing: **$15k upfront** (setup: provisioning, integration config, cold-start ingest, SOP-capture sessions) + **$3.5k/month** (maintenance + consulting). **The client pays both API *and* infra directly (BYO keys + their own Supabase/Railway billing).** This is a **managed-service model, not per-seat SaaS**, and it changes the economics conclusions:

- **Margin is purely labor-bound.** API *and* infra are pass-through (the client's bill), so neither touches your P&L. Recurring COGS is ≈ $0 → the $3.5k/mo is **essentially pure labor margin**, *regardless of client size*. The "fixed floor makes small clients marginal" concern only applied to a per-seat SaaS model — it does **not** apply here; the *only* constraint is hours-per-client.
- **The real constraint is hours-per-client.** $3.5k/mo stays ~90% margin only if maintenance/consulting doesn't eat your time. So provisioning automation, fleet alerting, expand/contract migrations, and secrets tooling (§5.4) are not neutral plumbing — **they protect the labor margin**, and they're why the operator console (deferred UI, brief §8.4) is clearly worth building eventually.
- **Cost levers (§5.3) now protect the *client's* pass-through bill**, not your margin — a competitiveness/retention lever (a client balking at $700/mo of API on top of $3.5k), still worth pulling.

### 5.2 Stack limitations (ranked by what actually matters)

| # | Limitation | Severity | Mitigation |
|---|---|---|---|
| 1 | **Provisioning keystone rests on two young-vendor *secondary* APIs** (Supabase Management + Railway). Rate limits, gaps, non-instant project creation. | High | Wrap both behind a provider-interface (also serves the "portable later" promise); idempotent, resumable provisioning (§5.4). |
| 2 | **Compliance/certs**: Supabase OK on higher tiers (SOC 2/HIPAA, regions — one-project-per-client is a residency *advantage*); **Railway is thin**. Gates larger prospects. | High (GTM) | Launch on Railway for the initial ICP; provider-abstraction lets a SOC 2-credible host (Fly/ECS/Cloud Run) drop in **per-client when a deal requires it**; pursue SOC 2 readiness after ~5 clients. |
| 3 | **All-TS → embeddings + reranker become hosted-API dependencies** on the hot path (Python/GPU-native otherwise). | Medium | Treat the embedding/reranker as a **separate service behind the gateway** (can be Python/GPU, language-agnostic), not "just an API call." |
| 4 | **pgvector + Supabase compute sizing** under real backfill: HNSW is RAM-hungry; `chunks` can balloon. | Medium | Selective writes + 90-day chunk TTL bound growth; size compute to keep the active index in RAM; monitor index size as a health metric; throttle backfill. |
| 5 | **Single data-plane vendor = correlated failure** (Supabase-wide outage hits all clients at once). | Medium | Accepted for now; containerised/portable compute covers the other half; revisit at scale. |
| 6 | **`pgmq` younger than BullMQ** (thinner retry/priority, poll-based). | Low | Per-tenant volume is low; behind a queue interface, swappable. |

### 5.3 Cost levers (protect the client's pass-through API bill)

Directionally takes a 35-person client's **variable** spend ~$710 → ~$365/mo. Real engineering, not free:
1. **Prompt caching of stable prefixes** (system prompt, persona, tool defs) — ~90% off cached input tokens; near-free to implement.
2. **Multi-model routing, actually executed** — cheap model for simple queries given good retrieval (already specced; this is where it pays).
3. **Embedding-based pre-classifier in front of Gate 3** — resolve obvious cases (newsletters, noise) without an LLM call; LLM only on ambiguous items. Cuts Gate-3 LLM volume 50–70%.
4. **Conditional provenance verification** — verify only low-confidence/high-stakes answers, not every answer.

Architectural cost *advantage* worth naming: selective writes + decay + TTL keep per-client data and retrieval cost **flat over time**, where naive store-everything RAG compounds forever.

### 5.4 Operational disciplines (decided)

1. **Expand/contract migrations** — mandatory on every schema change; the shared image must tolerate schema N and N-1 during rollout. `migrate-all` reports per-project status and halts `deploy-all` to un-migrated projects.
2. **Secrets** — per-client secrets encrypted in the client's *own* Supabase (Supabase Vault) + per-client (BYO) LLM keys; **never in the shared image**. Rotation runbook before client 2.
3. **Fleet alerting day one** — heartbeat + error rate to Sentry/uptime ping (the "health-without-data" channel, alerts only). The console *dashboard* is deferred; flying blind is not.
4. **Per-client LLM keys/quotas** — BYO keys give clean cost attribution and **eliminate the noisy-neighbor rate-limit gap** (the one tier not otherwise isolated).
5. **Idempotent, resumable provisioning** — state machine (`pending → db_created → migrated → deployed → seeded`) with teardown on failure; no orphaned paid projects, no manual cleanup.
6. **PITR as a paid tier** — clients who need point-in-time recovery pay for it; others get daily backups (trims the small-client infra floor, though the floor is immaterial under the $3.5k model).

### 5.5 The one-way doors (hardest to unwind — get these right early)

1. **Embedding model** — changing it = re-embed every client's corpus + re-calibrate the floor. Validate on real data before committing (build step 0/4).
2. **RBAC clearance model + fail-closed filter** — a leak found late is catastrophic; adversarial fixtures from day one.
3. **One-project-per-client isolation** — reversing to shared-RLS later is a massive migration; committed and correct, but a one-way door.
4. *(Low risk:)* `pgmq`, Fastify, frontend framework — all swappable behind interfaces.

---

*Stubs live in `scaffold/`. This is a skeleton to clone and grow, not a runnable app yet.*
