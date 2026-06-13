# apps/console — agency operator dashboard — DEFERRED (Brief §8.4)

Not built now. Fleet health, cross-tenant cost, registries — its own repo/deploy later, talking to clients
only through health-without-data APIs. **What ships now is the `control-plane/` provisioning scripts**, not this UI.

Day-one operability without this UI = fleet alerting (heartbeat + error rate to Sentry, tech-stack §5.4).
