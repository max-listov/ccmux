---
title: The status line runs as its own program, routed by the shim
description: Carry the compiled status-line command inside the bundle, lay it down beside it, and route that one verb past the bundle from the PATH shim.
type: decision
status: active
created: 2026-09-06
updated: 2026-09-06 11:37 +0700
---

# Decision

`ccmux status-line` is compiled from the same source into a separate small program, carried inside
the bundle, written beside it on the same convergence that writes the PATH shim, and reached by a
route in that shim. Nothing else is routed this way. The program is required: its absence fails
the command, never routes it through the bundle. Installation materializes the embedded program
before writing the shim; daemon initialization also fails if the artifact cannot be installed.

# Why

Claude Code runs the injected statusLine command on every refresh of every managed session and waits
for its output. It is the hottest process this tool has, and we do not control how often it is
called — only what one call costs.

Measured on the released bundle, CPU time (`RUSAGE_CHILDREN`, 25 runs, repeated, in isolation):

| | ms CPU per call |
|---|---:|
| through the CLI bundle | 81.2 |
| as its own program | 36.2 |
| an empty script — Bun's own start | 24.5 |

A call did about 4 ms of work. The rest was Bun parsing a 4.5 MB bundle to reach one leaf. The
program removes 45 ms a call (−55 %); of what remains, 25 ms is the runtime's start and is not ours
to remove. Under load every number rises and the proportion does not (−54 % on a busy machine), so
the ratio is the stable quantity and the absolute cost is a property of the machine.

# Why this shape and not the others

**Not a second release asset.** The three published readers (`monitoring-reader.js`,
`control-client.js`, `codex-runtime-reader.js`) exist for external consumers to fetch. This one is
ours, needed on every machine, and an asset is one more thing to download, verify, version and be
missing. It travels in the bundle, so a machine that has the bundle has the program.

**Not a bytecode build of the whole bundle.** That would have made every ccmux invocation cheaper
with no new file and no routing at all, which is strictly better if it works. It does not: bytecode
requires a CommonJS build, and `yoga-layout` — Ink's layout engine, reached through the TUI — does
not survive that transform. Ruled out by building it, not by argument.

**Not a change to what each session is told.** The command injected into a managed session's
settings is `ccmux status-line`, where `ccmux` is the PATH shim. Teaching the shim reaches every
existing session at once, rewrites no session's settings, and needs no migration.

# Boundaries

The command itself is not duplicated — the program is an entry that calls it, so there is one
implementation and a build cannot ship two that disagree. The digest of the embedded bytes is
checked before they are written, and the file on disk is compared against it, so a half-written or
stale copy is replaced rather than executed thousands of times.

Two writers produce the shim — `scripts/install.sh`, before any of this code can run, and the daemon
on every start. They are compared byte for byte in the test suite: writers that disagree rewrite
each other forever, and the installer would report a change it does not keep.
