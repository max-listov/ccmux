---
title: Verify a host-declared model registry against the provider that must serve it
description: Let the execution host prove its declared model registry is actually servable, instead of discovering a typo at the first turn.
type: task
status: inbox
created: 2026-08-31
updated: 2026-08-31
priority: P2
---

## Problem and evidence

The Custom runtime's model registry is host-authored configuration: `src/agent/custom/config.ts`
declares each model identity, context window and capabilities, and `src/agent/custom/catalog.ts`
publishes exactly that list as an owner-authorized registry. This is deliberate — the catalog is
not a vendor inventory, and no inference process is started to read it.

The gap is that nothing ever confirms the declaration is true. A model identity that the provider
does not serve, a context window larger than the one actually loaded, or a declared `tools`
capability the served model lacks all pass configuration validation and fail later, during a turn,
as a provider error attributed to the run rather than to the configuration that caused it.

The cost is highest exactly where declaration is most error-prone: an endpoint whose served model
set changes without the configuration changing, so the registry silently drifts out of truth.

## Result

- An explicit, host-initiated check reports, per declared model, whether the configured provider
  currently serves it and whether the declared facts contradict what the provider reports.
- The check is a diagnostic, never a startup dependency and never an implicit turn-time probe:
  an unreachable provider makes the check report "unknown", not "invalid".
- Contradictions the provider genuinely reports (unknown model id, smaller context window) are
  distinguished from facts the provider does not publish, which stay declared and unverified.

## Boundaries

Not model discovery and not auto-population of the registry: the host decides what it authorizes,
and a provider listing a model is not authorization to use it. Not a capability benchmark — whether
a model is good at tool calls is not a fact an endpoint can be asked for.
