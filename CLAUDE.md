# CLAUDE.md — AIOS

Orientation for every session. AIOS is a **durable, queryable, permission-safe organisational brain** for agencies — captures perishable knowledge, answers with honest provenance, runs a workforce of agents. Sold per-client, isolated per-client, one shared codebase.

**The spine rule (governs everything):** materialise into memory ONLY if it's *not* already a field in a system of record AND it has lasting interpretive value. Current-state facts are fetched **live**; on conflict the SoR wins.

## Canonical docs (the source of truth — read as needed, don't re-graze every session)
- **AIOS_Brief.md** — the spec everything derives from (the spine).
- **AIOS_PRD.md** — requirements + the AI harness in depth.
- **AIOS_TechStack_Scaffolding.md** — stack, monorepo, build order, §5 economics/ops/limits.
- **AIOS_Issues.md** — the 52 build issues. Each carries an inline **⚠ Audit fix** and a **Model** line. On GitHub: `gh issue view N`.
- **AIOS_QA_Playbook.md** — how we prove each piece is built right. **This is the process. Follow it.**
- **AIOS_Explainer.html** — plain-language system map (agents / memory / ingestion).

## How we work (non-negotiable discipline)
- Build to the issue's **Acceptance criteria** and its inline **⚠ Audit fix**. Follow the QA Playbook's per-issue loop: **test-first → build → probe → read the trace → refactor.** ("Probe" = spend 10 min actively trying to make the unit leak / fail silently / lie.)
- Don't advance a milestone while its gate is red. **Leak fixtures (#36) green every milestone** — RBAC never regresses.
- **Eval fixtures are the arbiter** of every quality decision — never the live metric a change mechanically moves.
- Any bug found becomes a **permanent regression test**.
- Plan before non-trivial work; for one-way-door issues (e.g. #1, #9, #13, #23) present a plan and wait for approval.
- **Commits & closing issues:** reference issues PLAINLY in commit messages (`Issue #N: …`, `seam for #13`, `see #13`) — **never** closing keywords (`closes/fixes/resolves #N`), which auto-close issues you only *referenced* (this silently false-closed #13 once). Close issues explicitly with `gh issue close N` **only after review approval**, and `git push` after every commit.

## Red lines (true at every gate)
- ❌ **No permission leak — ever.** Fail-closed: every unverified permission/namespace defaults to deny/empty.
- ❌ **No silent failure** — if it can fail, it must emit a trace and be alertable. Errors are surfaced, never swallowed.
- ❌ **No model/provider call outside `packages/core/src/harness/gateway.ts`** (CI test #46 enforces this).
- ⚖️ **Every threshold/weight/floor is a bounded `system_config` key** — no magic numbers in code.

## Invariants easy to violate (check these every time)
- `core/` knows **no client** — no client names, no client branches. Client-specific = config/data or a `plugins/<tenant>` folder.
- Every run carries a **`principal`**, inherited down the delegation tree; per-user tokens never available to service-triggered runs.
- Empty `allowed_zones` → `WHERE false`, **never** an empty `IN` (the fail-OPEN leak).
- Stamp `connection.trust_level → Provenance.trustLevel` at routing time (anti-poisoning depends on it).
- Memory back-references are typed **`memory_links`** edges, not a flat `source_refs` string[].
- One **pinned embedding model+version** on every vector; changing it = full re-embed, not a flag.
- Migrations are **expand/contract** (the shared image must tolerate schema N and N-1).
- Queue is **pgmq inside the client's Supabase** (no Redis); the **worker uses the SESSION-mode** connection.
- `chunks` carry `zone` + `sensitivity` and are permission-filtered exactly like `memories`.
- Provenance is **per-claim** (cite source per claim; uncited → general-inference by exclusion), not per-span.

## Three layers of separation (never conflate)
1. **Cross-client data — physical:** own Supabase + Railway + queue per client. No cross-tenant query path.
2. **Within-client users — logical:** zone + sensitivity + namespace, fail-closed (Brief §9).
3. **Code — shared, singular:** one sealed-core image; per-client variation is data or a plugin folder. **One codebase.**

## Layout
`packages/core` (THE SEALED ENGINE — harness, routing, memory, identity, agents, workflows, rbac, config, connectors, hooks) · `plugin-sdk` · `api` (Fastify) · `worker` (pgmq) · `shared` (types, defined once). `apps/brain` (Vite + React + Tailwind + shadcn/ui + prompt-kit) · `apps/console` (DEFERRED). `control-plane` (provision/migrate/deploy scripts) · `plugins/` (by tenant id) · `tests/{core,tenant-fixtures}`.

## Models
**Opus 4.8, high effort (`/fast`), for the whole build.** The work is mostly security-critical/subtle, and on Max the cost is quota, not dollars. ⚙️ plumbing issues are the **conserve-to-Sonnet lever** *only if* you're rationing Max limits — otherwise stay on Opus. All reviews / QA / grills / hard bugs → Opus, always. (Criticality is still in each issue header: 🔒 fail-closed · 🧠 differentiator · ⚙️ plumbing.)

## Build order
M0 tracer slice (#1→#5) → M1 foundations → M2 memory → M3 ingestion+identity → M4 chat → M5 agents → M6 lifecycle → M7 workflows → M8 surfaces+ops. **Front-load the leak fixtures (#36) + CI (#51)** alongside M0.

## Handy commands
- `gh issue view N` — read an issue (source of truth; has its Model line + ⚠ Audit fix)
- `gh issue list --milestone M0` / `--label model:opus`
- `pnpm --filter @aios/<pkg> dev|test|typecheck` · `pnpm -r build`
