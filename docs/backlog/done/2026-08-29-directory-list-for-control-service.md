---
title: Read-only directory listing for the managed control service
description: Consumers that pick a workspace folder on a remote host need a bounded read-only directory listing operation; the control service currently exposes only session lifecycle, native reads and model catalog.
type: task
status: done
created: 2026-08-29
updated: 2026-08-30
completed: 2026-08-30 08:18 +07:00
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
- [x] Test filesystem behavior and packed clients, then document and release.

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

### Published and installed acceptance

- [x] Released in `v0.39.23`, exact SHA `80258c0947b3b1d2a575934e335aaaa76e0b2a9f`.
  Full gate passed with 814 tests and packed Bun/Node/type consumers; exact-SHA CI and all three
  installed runtimes passed. See [the shared release evidence](2026-08-30-model-catalog-before-first-managed-session.md#published-and-installed-acceptance).
- [x] The checksum-verified published service client listed a real directory through the installed
  daemon's declared-service ingress during native acceptance. Installed CLI reads on all three owned
  hosts also succeeded. No caller shell command, file-content read or consumer gateway was introduced.
