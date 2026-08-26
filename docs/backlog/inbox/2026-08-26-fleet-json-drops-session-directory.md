---
title: Fleet JSON drops session directory
description: Preserve each managed session's declared directory across fleet fan-out so consumers can join sessions to their own canonical project catalogues without name heuristics.
type: task
status: inbox
tags: [fleet, sessions, json, identity]
created: 2026-08-26
updated: 2026-08-26
---

# Fleet JSON drops session directory

## Зачем

`ccmux list --json` reports the declared `dir` of every managed session. `ccmux fleet --json`
fetches that document from every peer, but its tolerant remote schema and local projection rebuild
session rows without `dir`. A fleet consumer therefore knows the canonical session address and
provider, but loses the only factual checkout identity and has to guess from a session name.

The fleet layer should transport this owner fact, not interpret it as a project. Project identity
belongs to the consuming catalogue; ccmux only needs to preserve the declared directory.

## Результат

- Fleet session JSON includes `dir: string | null` for local and remote peers.
- A peer that predates the field remains readable and produces `dir: null`, not a failed machine.
- Human `ccmux fleet` output does not need a new column; the field is a structured identity anchor.
- The published JSON schema/types and command documentation name the field and its compatibility
  semantics.

## Acceptance

- [ ] Local fleet rows preserve the exact directory already returned by `ccmux list --json`.
- [ ] Remote rows preserve the same field without normalizing, shortening or inferring it.
- [ ] Missing `dir` from an older peer becomes `null` while its other sessions remain visible.
- [ ] Tests cover local, current remote and older remote payloads.
