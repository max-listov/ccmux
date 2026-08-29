---
title: Managed Codex lifecycle
description: Transactional first launch, authoritative thread binding, restart and self-heal for ccmux-managed Codex TUI sessions
type: architecture
status: active
created: 2026-08-10
updated: 2026-08-10
---

# Managed Codex lifecycle

Codex chooses the thread UUID when an ordinary TUI starts; it has no public `--session-id` flag.
ccmux therefore separates launch correlation from ready session identity instead of storing a fake
UUID in `sessions.jsonl`.

## State and sources of truth

| State | Durable source | Meaning | Visible to list/routing/transcript |
|---|---|---|---|
| pending | `pending-sessions.json` | One fresh Codex launch owns a unique generation and marker. | No |
| ready | `sessions.jsonl` plus a transient `promoted` journal row in `pending-sessions.json` | The row contains the real rollout UUID and is the canonical managed peer. | Yes |
| blocked | `lifecycle-blocks/<name>.json` | A terminal resume/admission/history error requires an explicit start/restart. | Yes, as `blocked` |

The pending generation is never a conversation UUID. `sessions.jsonl` contains ready identities
only, so chat, transcript, list, and fleet code cannot accidentally address a bootstrap token.

## First launch transaction

1. CLI or TUI validates provider config before writing state. The Codex binary must be executable,
   and the configured rollout root must exist and be readable/writable.
2. ccmux reserves one pending generation under the cross-process session-registry lock.
3. A dedicated tmux pane runs `_bootstrap <generation>` and starts exactly one fresh ordinary Codex
   TUI. `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=ccmux_<generation>` makes Codex persist the launch marker
   in the first `session_meta` record.
4. Bootstrap scans only for that exact marker. cwd, mtime, source kind, model, and recency are never
   selectors. Zero matches continue until `codexCorrelationTimeoutMs` (30 seconds by default);
   multiple matches fail.
5. Promotion locks the registry and compare-and-swaps the still-pending generation into one ready
   Session carrying that `registrationGeneration`. It also rejects a claimed name or rollout UUID.
   The write protocol is `promoted` journal → ready row → journal cleanup. Readers load the journal
   first and merge it with ready rows, so a crash or concurrent read at either boundary still sees
   exactly one authoritative ready identity; the next locked mutation completes recovery
   idempotently. A late success or rollback can only accept/remove its own generation.
6. The bootstrap process remains the pane supervisor. When the first child exits it reloads the
   ready registry row and runs `codex resume <real UUID>`; it never launches fresh again.

Native App Server creation uses the same bounded correlation budget with a different provider
boundary. `thread/start` supplies the UUID, but the rollout is not readable until its first
newline-terminated `session_meta` record is committed. CCMux waits for that exact UUID and record
before issuing the initialization turn. An empty, partial, malformed or mismatched rollout remains
pending only until the existing correlation deadline; it is never promoted or replaced by a second
writer.

CLI and TUI call the same create service. The TUI new-session bar uses Tab to choose
`claude`/`codex`; Claude remains the default.

## Restart and self-heal

Every ready child launch reloads the Session by name and verifies the provider has not changed.
A ready Codex row without its rollout is a terminal error, not permission to mint a replacement.
Stopping a pane waits for its managed process group to disappear before restart starts a new
writer. Killing the Codex child leaves `_run` alive and resumes the same UUID; killing tmux lets the
daemon recreate `_run` from the same registry row.

A fast Codex resume exit is blocked after the first failed admission. The daemon skips blocked
sessions, preventing an ownership-conflict retry storm. An explicit `start` or `restart` clears the
block and is the operator's deliberate retry.

## Boundary

The same pending/promoted/ready journal also owns external Codex admission. `adopt` starts one
ordinary `codex resume <uuid>` and promotes only after the spawned process tree holds that UUID's
OS writer lock. `fork` starts provider-native `codex fork <uuid>` and promotes only the new rollout
whose launch marker and `forked_from_id` both match. See
[`external-session-ownership.md`](external-session-ownership.md).
