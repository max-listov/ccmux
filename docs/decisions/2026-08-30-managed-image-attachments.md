---
title: Bounded owner-side image attachments
description: Transfer validated image bytes independently of native turn input while preserving caller, registration and message identity.
type: decision
status: active
created: 2026-08-30
updated: 2026-08-30
---

# Decision

Image upload and native input share the existing authenticated control service, but not a payload.
An upload carries bounded byte chunks; a turn carries ordered immutable references. There is one
current contract, not a parallel text-only interface. Neither operation accepts a caller filesystem
path, arbitrary fetch URL, executable or shell text.

`src/attachments/reference.ts` is the shared reference and limits authority. A reference contains an
opaque UUID, SHA-256 digest, PNG/JPEG media type, encoded byte count and decoded dimensions. These
fields do not grant access: the store also binds the authenticated `ChatPrincipal`, execution host,
full managed target and its registration generation. Managed runtime admission requires Codex App
Server or native OpenCode and an explicit registration generation.

## Operations and state

- Begin reserves the declared byte quota before creating an owner-private upload. An exact
  upload-ID retry returns the durable received offset; a changed identity or declaration refuses.
- Chunk appends at that offset. An exact committed byte-range replay is accepted, whereas a gap,
  overlapping new data or changed bytes refuses. Base64 must be canonical. A crash may leave an
  unacknowledged file tail; the next chunk truncates that tail to the committed offset before write.
- Finalize requires every byte and the declared digest, then fully decodes the image. It publishes
  a reference only after successful decode and an exact identity/byte recheck. Repeating finalize
  returns the same immutable reference.
- Read returns an authenticated bounded preview range. Verified inode metadata and digest are
  cached in a bounded process-local cache; changed inode, size, mtime or ctime forces a new hash.
- Cancel deletes only an unretained upload/reference. Missing, expired, wrong-scope and retained
  references fail closed. An exact cancellation retry is acknowledged for 30 minutes by a bounded
  caller/registration-bound tombstone. It does not delete conversation assets.

The live states are `uploading → verified → retained`. Expiry and cancel remove only unretained
records. Durable message acceptance takes the existing session-registry lock and then the
attachment-store lock, verifies all ordered references and persists their pins before appending the
message ledger. A failed or uncertain acceptance callback does not release those pins. This avoids
garbage collection racing a durable message whose acknowledgement was lost.

Native delivery resolves only a matching message pin. Codex receives an owner-local image path;
OpenCode receives an owner-local file URL and persists its own native inline representation. Those values are constructed only for provider input,
never public receipts, status, process argv or outward diagnostics. The normal message fingerprint
includes ordered references and digests. Deferred delivery and recovery reuse the same pin and do
not upload or submit the image again.

Native history remains provider-owned. Fork retention extends existing pin reachability to the
exact destination registration while retaining the original caller binding; it does not duplicate
image bytes or copy provider transcript files. Archive is not asset deletion. Retained assets have
no automatic TTL deletion: quota exhaustion refuses new uploads rather than discarding accepted,
uncertain, deferred or historical input.

## Published resource limits

| Resource | Limit |
| --- | --- |
| Encoded image | 8 MiB |
| Images per input | 4 |
| Aggregate encoded input images | 16 MiB |
| Raw upload/preview chunk | 24 KiB; 32 KiB Base64 |
| Width or height | 8192 pixels |
| Decoded pixel budget | 16 × 1024 × 1024 pixels |
| Incomplete upload TTL | 30 minutes from begin; retries do not extend it |
| Verified unretained TTL | 24 hours from finalize |
| Reserved encoded bytes per host | 256 MiB |
| Concurrent incomplete uploads | 32 per host; 8 per exact target |
| Store records / message pins | 1024 / 4096 |
| Cancellation receipts | 1024; 30-minute retry retention |
| Serialized private index | 4 MiB |
| Full decoder concurrency / deadline | 1 per host / 5 seconds per subprocess |
| Preview digest cache | 64 files |

The normal control envelope remains bounded independently; images do not enlarge `message.send`.
Every store operation performs a bounded expiry sweep. Per-host reserved-byte quota includes the
declared size of incomplete uploads, not merely bytes already received.

## Decoding and private storage

Bytes live below the configured state root in a mode-0700 attachment directory. Blob/index access
uses no-follow file descriptors, regular-file/single-link checks, mode-0600 files and owner checks.
The configured state root and private lock directories cannot be symlinks. Index changes use a
unique exclusive temporary file, file fsync, atomic rename and directory fsync. Byte fsync precedes
received-offset persistence. Invalid private state refuses instead of inventing a usable reference.

The hidden `_attachment-validate` helper receives only bytes on stdin and emits bounded structured
metadata. It inherits no environment and is terminated on cancellation or deadline; decode does not
hold the session-registry/store locks or block the resident event loop. The parent rechecks bytes
and registration when committing the decoded result. Cancellation or expiry during decode cannot
resurrect an upload.

[pngjs](https://github.com/pngjs/pngjs) performs PNG decoding and CRC validation. A complete bounded
zlib inflation check precedes decode, including Adam7 scanline geometry, so a short header cannot
authorize unbounded decompression. [jpeg-js](https://github.com/jpeg-js/jpeg-js) decodes JPEG with
tolerant decoding disabled and explicit pixel/memory limits. Header signatures, complete framing,
decoded dimensions and byte digest are independently checked. Other formats are not advertised.

Public refusal is `ATTACHMENT_UNAVAILABLE` with a generic message. The last internal failure is
recorded in a bounded owner-only evidence file using a reason code, not image bytes, private paths,
decoder exception text or credentials.
