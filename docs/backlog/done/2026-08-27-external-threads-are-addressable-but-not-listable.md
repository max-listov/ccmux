---
title: The external inventory has no reader outside the TUI
description: Local unmanaged threads are already discovered and shown in the fullscreen view, but nothing exposes that inventory as a command, so no other surface can display what the tool already knows.
type: task
status: done
created: 2026-08-27
updated: 2026-08-27
completed: 2026-08-27 07:37 +0700
related: docs/architecture/external-session-ownership.md
---

## Why

The inventory exists and works. `discoverCodex` returns local unmanaged threads — persisted
rollouts plus positively held writer locks, with managed ones excluded — and it is already used
twice: `adopt` refuses a thread that is not in it, and the fullscreen view renders those threads
as their own cards behind the `externalInventory` setting.

What is missing is a **reader**. There is no command and no `--json` for that same projection.
`list` and `fleet` are documented as managed sessions and correctly stay that way.

The consequence is narrow but real: anything that is not this tool's own view cannot show what
this tool already knows. A dashboard, a status line, another agent asking “what is running on
this machine” — all of them see managed sessions only, and conclude that the desktop threads are
not there. They are there; they simply have no way out.

The addressing already assumes they are reachable:

```
ccmux msg app/<UUID> "…"          # write into an exact desktop thread
ccmux adopt codex <UUID> [name]   # bring that thread under management
```

Both need a UUID that a person currently copies out of another application by eye — even though
the tool holds the very list that UUID came from.

## Result

- The same projection the fullscreen view renders is available as a read-only command with
  `--json`.
- The independent evidence axes already defined in the architecture — storage, origin, writer
  evidence, runtime — survive into that output instead of being flattened into “running”.
- A surface outside this tool can show unmanaged threads beside managed sessions without
  inventing their state, and a person can adopt one without leaving the terminal.

## Plan

- [x] Expose the existing projection as a read-only command; `--json` from the start, because
      its first consumers are programs.
- [x] Keep managed and unmanaged plainly distinguishable in the output: one is a promise about
      lifecycle, the other is an observation, and a reader must not confuse them.
- [x] Carry the unknowns through. `none-observed` never means free, and an output that drops
      that distinction turns careful discovery back into a guess.
- [x] Decide whether the command belongs beside `list` or under its own name — `fleet` promises
      managed sessions across machines, and a local-only observation may not belong under that
      promise.

## Acceptance

- [x] With the inventory enabled, the command lists the same threads the fullscreen view shows.
- [x] Its output is enough to adopt one without opening another application.
- [x] `list` and `fleet` keep meaning exactly what they mean today.

## What was done

- [x] CLI: `src/commands/external.ts`, `src/cli.ts` and `src/commands/help.ts` expose the local
      observation plane as `ccmux external [--json]`, independently of managed commands.
- [x] Contract: `src/config/schema.ts` and `src/types.ts` define the strict JSON envelope while
      preserving the complete external row, including unknown evidence.
- [x] Tests: `test/external-command.test.ts` proves strict JSON evidence and adopt-ready human
      output; the full project gate passes.
- [x] Docs: `docs/architecture/external-session-ownership.md` records the command boundary and
      explicit-scan behavior.
- [x] Live path: the source command returned the exact same 94-row projection as direct discovery,
      with no managed rows mixed into it.
