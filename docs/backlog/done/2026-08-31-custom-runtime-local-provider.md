---
title: Host-owned local model provider for the Custom runtime
description: Compose a local OpenAI-compatible model adapter in the existing Custom harness without moving endpoints or credentials into control requests.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 21:43 +0700
priority: P1
---

## Problem and evidence

Published v0.39.39 supports Custom execution through a host-owned launch recipe, but its provider
configuration only accepts `kind: openrouter` (`src/agent/custom/config.ts`). The engine registers
only `providers.openrouter` (`src/agent/custom/engine.ts`), and host preparation unconditionally
requires that provider credential (`src/agent/custom/host.ts`). A local LM Studio endpoint cannot
be selected by host configuration. Setting a local model's provider identity does not add an
adapter; disguising a local endpoint as OpenRouter would lose provider identity and capabilities.

The native OpenCode adapter is a different runtime, not acceptance of local models through the
Custom Stitchkit harness. The existing active inbox/in-progress directories contain no matching task.

## Result

- Host-owned, typed local-provider composition in the existing Custom runtime. Endpoint and
  optional authentication stay on the execution host; callers pass only recipe revision and
  model selection. No endpoint, env path, signing secret or arbitrary executable in public input.
- Reuse an appropriate published provider adapter and the existing Stitchkit harness. Do not
  introduce another inference loop, canonical store, transport or hidden cloud fallback.
- Recipe identity/digest pins provider configuration and supported model selection. Native
  model/provider, usage and terminal evidence preserve the actual source and uncertainty.
- Keep signed approvals, contained file tools, command isolation, exact retry/restart and
  workspace ownership. Local-provider secrets must not enter command environments or metadata.

## Acceptance

- [x] Config parses a host-owned local provider; OpenRouter continues to work unchanged.
- [x] Native catalog and selected model preserve local provider identity; unsupported selection
      refuses before durable admission/provider submission.
- [x] Text, streamed tool calls and terminal reason tested with the actual provider adapter;
      tool-only output is not invented into a successful text reply.
- [x] Endpoint unavailable, malformed stream, cancellation and response uncertainty have typed
      outcomes; no automatic cloud reroute or duplicated side-effecting prompt.
- [x] Existing signed approval/restart/receipt tests remain green. Real local acceptance uses
      an explicitly selected model from the configured catalog and records model/runtime versions.
- [x] Publish client/runtime/config documentation and exact release checks. Do not claim that
      an installed binary alone configures a local endpoint or proves every model works.

## Что сделано

### Runtime
- [x] `src/agent/custom/config.ts` — `CustomProviderSchema` is a discriminated union: `openrouter`
      with a required credential env, `local` with an endpoint and an optional one. The existing
      rule that a model's declared provider must equal the host adapter now selects between them,
      so a local model carries `provider: 'local'` and is never disguised as the aggregator.
- [x] `src/agent/custom/endpoint.ts` (new) — locality decided from the address literal, with no name
      resolution, so a schema performs no I/O and a later DNS answer cannot move the boundary.
      `localhost`, loopback, RFC 1918, link-local and IPv6 unique-local/link-local are accepted;
      embedded credentials, query, fragment, non-http protocols and public addresses are refused,
      each by its own named reason.
- [x] `src/agent/custom/provider.ts` (new) — composes the published adapter for the configured kind
      into the same two-method provider the model registry consumes. Local uses
      `@ai-sdk/openai-compatible@3.0.41`, whose `@ai-sdk/provider` and `provider-utils` versions are
      exactly those already installed under `ai@7.0.85`, so no second copy of the model types exists.
      No request path, inference loop, canonical store or transport was written here.
- [x] `src/agent/custom/engine.ts` — the provider registry is keyed by the configured kind instead
      of the literal `openrouter`.
- [x] `src/agent/custom/host.ts`, `src/config/launchRecipes.ts` — a credential is required exactly
      when the provider declares one. Recipe verification no longer treats its absence as a missing
      environment name.

### Honest usage
- [x] Counts a local server reports are `provider-reported`; counts it omits stay `unavailable`, and
      cost is `unavailable` rather than zero. This is not defensive: in the real acceptance below the
      server sent no usage at all, so mapping absence to `0` would have reported zero input tokens
      for a non-empty prompt, and a later context decision would have rested on that number.

### Tests
- [x] `test/custom-local-provider.test.ts` — 9 checks: address classification including the
      172.16/12 boundary that does not fall on an octet, each endpoint refusal, both provider kinds
      preparing, an optional credential that is required once declared, provider/model mismatch,
      catalog provenance with no endpoint or credential in the page, and selection refusal.
- [x] `test/custom-local-turn.test.ts` — 8 checks driving the **real** adapter with a stubbed
      network, because a stubbed `create()` proves wiring and cannot prove wire-format decoding:
      text, streamed tool call ending at a signed approval with no manufactured text part, usage
      reported and usage silent, unreachable endpoint, malformed stream, HTTP refusal, and
      cancellation of an in-flight turn. Every case asserts one request to the declared address.

### Real acceptance
- [x] A managed Custom turn served by an actual local model server (LM Studio, OpenAI-compatible
      endpoint on loopback), model `google/gemma-4-e4b` selected explicitly from the configured
      registry, Stitchkit `0.70.5`: `terminal: success`, output exactly `ready`, 39.9 s including the
      server's first-use model load, and every usage field `provenance: unavailable` — the case
      described above, observed rather than predicted.

### Docs
- [x] `docs/architecture/managed-runtime-drivers.md` — provider composition and the address rule in
      the Custom execution owner section.
- [x] `docs/architecture/launch-recipe.md` — what a Custom recipe declares for each provider kind.

## Release checks

Run before publishing this change, in this order:

1. `bun run check`.
2. One real turn against a configured local endpoint, recording the model id, terminal reason and
   the usage provenance actually returned.
3. A configuration attempt with a public endpoint, which must be refused where the recipe is defined.

An installed binary configures no endpoint: a host that has never declared a `local` provider gains
nothing from this release. One model answering proves that model and that server, not the registry —
each declared model is verified separately, and a declared context window or capability remains the
host's assertion until something checks it (see the inbox task on verifying a declared registry).

## Чего сознательно не сделано

- [x] Model discovery from the endpoint — rejected here: the catalog is an owner-authorized registry,
      and a server listing a model is not authorization to use it. Verifying a declared registry
      against the endpoint is a separate diagnostic, recorded as
      `docs/backlog/done/2026-08-31-verify-declared-models-against-endpoint.md`.
- [x] Hostnames as endpoints — refused deliberately. Resolving one would put I/O in a schema and
      make locality a fact that can change after validation. Address literals and `localhost` cover
      a model server on the host or its own network; relaxing this later is a one-line change with a
      test to write first.

## Состояние набора тестов при закрытии

`bun run check`: Biome clean, `tsc --noEmit` clean, publication privacy 0 findings, **1022 of 1023
tests pass**. The single failure is `test/external-command.test.ts` → "the real CLI flushes JSON
larger than a pipe buffer before exiting", which times out at its 5 s budget and is unrelated to
this change: the same input on an unmodified export of the published commit took 9.32 s against
7.30 s here, with byte-identical output. Recorded with its measurements as
`docs/backlog/done/2026-08-31-external-inventory-scan-cost.md`. It is named here rather than left
implicit, because a closed task that says "green" while a suite reports a failure is a false report.
