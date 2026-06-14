/** @aios/core — the sealed engine. Public surface for @aios/api and @aios/worker. */

// Harness (the AI runtime, PRD §6)
export * as gateway from './harness/gateway.js';
export * as retrieval from './harness/retrieval.js';
export * as synthesis from './harness/synthesis.js';
export * as context from './harness/context.js';
export * as provenance from './harness/provenance.js';
export * as tools from './harness/tools.js';
export * as federation from './harness/federation.js';
export * as guardrails from './harness/guardrails.js';
export * as trace from './harness/trace.js';
export * as monitors from './harness/monitors.js';

// Connectors (the integration extension point — Brief §10)
export * as connectors from './connectors/adapter.js';

// Routing, memory, identity, lifecycle
export * as gates from './routing/gates.js';
export * as memoryStore from './memory/store.js';
export * as identity from './memory/identity.js';
export * as consolidate from './memory/consolidate.js';
export * as decay from './memory/decay.js';

// Agents, workflows, intent
export * as agentRegistry from './agents/registry.js';
export * as agentRunner from './agents/runner.js';
export * as orchestrator from './agents/orchestrator.js';
export * as workflowRunner from './workflows/runner.js';
export * as intent from './intent/router.js';

// Cross-cutting
export * as systemConfig from './config/system-config.js';
export * as rbac from './rbac/permissions.js';
export * as hooks from './hooks/registry.js';
export * as db from './db/client.js';
