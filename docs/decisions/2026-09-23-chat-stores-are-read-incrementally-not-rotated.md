---
title: The chat ledger and outbox are read incrementally, not rotated
description: Keep the chat ledger and the outbox as whole append-only files, and make every long-lived read decode only the bytes added since the last one.
type: decision
status: active
created: 2026-09-23
updated: 2026-09-23 09:47 +0700
---

# Decision

`chat.jsonl` (the ledger) and `outbox.jsonl` stay whole append-only files: nothing moves old
records out of them. What made their growth expensive — the daemon decoding each of them in full
on every three-second delivery pass — is removed at the reader instead. `readJsonl`
(`src/util/jsonl.ts`) remembers, per file and per process, how far it has decoded, and a later read
decodes only what was appended, as long as the file is the same file (device and inode), has not
shrunk, and still ends with the bytes that were decoded last.

The event feed and the daemon log keep their size-based rotation (`rotateBySize`): nothing refers
to a position inside them.

# Why

Positions in these two files are cursors, held by other parties:

- the delivery cursors (`chat-cursors.json`) are indexes into the ledger — `delivered`, `read`,
  the pickup barrier's `ledgerIndex`;
- `chat log --follow` hands its consumer a cursor made of a ledger line and an outbox line, and a
  transport resumes from it after a restart;
- a `thread-continuation` names a sent letter by id and is resolved by finding it in the ledger or
  the outbox, however old it is.

Moving old records elsewhere shifts every one of those positions, or makes a letter that is still a
valid reference unreachable. Each is a migration with its own failure mode, and each was being
proposed to fix a cost that is not in the size of the file but in reading all of it every time.

Measured on one machine (ledger 6.7 MB / 1,785 records, outbox 4 MB / 904 records, six weeks of
use): the first read of the ledger 50 ms and of the outbox 17 ms, as before; every later read with
nothing appended 0.02 ms each, where every pass used to pay 23 ms and 7.5 ms — several times over.

# When to revisit

When the ledger passes 100 MB, or when the first read in a short-lived command — `msg`, `inbox`,
`wait` — shows up in their latency. At the current rate of about 1 MB a week that is far off. The
design then needs a base offset stored beside the cursors, so that positions survive a rotation,
and an archive that continuation lookups still read.
