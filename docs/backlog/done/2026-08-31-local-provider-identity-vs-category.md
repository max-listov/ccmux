---
title: The local provider kind reports a category where a caller expects an identity
description: Every local model server reports the same provenance, so a host running more than one cannot say which of them answered, and a caller with its own name for a server must map it away.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 22:38 +0700
priority: P2
---

## Problem and evidence

`CustomProviderSchema` in `src/agent/custom/config.ts` offers `openrouter` and `local`, and the rule
that a model's declared provider equals the host adapter means every locally served model reports
`provider: 'local'` — in the catalog page, in selection evidence and in `nativeProfile`.

That word answers "where did this run" and deliberately so: locality is checked from the address, and
`docs/architecture/managed-runtime-drivers.md` states the guarantee it carries. It does not answer
"what served it", and those are different questions. Two consequences, one of them already observed:

- A host configured with two different local servers — one for coding models, one for embeddings or a
  second engine — publishes the same provenance for both. Nothing downstream can tell them apart, and
  the endpoint that would distinguish them is deliberately not published.
- Reported by a consuming project on the day the feature shipped: it names its own provider after the
  server product it runs and had to translate that name into `local` before selection would be
  accepted. The translation is harmless in itself, but it is a consumer compensating for information
  the contract will not carry, which is where the loss becomes permanent.

## Result

- A host may state which local server backs a provider, and that statement reaches the catalog and
  selection evidence beside the locality fact rather than instead of it.
- The locality guarantee is unchanged: whatever a host calls its server, `local` still means the
  address was checked, and a label must not become a second way to assert provenance.
- A host that declares nothing keeps today's behaviour exactly.

## The design question to settle first

Whether the label is a free field or drawn from a known set. A free field is honest — the host is the
only party that knows what it runs — but it becomes a de-facto identifier that downstream code will
branch on, and then a typo is a silently different provider. A known set contradicts the point of an
OpenAI-compatible adapter, which is that the server does not have to be one we have heard of.

Whichever is chosen, it must not be `selection.provider`: that field is matched against the host
adapter, and widening it would reopen the check that currently refuses a model no adapter can serve.

## Что сделано

### Решение по открытому вопросу
- [x] **Free field, not a known set.** A known set would make this project the registrar of every
      inference server anyone runs, which contradicts the reason an OpenAI-compatible adapter exists.
      The typo risk that argued for a set is bounded here by where the value lives: recipe
      configuration pinned by digest, not caller input, so a wrong spelling is a recipe change and
      never a silently different identity. The charset is narrow because readers display it.
- [x] **Not `selection.provider`.** That field is matched against the host adapter; widening it would
      reopen the check that refuses a model no adapter can serve. The label is reported, never matched.

### Реализация
- [x] `src/agent/custom/config.ts` — optional `label` on the local provider kind.
- [x] `src/agent/custom/host.ts` — `customProviderLabel`, one definition of the answer.
- [x] `src/control/schema.ts`, `src/agent/custom/catalog.ts` — `providerLabel` on a catalog page's
      source, set explicitly by every producer rather than defaulted at a distance.
- [x] `src/policy/runtimeProfile.ts`, `src/agent/custom/profile.ts` — the same answer per turn.
- [x] `test/custom-local-provider.test.ts` — the label reaches the catalog, absence keeps the previous
      answer exactly, the aggregator refuses a label, and a label must be a name rather than display
      text or anything resembling an address.
