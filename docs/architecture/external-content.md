---
title: Bounded external conversation content
description: Exact read-only provider storage projection without adopting an external writer.
type: architecture
status: active
created: 2026-08-31
updated: 2026-09-10 08:21 +07:00
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

Lookup visits at most 8,192 directory entries / eight levels; native identity metadata is bounded
to 256 KiB. A cold snapshot scans at most 512 MiB in 256 KiB chunks and retains only authored text,
not native tool payloads. A record larger than 256 KiB is omitted without buffering it whole.
The retained projection is limited to 16 MiB (UTF-16 text plus an object allowance per entry).
The process retains at most 16 snapshots / 64 MiB of accounted projections, with absolute ten-minute
expiry checked on access. Eviction, process restart and expiry produce explicit `stale` on resume.
There is no persistent copy of private text. Two concurrent scans/builds are admitted; excess
capacity returns `RESOURCE_EXHAUSTED` (429), oversized source/projection returns that code with 413.
These are not empty successful histories. Transport admission and its six-second deadline still
apply; cancellation is checked between chunks and after scanning.

Pages contain up to 64 entries of 4,096 characters, and fit the 384 KiB serialized response budget.
JSON escaping and UTF-8 bytes count toward that budget, so a page can contain fewer than the requested
limit. The cursor still advances by exactly those entries. Tool-only regions require no extra
network pages: projection happens once and only useful entries are paginated. Warm reads of an
unchanged source perform no history scan (identity metadata and lookup remain bounded separately).

The initial page selects newest content, presented chronologically. `nextCursor` reads older
records from the same immutable projection. Cursor identity binds the host state scope, provider,
machine and thread; the server-held snapshot binds the exact path/device/inode and fixed source
length. Its SHA-256 revision covers that prefix, including a partial tail (which is not projected).
Append does not invalidate a cursor or introduce new entries into its snapshot; a fresh initial
read sees the appended content. If source stat changes, the reader verifies the whole fixed prefix,
never the new tail, against the snapshot hash. This detects same-inode middle rewrites, including
rewrite combined with append; checking inode/size or only the head could not prove that invariant.
The successful validation stamp is cached only if stable across the scan. A cold read racing append
can require two bounded scans (capture plus validation); unchanged pages do not rehash. On an actively
appending large journal, prefix verification costs O(snapshot source bytes), deliberately not O(page
size). Arbitrary rewrite detection cannot be promised from stat alone. Entries are owned immutable
text even when a concurrent change prevents caching the validation stamp, so pages cannot mix
generations. This is snapshot consistency, not a lock or transactional guarantee about a provider
that rewrites concurrently with the scan.

Replacement, truncate, changed prefix, lost snapshot or changed root returns `stale`, with no
entries. Refresh with no cursor. `revision` is opaque and contains no path. `truncated` reports
older pages, omitted records or clipped text; `omittedRecords` counts exclusions across the pinned
snapshot, not a per-page delta. Oversized and unfinished records cannot prevent cursor progress.

`available` with empty entries is a successfully read empty/projected page, not missing history.
`history-absent` means no exact stored transcript was found, `unavailable` means storage could not
be qualified, and `stale` means the requested revision changed. Errors outside those outcomes
include disabled access, wrong identity and malformed cursor. Internal causes stay in owner logs;
public replies never expose storage paths or native error text.

## Verification

`test/external-content.test.ts` covers pagination across byte windows, large metadata/records,
partial writes, empty/missing history, cursor and managed identity refusal, permissions/symlinks,
both provider projections and real local/service ingress. `test/external-snapshot.test.ts` also
checks source/projection budgets, cancellation, expiry and exact chunk-read counts for warm/append
paths. `scripts/external-content-acceptance.ts`
uses an existing live Codex thread through the built service, proves the exact writer lock holder
is unchanged, and reports hashes/counts rather than conversation bodies or private identity.
