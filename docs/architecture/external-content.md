---
title: Bounded external conversation content
description: Exact read-only provider storage projection without adopting an external writer.
type: architecture
status: active
created: 2026-08-31
updated: 2026-11-04 19:55 +07:00
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
to 256 KiB. История читает только последние 8 MiB текущего файла в chunks по 256 KiB независимо
от полного размера файла. `sourceWindow: { startByte, endByte }` сообщает точный закреплённый
диапазон; `null` означает, что диапазон не получен. Байты перед `startByte` не читались и не входят
в `omittedRecords`. Если `startByte > 0`, `truncated` всегда true, даже на последней странице;
этот cursor не открывает историю до окна. Первый неполный record и незавершённый последний
record не проецируются. Record больше 256 KiB пропускается без полного буфера.

Retained projection limited to 16 MiB (UTF-16 text plus object allowance). The process retains at
most 16 snapshots / 64 MiB, with absolute ten-minute expiry. Eviction, process restart and expiry
produce explicit `stale`. Two concurrent scans/builds are admitted; excess capacity returns
`RESOURCE_EXHAUSTED` (429), oversized projection returns that code with 413. Transport admission
and its six-second deadline apply; cancellation is checked between chunks and after scanning.
There is no persistent copy of private text.

Pages contain up to 64 entries of 4,096 characters, and fit the 384 KiB serialized response budget.
JSON escaping and UTF-8 bytes count toward that budget, so a page can contain fewer than the requested
limit. The cursor still advances by exactly those entries. Tool-only regions require no extra
network pages: projection happens once and only useful entries are paginated. Warm reads of an
unchanged source perform no history scan (identity metadata and lookup remain bounded separately).

The initial page selects newest content, presented chronologically. `nextCursor` reads older
records from the same immutable projection. Cursor identity binds the host state scope, provider,
machine and thread; the server-held snapshot binds the exact path/device/inode and fixed byte
window. SHA-256 covers every byte of that window, including a partial tail. Append does not
invalidate a cursor or introduce entries into its snapshot; a new initial read captures the new
tail. A changed source stat requires hashing only the pinned window, never the entire prefix or
newly appended bytes. Same-inode rewrites inside the window, including rewrite with append,
return `stale`. Changes outside the window are outside this consistency proof; native thread
metadata is still checked on each request. A stable validation stamp caches a successful hash.
A racing append can require two bounded scans; unchanged pages read no history bytes.

Owned immutable text cannot mix generations during concurrent writes. This is snapshot
consistency, not a provider lock. Replacement, truncate below the pinned end, changed window,
lost snapshot or changed root returns `stale`, without entries. Refresh without a cursor.
`revision` is opaque and contains no path. `truncated` also reports older pages, omitted records,
earlier split files or clipped text. `omittedRecords` counts exclusions only within the pinned
window, not a per-page delta or an invented count for unscanned bytes.

`available` with empty entries is a successfully read empty/projected page, not missing history.
`history-absent` means no exact stored transcript was found, `unavailable` means storage could not
be qualified, and `stale` means the requested revision changed. Errors outside those outcomes
include disabled access, wrong identity and malformed cursor. Internal causes stay in owner logs;
public replies never expose storage paths or native error text.

## One exact message: `external.message`

`externalMessage({ target, messageId })` (service operation `external.message`, same access
policy, admission and six-second deadline as `external.history`) resolves one native message id of
an external Codex thread. It answers a question the history projection cannot: its entry `id` is a
byte offset and its text is cut at 4,096 characters, so it cannot prove that a given message exists,
what it said in full, or who sent it.

The reader streams the thread's file once in constant memory and accepts only an `item_completed`
record whose item is a `UserMessage` with exactly that id and the thread's own `thread_id`. A
quotation of the id inside other text, an assistant or tool item with that id, another thread's
record and a partial last record never resolve. A resolved reply carries the native `id`,
`clientId`, `turnId`, `recordedAt`, the whole `text` (every text part concatenated in order),
the number of `images`, the source `revision` and `authorship`.

`authorship` reports what the history itself records, never an inference from the text. Codex writes
`task_started.turn_attribution.turn_trigger` for every turn the client starts. That attribution
names the TURN, so it speaks only for the user input that opened it:

| Trigger of the turn the message opened | `verdict` |
| --- | --- |
| `composer`, `edit_user_message`, `remote_android`, `remote_ios` | `person` |
| `app_tool_send_message`, `automation_heartbeat_scheduled`, `goal`, `app_update_resume`, `resume_interrupted_task` | `not-person` |
| any other trigger (`queue`, `capacity_retry_manual`, …), no trigger | `unverifiable` |

Input added to a turn already running (`position: mid-turn`) is always `unverifiable`. `queue` is
not a person: a letter an agent sends to a busy thread is queued and opens its turn with the same
trigger, which real histories show. `person` means a person SENT the message; it does not mean the
person wrote every word — pasted text is still sent by the person.

Outcomes: `resolved`; `not-found` (no item with that id in this history); `not-user-input`;
`ambiguous` (two different records carry the id); `too-large` (record over 4 MiB or text over
256 KiB — returned whole or not at all); `unsupported` (provider other than Codex, a history format
without native item identities, a content part that is neither text nor image, a compressed or
unplaceable file of a split history); `history-absent`; `unavailable`. Only `resolved` carries a
message. One file is streamed up to 2 GiB, measured about 1.3 GB/s plain; a compressed file is
decoded as a stream in constant memory up to the same 2 GiB of output (a 376 MB file decoded to
0.62 GB in 0.9 s) and its `session_meta` is checked after decoding. The read shares the external
reader capacity of two concurrent scans.

## Split Codex histories

Codex Desktop splits a long thread: the first file is `rollout-<time>-<thread>.jsonl`, each later one
`rollout-<time>-<thread>_<segment>.jsonl`, and finished files may become `.jsonl.zst`. Every file
starts with the thread's own `session_meta`. The index groups them by thread; the thread id (first
file) and the segment id are UUIDv7, so each file has a start time. `external.message` reads the
file a UUIDv7 message id falls into, compressed or not. `external.history` reads the file Codex writes
now (the newest uncompressed one) and reports the files before it in `earlierFiles`, with
`truncated: true`; a thread whose every file is compressed answers `unavailable`. Naming is shared
with the managed side: `src/agent/codex/rolloutFiles.ts`.

## Shared Codex path index

`src/external/storage.ts` shares one bounded thread → files index among all threads of a configured
root. Concurrent lookups, including those that find the index expired, share one walk; the walk
runs under its own deadline, so a caller that abandons its lookup ends only its own wait. Up to 32
roots are held in the process; the index's maximum age is 5 seconds. A change of the root or of a
known file's parent, a vanished path and a move to the archive invalidate it. A thread the index
does not know is looked for again once the index is older than `STORAGE_MISS_RESCAN_MS` (250 ms):
a new rollout lands in an existing day directory, which changes no revision the index follows. A
duplicate in another existing subtree is detected no later than the next full walk after expiry.

A repeated lookup checks the known path; containment, symlink, regular-file, owner/mode and native
identity are checked by the same reader on every read. The index is not a permission to read a file
and replaces neither content checks nor the pinned revision. A rewrite of the same inode with a
restored mtime is caught by ctime and native metadata. Claude keeps its own bounded lookup.
`test/external-storage-cache.test.ts` covers the absence of repeated `opendir`, concurrency after
expiry, ambiguous identity, an abandoned shared walk and a thread created in an existing day
directory.

## Verification

`test/external-message.test.ts` covers the whole message past 4,096 characters, every attribution
case, invented/assistant/quoted/foreign ids, the refusals and a split history with a compressed
file, through the reader and through local and service clients.
`test/external-content.test.ts` covers pagination across byte windows, large metadata/records,
partial writes, empty/missing history, cursor and managed identity refusal, permissions/symlinks,
both provider projections and real local/service ingress. `test/external-snapshot.test.ts` also
checks source/projection budgets, cancellation, expiry and exact chunk-read counts for warm/append
paths. `scripts/external-content-acceptance.ts`
uses an existing live Codex thread through the built service, proves the exact writer lock holder
is unchanged, and reports hashes/counts rather than conversation bodies or private identity.
