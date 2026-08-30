---
title: Read-only directory listing for the managed control service
description: Consumers that pick a workspace folder on a remote host need a bounded read-only directory listing operation; the control service currently exposes only session lifecycle, native reads and model catalog.
type: task
status: in-progress
created: 2026-08-29
updated: 2026-08-30
---

## Зачем

A control-service consumer creating managed sessions must offer a folder picker for the
workspace argument of `session.create`. Today the only way to learn which directories exist on
the service host is to guess a path and attempt a create; there is no read-only listing. The
consumer cannot enumerate candidate workspaces (repositories, project roots) without executing
something on the host.

## Результат

- New control operation `directory.list` (POST `/directory.list`, idempotent, read-only effect):
  input `{ path?: string, cursor?: string, limit?: int }`, output `{ path, parent, entries:
  [{ name, kind: "dir" | "file", path }], nextCursor }`.
- Bounded: entries capped (e.g. 512), names only plus kind, no sizes/mtimes/contents; symlinks
  reported but never followed; hidden dotfiles excluded by default with an explicit opt-in flag.
- Authorization identical to the existing control service policy: same caller scope as
  `session.create`, no new secret material in request or response, errors are stable codes
  (`not-found`, `not-a-directory`, `permission-denied`) without host paths in messages beyond
  the requested path.
- `session.create` continues to accept any absolute path it can chdir into; the listing is
  advisory, not a whitelist.

## План

- [x] Add bounded directory.list through the existing local/service contracts and read admission.
- [x] Use a directory-versioned cursor; refuse changed directories and symlink traversal.
- [ ] Test filesystem behavior and packed clients, then document and release.

## Acceptance checks

- [x] Contract + server + client exports typed through the existing service descriptor pattern.
- [x] Regression test: listing a directory with a symlinked subdirectory does not follow it.
- [x] Regression test: limit/cursor pagination is stable under concurrent directory changes.
- [x] Documentation updated in the control-service reference.

## Что сделано

- `directory.list` / `directory.read` is the eleventh published operation. Local and service clients
  share strict schemas, admission and the names-only reader in `src/control/directories.ts`.
- Limit 512/default 128, at most 20,000 scanned entries, explicit hidden opt-in and symlink kinds.
  Requested symlink paths are refused. Cursors bind directory version/path/selector; mutations return
  `STALE_CURSOR` instead of silently dropping entries. No shell or file-content read is used.
- Three filesystem regressions, packed Bun/Node/type consumers and a real declared-service listing
  passed. Bounds and authorization are documented in `docs/architecture/control-plane.md`.
