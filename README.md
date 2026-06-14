# AIOS — AI Business Brain

A durable, queryable, permission-safe organisational brain for agencies and consultancies. Captures the
perishable knowledge in people's heads, answers with honest provenance, and runs a workforce of agents.

## Docs (read in this order)

1. **[AIOS_Brief.md](AIOS_Brief.md)** — canonical product & architecture brief (the spine; everything derives from it).
2. **[AIOS_PRD.md](AIOS_PRD.md)** — buildable requirements, with the AI harness specced in depth.
3. **[AIOS_TechStack_Scaffolding.md](AIOS_TechStack_Scaffolding.md)** — stack, monorepo, build order, and §5 stack-limits/economics/ops.
4. **[AIOS_Issues.md](AIOS_Issues.md)** — the build broken into GitHub-ready issues (each carrying its inline audit fix), plus the audit-remediation reference.
5. **[AIOS_QA_Playbook.md](AIOS_QA_Playbook.md)** — how we prove each issue/milestone is built right; adversarial reviews, seam gates, and the final behavioural grill.
6. `AIOS_Explainer.html` — plain-language visual explainer (agents / memory / ingestion).
7. `AIOS_prototype.html` — rough UI canvas (superseded by the real `apps/brain` slice).

## Architecture in one breath (Brief §8.2 — three layers of separation)

- **Cross-client data — physical.** One Supabase project + one Railway service + a `pgmq` queue **per client**. No shared DB/queue, no cross-tenant query path.
- **Within-client users — logical.** Zone + sensitivity + namespace, fail-closed (Brief §9).
- **The code — shared, singular.** One sealed core image (`packages/core`), run identically everywhere; per-client variation is data or a rare plugin folder. You manage **one codebase**.

## Layout

```
packages/core/        ← THE SEALED ENGINE (harness, routing, memory, agents, workflows, rbac, db, hooks)
packages/plugin-sdk/  ← the only core surface a plugin imports
packages/api/         ← Fastify: REST + chat streaming
packages/worker/      ← async tier: routing gates, crons (pgmq, in the client's Supabase)
packages/shared/      ← domain types, defined once
plugins/              ← per-client code, loaded by TENANT_ID (folders, not forks)
apps/brain/           ← client-brain frontend   ·   apps/console/ ← operator dashboard (DEFERRED)
control-plane/        ← provisioning/migration scripts (built now)
deployments/          ← env + infra config only, zero logic
migrations/  ·  tests/{core,tenant-fixtures}  ·  docker/
```

## Status

Spec complete and pressure-tested (three adversarial passes). This is a **skeleton to clone and grow** —
stub files carry real signatures + spec references with `TODO` bodies. Start with the tracer-bullet slice
(tech-stack build step 0). Not yet a runnable app.
