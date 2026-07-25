---
title: Session-reader library seam — ccmux/session-reader
description: ccmux exposes its block-parser as an importable library (src/lib.ts + package.json exports) so an external consumer can reuse the tested, agent-agnostic transcript reader instead of duplicating it. The seam is one file; internals stay refactorable behind it.
type: decision
status: active
created: 2026-07-25
updated: 2026-07-25
tags: [architecture, session-reader, library, exports, seam]
---

# Session-reader library seam

## Context

ccmux owns a block-level JSONL transcript parser (text/thinking/tool_use/tool_result, call↔result
stitched, image-safe, zero-cast, agent-agnostic across Claude + Codex, under tests). A separate tool
over the same substrate (`~/.claude/projects/*.jsonl`) had grown its own weaker, message-level,
single-agent parser. The maintainer's direction: don't duplicate the read layer — that tool should
reuse ccmux's reader. That requires ccmux to expose the reader as a library (it previously shipped
only as a CLI bin).

## Decision

Expose the reader through **one stable entry file, `src/lib.ts`**, published under the package
subpath **`ccmux/session-reader`** via `package.json` `exports`. Consumed locally via a `file:` link
(Bun runs the TS directly). No build/publish step and **no fleet release** — the library is not
shipped to the fleet (the fleet gets the bundle built from `cli.ts`); `exports` only affects external
`import "ccmux/…"` resolution and is inert for the bundle and the bin.

Alternatives considered and rejected:
- **Published `@…/session-reader` npm subpackage** — versioning/publish burden for a local,
  few-consumer coupling. Overkill now.
- **Plain relative import into `src/agent/**`** — no stable seam; every consumer reaches into
  internals and breaks on any refactor.

## Public surface (`ccmux/session-reader`)

- `readSession(path, agent, textLimit?) => TranscriptMessage[]` — read a file + block-parse in one
  call.
- `parseSession(lines, agent, textLimit?) => TranscriptMessage[]` — parse already-read lines.
- `detect(lines) => "claude" | "codex" | null` — sniff the agent for a historical/unknown file.
- `readLines(path)`, `DEFAULT_TEXT_LIMIT`, and the types `TranscriptMessage` / `TranscriptRole` /
  `TranscriptKind` / `AgentKind`.

`textLimit` is a passthrough to the parser (default 6000); a consumer that needs full text for
indexing passes a larger value (e.g. 10000).

## Why it stays clean

- `src/lib.ts` wires only the **pure** parsers + `readLines` + types — NOT the provider registry.
  Verified: `bun build src/lib.ts` produces a ~15 KB bundle with **zero ink/react** in the subgraph
  (it builds without the `--external react-devtools-core` the CLI needs). A consumer pulls in only
  `zod` + `node:fs`, not the launch/pane/tmux machinery.
- The seam is a single file. Everything under `src/agent/**` stays free to refactor as long as
  `lib.ts` keeps re-exporting the same surface. To keep the seam lean, the format sniff was extracted
  into `src/agent/detect.ts` (normalize-only deps) and re-exported from `agent/index.ts` under its
  existing name.

## Consequences

- The consumer implements its own reader adapter over `readSession(path, agent, textLimit)` and drops
  its duplicate parser. Session listing stays on the consumer side (ccmux's discovery is gated on live
  process uuids; a history indexer needs dead/historical files too, and `readdir` is trivial).
- Coupling direction is one-way: the consumer depends on ccmux; ccmux learns nothing about it. ccmux
  stays a public MIT tool with no consumer-specific code.
