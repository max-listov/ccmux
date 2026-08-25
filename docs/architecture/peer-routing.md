---
title: Peer routing and session identity
description: Canonical identity and transport boundaries for ccmux-managed sessions and Codex Desktop tasks
type: architecture
status: active
created: 2026-08-10
updated: 2026-08-25
---

# Peer routing and session identity

Provider, source, address, and capability answer different questions. They must not be collapsed
into a cwd-based guess.

| Dimension | Question | Examples | Routing role |
|---|---|---|---|
| Provider | Which agent runtime owns the conversation? | `claude`, `codex` | Selects launch, transcript, pane, and lifecycle adapters. |
| Source | Which system emitted the identity/message? | `ccmux`, Codex Desktop | Names the source of truth; it is not a provider. |
| Coordination plane | Which routing contract is active? | `ccmux-managed`, `desktop-native` | Selects the discovery, addressing, and delivery operations. |
| Address | Which exact managed session is the target? | `host-a:agent-a` | Routes a ccmux command to one registered session. |
| Capability | What can that source/provider pair actually do? | managed chat, wait, native Desktop task messaging | Decides which operation is legal; capability is not identity. |

Two sessions can share one project directory while using different providers or sources. Therefore
cwd, project name, model name, and recency are never routing keys. `ccmux list --json` requires an
`agent` field for every local session. `ccmux fleet` preserves the field from peers; if an older peer
does not send it, the human view says `unknown` instead of silently claiming Claude.

## ccmux-managed plane

The human selector is the exact `<machine>:<session>` address. At send time it resolves to and pins
`source + machine + provider + session + thread UUID`; queued delivery and retry validate that full
endpoint, so reusing a name cannot redirect mail. A bare session name means the current machine only.
ccmux owns the registry, tmux persistence, daemon self-heal, transcript
adapter, wait state, and managed routing identity for these sessions. Claude currently has a
calibrated pane chat adapter; Codex targets fail explicitly until the separate managed-Codex chat
task supplies equivalent delivery detection. Identity support never implies a delivery capability.
The provider remains visible next
to the address so a human or agent can choose deliberately between, for example,
`host-a:agent-a` (`claude`) and `host-a:agent-b` (`codex`) in the same directory.

The address selects the target; provider and UUID validate and pin it. Provider is not added
as an alternative address syntax, because parallel address forms would create two sources of truth.

Each v2 chat envelope carries full structured `from` and `to` identities. Remote send resolves the
target once, then receiver and retry use that same immutable provider+UUID endpoint. The receiver
serializes idempotency check+append, so concurrent retries produce one ledger row. A rotating
per-runtime capability prevents a shell that merely self-sets `CCMUX_SESSION` from being promoted
from `cli` to a managed sender. An authenticated remote transport is the remote admission boundary. These mechanisms prove ccmux
process/routing provenance, not security against a hostile process with the same OS user, which can
read ccmux state; provider metadata never increases trust.

An outbound `msg` invoked directly beneath an authenticated remote transport (`sshd` or the local
Stitchwire agent) without managed identity remains legal and keeps exit code zero after a successful
send, but it is never silent: stderr warns that the envelope was sent as `cli`, has no route back to
the originating agent, and must instead be addressed through `ccmux msg <machine>:<session>` from
that managed session. A local human CLI is intentionally quiet; the distinction comes from process
ancestry, not from forgeable environment variables or a guess based on the recipient address.

The active state bundle keeps canonical names: `chat.jsonl`, `chat-cursors.json`, `chat-ack.jsonl`,
`outbox.jsonl`, and `outbox-ack.jsonl`. Its records carry the generation; superseded state lives
under `archive/` because name-only rows cannot be upgraded without inventing provider and UUID.
Lifecycle operations are not chat: `restart --then` does not exist, and a work hand-off must use a
recorded `msg` envelope.

### A name is not a role, and picking one for the other fails silently

A session name is chosen once, and it is usually the project's. A project has several sessions and
only one of them owns any given decision — so an address picked from a project name **resolves, is
delivered, and exits zero**, onto the neighbour. Nothing anywhere reports a problem. Measured on the
fleet: an hour spent believing a report had reached the owner of a contract, while it sat in a
session that does not decide contracts.

This is the same class the machine label removed, one level in. `host-a:api` and `host-b:api` are
told apart; two sessions of one project on ONE machine were not.

So a session may declare what it is FOR, and an address may select on that:

```bash
ccmux role agent-a contract-owner       # declare — applies at once, no restart
ccmux role                              # what answers to what, on this machine
ccmux msg host-a:@contract-owner "…"    # address by role
```

Four properties carry it, and the label itself is the least of them:

- **`@` is a separate namespace, not decoration.** Without a sigil a role and a session name compete
  for one space, and an address that is both would have to pick — which is the bug.
- **Ambiguity REFUSES.** A role matching two sessions never chooses one. The refusal is the
  mechanism; a role merely printed somewhere is documentation, and documentation is not read at the
  moment an address is chosen.
- **The refusal carries what a reader needs to choose** — each candidate's directory, what it last
  said, and the exact address to retry with. A refusal that only redirects to another command leaves
  the sender guessing from the same information that misled them.
- **It costs nothing to change** (`ccmux role`, no restart, never a `stale` flag). A second name that
  is expensive to correct is one people put off correcting, and within a week it lies while being
  trusted — worse than having no role at all. Only the name is stored; nothing is snapshotted.

Absent is the ordinary state: a session without a role is addressed by name exactly as before. A
remote role resolves against the SAME `list --json` answer the peer identity comes from, so a session
cannot be selected by a role it held one call ago, and a peer too old to report roles simply declares
none.

### An owner outside the fleet is an address, not a gap

A component owner may work as an agent in another product, under another subscription. ccmux is not
that product's transport and must not pretend to be — one hop through a person is cheaper than
integrating with someone else's product. The defect was never the hop; it was that the hop was
**unwritten**. No record, no reply address, no way to ask what had not come back. And with nobody to
address, people addressed the project, which is usually also a session name.

So there is a third kind of target beside `managed` and `owner`:

```jsonc
{ "externals": { "contract-owner": "works in <product>; ping them in its own chat" } }
```

```bash
ccmux msg owner/contract-owner --task release "please cut a release"
ccmux relay owner/contract-owner --task release "shipped in 1.2.0"
```

- `owner/<name>` carries no colon, so `<machine>:<session>` parsing can never see it, and the word
  `owner` already means "the human this party is reached through". An undeclared name is refused —
  the failure being removed is a message that went somewhere real and wrong, so an address resolving
  to nothing must stop rather than improvise.
- The declaration is **prose** because a person reads it. Anything more structured would be a promise
  ccmux cannot keep and would invite an automatic delivery that cannot exist.
- Delivery **refuses and names the route**. A half-success would leave the sender believing it had
  reached the owner, which is precisely what this address exists to prevent.
- The record is **awaiting a reply by default**, never a flag. A flag the sender must remember is
  wrong within a week — the same trap as a role nobody updates — and waiting for an answer is the
  norm here, not the exception.
- The answer comes back as a **relay**: `onBehalfOf` already means "who this truly came from when
  `from` is only the courier", so the sender sees the attribution while nothing gains the ability to
  impersonate a party ccmux cannot authenticate. Answers are counted per letter and per task; two
  errands want two answers.

An external record never crosses a machine boundary: `_chat-receive-v2` accepts managed targets only,
and the address is intercepted before any route is resolved. It does live in the local ledger, which
is why the ledger had to learn to step over a record it cannot read — with its position kept, since
delivery cursors are positions — **before** this kind could be written anywhere. That ordering is not
optional, and it is the same one the event feed already follows: the consumer's machine goes first.

## Two transports, one address

`<machine>:<session>` never says how a call travels. Two transports carry it, chosen per direction in
`machine.json`:

| Transport | Reaches | Requires | Configured by |
|---|---|---|---|
| ssh | a machine with an address and a key | the receiver to be reachable | `fleet: { <machine>: <alias> }` |
| stitchwire | any machine running the agent | nothing inbound at all | `wire: { peers: [<machine>] }` |

ssh cannot address a roaming laptop, and never will: it has no stable address, and giving it an
inbound port plus a server-held key would invert the trust model to buy one direction. stitchwire
inverts the *connection* instead — every node dials out to a broker and keeps that link — so
`dev:<session>` reaching `host-C:<session>` becomes possible while no node holds a credential to another
node.

### How to reach a peer, and how to check it

Two rules cover every case, and neither depends on a person being connected:

1. **Between machines that can address each other** — ssh. *How* those machines authenticate is a
   property of that fleet's ssh configuration, not something ccmux knows or should assume. A key file
   sitting in `~/.ssh` is not evidence of being authorised on the other end, and `IdentityAgent` in
   `ssh_config` overrides `SSH_AUTH_SOCK`, so a fleet may in fact authenticate only through a
   forwarded identity. Read the config before asserting anything about it.
2. **To a machine with no address of its own** (a laptop that roams) — the wire, because it dials out
   and keeps the link. List it in `wire.peers` and address it exactly like any other: `<machine>:<session>`.

Checking a route takes one command, and the flags matter:

```
ssh -o ControlPath=none -o BatchMode=yes <peer> "ccmux --version"
```

Both flags matter, and a third one usually does too:

- `ControlPath=none` — with multiplexing on, ssh reuses a master connection somebody else opened and
  answers without authenticating at all.
- `IdentityAgent=none` — `ssh_config` may point ssh at an agent socket regardless of the environment,
  so unsetting `SSH_AUTH_SOCK` proves nothing on its own.
- `BatchMode=yes` — stops it waiting on a prompt.

Note what is NOT a substitute: unsetting `SSH_AUTH_SOCK` in the environment. `IdentityAgent` overrides
it, so that check answers according to whether the configured socket happens to be alive this minute —
false yes and false no from the same command minutes apart. Isolate the agent with the flag, never
with the variable.

Leave any of them out and the check can pass for a reason that has nothing to do with the credentials
you meant to test. This is not hypothetical: a fleet-wide claim was once broadcast off a ten-for-ten
check that was measuring somebody else's live connection the whole time.

### A forwarded agent is not a credential this session owns

`SSH_AUTH_SOCK` names a socket belonging to the login that exported it. A supervised session outlives
that login by design, so the variable is a promise the session cannot keep: after the login ends, ssh
started from that session WAITS on a socket with nothing behind it. It looks exactly like "this
machine has no access", and it is not — it is ssh never getting as far as trying anything else.

tmux delivers it: its default `update-environment` copies these variables from whichever client
creates a session, so restarting a fleet over ssh with agent forwarding hands every session a socket
that dies with the caller. Note also that `IdentityAgent` applies per `Host` block: a peer reached by a bare address, with no
alias in `ssh_config`, gets none of it and needs the agent named explicitly. The rule that survives
both cases is *do not invent a socket path* — point at whatever canonical, maintained path the fleet
keeps, never at a `/tmp` socket copied out of an old environment.

ccmux therefore drops these variables at launch **when the socket is already dead**, and logs what it
dropped. A live socket is never touched: whether a machine can reach its peers without it is that
fleet's business, and taking away a working credential to enforce a theory would be worse than the
problem.

The diagnostic worth remembering: a dead socket presents as EITHER a hang that ends in a timeout OR
an instant `Permission denied (publickey)`, depending on how far ssh gets. Response time therefore
tells you nothing. The only reliable answer comes from the check above with all three overrides, plus
looking at the socket itself — whether the path resolves and whether an agent answers on it.

### A hop that fails is not a message that was lost

Both transports flap. A cross-machine `msg` writes its envelope to the outbox **before** the hop is
attempted, and a drain loop retries it for an hour. So a failed hop means *not yet*, not *never*, and
the sender is told exactly that: queued, retried automatically, nothing required of anyone.

This paragraph exists because the opposite wording cost real work. The failure line used to say
"nothing was sent" and, when the transport reported no reason, supplied one: "no agent forwarding".
Both were false. Two separate sessions read it, concluded their machine could only reach its peer
through the owner's forwarded key, and carried a non-existent problem to the owner — while the
supervisor had already delivered every one of those messages on retry. A diagnostic that guesses is
worse than one that says nothing: the guess gets believed and acted on.

The rule that follows: never name a cause the transport did not report, and never describe a queued
message as a lost one.

A machine listed in `wire.peers` is reached over the wire even when it also has an ssh alias. That is
what makes the wire adoptable one direction at a time: a fleet-wide flag would make "which path did
that call take" unanswerable exactly while it matters.

### What the wire's answer says, beyond yes and no

The local door separates **who** said no (`failure`) from **what kind** of no it is (`refusal`), and
the kinds behave oppositely:

| refusal | lifetime | correct response |
|---|---|---|
| `capacity` | temporary | retry — the data is intact and the caller did nothing wrong |
| `policy` | permanent | an allowlist or a grant says no; retrying changes nothing |
| `request` | permanent for this request | change the request, then retry |

Reading only `failure` made both mistakes at once: an hour of retries against a refusal that will
never change, and a healthy-but-busy node drawn as a broken one. So a permanent refusal now settles
instead of queueing, and says so in words — the queued-for-retry sentence promises an automatic
recovery, and promising one that cannot come is worse than saying nothing, because nobody then looks
at what actually needs fixing.

The door also carries a contract version (`v`), and it is **compared, not pattern-matched**. Without
the comparison, a door speaking a contract this build does not know is indistinguishable from a
malformed answer — and the reader goes looking for a broken agent instead of a version skew. Unknown
keys, by contrast, pass through: strict parsing of somebody else's evolving answer means "break on
their next release".

### A retry uses the same resolver as a send

Not a second lookup. The drain pass used to read the ssh map directly and, finding no alias, settle
the envelope as delivered — on a fleet whose laptop is reachable **only** over the wire, that threw
away every retry to the one machine the wire exists for, silently and with no error anywhere. The
only honest settle case is a target that is in neither map.

### The reply hint is the resolver's answer, not a second map

An incoming chat tag carries a pinned `reply:` command, and the managed prompt tells the recipient to
use it verbatim. That makes the hint **prescriptive**: a wrong verdict does not look untidy, it sends
the answer somewhere the sender will never see it — silently, with no error on either side.

So the hint asks the same resolver `msg` delivers with (`routeFor`), and nothing else. It used to read
the ssh map directly, which made every wire-only direction unreachable *in the tag* while it was
carrying mail: a machine with `wire.peers: [<hub>]` and a live agent was told "no route back to
`<hub>`" and answered the human, minutes after `ccmux msg <hub>:<session>` from that same box
delivered instantly. One resolver means a direction that moves onto a new transport moves its hint
with it.

Beyond routing, exactly one thing is checked: the local end of the wire, because `msg` resolves the
exact remote peer *before* queueing anything — with no agent socket here the reply command exits 1
rather than queueing for retry, and a command that errors is worse than none. It is a file-existence
check and never a probe: this runs on the daemon's delivery cadence, and a timeout-shaped question
would answer "unreachable" for a healthy-but-busy agent — the same false negative in a new place.
Whether the *far* side is up is not asked; the hop itself answers that, honestly (queued, retried).

When the hint does fall back to `msg owner`, it names the reason the resolver gave — unknown machine,
no transport configured, local agent down. A bare "no route" is the one shape a reader cannot act on:
it names nothing to check, so it can only be believed.

**Invariant: a stitchwire node id IS a ccmux `rcPrefix`.** One label names one machine in both
systems. `ccmux doctor` proves it per peer by asking the far side which prefix it reports — a
mismatch would deliver correctly-addressed mail to the wrong box, which is the failure fleet
addressing exists to remove.

Admission is transport-shaped, not transport-specific. An inbound chat receiver must descend from an
authenticated remote transport: **sshd**, or **the local stitchwire agent** — the daemon that
authenticated to the broker with this machine's own token and runs only what this machine's
allowlist names. Both are proved by walking the process tree, because ancestry is kernel truth while
an environment variable is a claim the caller writes. `stitchwire call` is explicitly NOT admitted:
it is the outbound side, and treating it as a transport would let any local process launder itself
into delivery by shelling out through the CLI.

## Desktop-native plane

A Codex Desktop task is owned by the Desktop app and addressed by its native task ID. Coordination
uses the task tools injected into that Desktop task. Desktop process lifetime, task discovery, and
native task messaging are not ccmux registry state.

The boundary is intentionally zero-ledger: ccmux does not copy Desktop messages into its managed
chat ledger, and it does not synthesize managed chat records for native Desktop calls. This avoids
duplicate delivery, conflicting unread state, and false claims that a Desktop task is daemon-healed.
If a workflow needs both planes, the caller must name the target source and exact identity; a shared
cwd is not a bridge.

## Capability-driven routing

1. Identify the coordination plane: `desktop-native` or `ccmux-managed`.
2. Resolve the exact native task ID or ccmux fleet address from that source's own discovery surface.
3. Confirm the provider/capability shown by that surface.
4. Invoke only the source-native operation.

Missing provider metadata is `unknown`. It may be displayed for version-skew diagnostics, but code
that requires a provider adapter must fail explicitly rather than defaulting to Claude.

| Plane / API | Discover | Write | Wait | Status meaning |
|---|---|---|---|---|
| `ccmux-managed` | `ccmux list/fleet` | `ccmux msg` only when the provider exposes managed chat | `ccmux wait` | `idle/working/stopped` are ccmux lifecycle/pane states. |
| `desktop-native` | Desktop task list/read tools | Desktop native task send tool | Desktop native task wait tool | Native task state belongs to the Desktop host. |
| Codex App Server observer | `thread/list/read` | No write capability is inferred from visibility | Protocol-specific | `notLoaded` is process-local and does not mean dead, unowned, or writable. |

Transcript visibility is read capability only. It never grants write ownership or authorizes moving
a native task into the managed registry.
