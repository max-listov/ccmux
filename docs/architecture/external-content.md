---
title: Bounded external conversation content
description: Exact read-only provider storage projection without adopting an external writer.
type: architecture
status: active
created: 2026-08-31
updated: 2026-08-31
---

## Authority and operations

`externalHistory({ target, cursor?, limit? })` and `externalCapabilities({ target })` are available
on the local control client and the transport-injected service client. Service operations are
`external.history` and `external.capabilities`, with effect `external.content.read`. The declared
transport must separately grant that effect; a descriptor is not an authorization grant.

Target is `{ provider: 'codex' | 'claude', machine, threadId }`. The execution host checks its
own machine identity, `externalInventory` access policy and absence of a managed registration
for that provider/thread. Authenticated local IPC and existing service ingress remain the only
entry points. Configured provider roots supply paths; callers cannot submit paths or native RPC.
Changes to access policy or configured roots fail closed on both entry points until the daemon
restarts. Unrelated control operations remain available. This guard runs before and after a read.

These operations do not connect to a provider, send a turn, resume/adopt/fork a session or create
a writer. The capabilities reply explicitly marks message, interrupt, respond, fork and compact
unsupported by this external control surface. Native managed operations and the separately
authorized chat routes retain their own exact contracts; content access does not grant them.

## Projection and bounds

Only authored user/assistant text is returned. System/developer prompts, tool payloads, reasoning,
synthetic metadata and inline images are omitted structurally. This is an authored-text projection,
not full native content or proof of live turn state. Codex first-record identity and Claude
per-record identity must match. Same-user regular files are required; group/world-writable files,
symlinks, ambiguous lookup and changed paths refuse without returning content.

Each read visits at most 8,192 directory entries / eight levels and reads at most 256 KiB of native
metadata plus 256 KiB of history. It returns at most 64 entries of 4,096 characters each; the
service response ceiling is 384 KiB. The existing admission allows four concurrent reads with a
six-second deadline; cancellation is checked during lookup and byte/record consumption. The
reader holds no unbounded file cache and does not load an entire rollout.

The initial page selects newest content, presented chronologically. `nextCursor` reads older
records. Cursor identity includes provider, machine, thread, configured root and file revision;
append, replacement or root change returns `stale`, with no entries. Refresh with no cursor.
`revision` is opaque and contains no path. A read that races a writer also returns `stale` rather
than mixing revisions. `truncated` and `omittedRecords` describe excluded records, boundary
fragments and clipped text; large partial records cannot prevent cursor progress.

`available` with empty entries is a successfully read empty/projected page, not missing history.
`history-absent` means no exact stored transcript was found, `unavailable` means storage could not
be qualified, and `stale` means the requested revision changed. Errors outside those outcomes
include disabled access, wrong identity and malformed cursor. Internal causes stay in owner logs;
public replies never expose storage paths or native error text.

## Verification

`test/external-content.test.ts` covers pagination across byte windows, large metadata/records,
partial writes, empty/missing history, cursor and managed identity refusal, permissions/symlinks,
both provider projections and real local/service ingress. `scripts/external-content-acceptance.ts`
uses an existing live Codex thread through the built service, proves the exact writer lock holder
is unchanged, and reports hashes/counts rather than conversation bodies or private identity.
