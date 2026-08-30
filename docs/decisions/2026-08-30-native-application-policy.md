---
title: Host-authorized native application policy
description: Pin canonical application sources independently from launch configuration and acknowledge native application without disclosing private materialization.
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# Native application policy

## Decision

The caller selects an immutable `{id, revision}` reference. Machine configuration owns the
`agentPolicies` mapping: runtime, canonical source references with SHA-256 digests, explicit trusted
roots, and supported native selections. Launch recipes remain responsible for process environment,
credentials and configuration. Application policy adds no environment mechanism or agent loop.
The policy mapping is an authorized composition, not a copy of instruction or skill bodies.

There is one current contract. Strict schemas refuse inline instructions, arbitrary source paths,
permission grants, raw MCP configuration and unknown fields in public policy references. Native
unsupported policy is unavailable, not silently approximated. Public metadata contains only policy
identity/revision/digest, canonical source IDs/digests/kinds and supported capabilities. Private
source paths, frontmatter, native agent objects and text bodies do not belong in receipts, status,
native content projection, process arguments or outward errors.

## Sources and lifecycle

`src/policy/resolve.ts` resolves a composition before create journaling, registration mutation or
provider spawn. Files must be canonical absolute paths under explicit trusted roots, regular UTF-8
files, owned by the execution user or root, and not group/world writable. Symlink paths, writable
parent directories within the trust root, malformed text and digest mismatch fail closed. Each
source is limited to 64 KiB; aggregate materialization is limited to 256 KiB. Reads are bounded,
use no-follow/non-blocking file descriptors and check the visible inode and read stability.
Trusted roots themselves must be canonical. An administrator able to replace a trusted root is
inside the owner trust boundary; filesystem checks are not a sandbox against the host owner.

The accepted metadata binds the complete host definition, including private source locations, by
digest. Every restart, resume and turn admission calls `verifyApplicationPolicy` against the
accepted metadata. Changed definitions or source bytes never silently upgrade an accepted session.
Revisions change by explicit host configuration and a new accepted create; there is no implicit
policy-switch operation. Existing managed/native identities and accepted operations remain intact
when a required policy becomes unavailable.

Evidence progresses `desired → applied` only after native acknowledgement. Failed validation or
native acknowledgement produces `unavailable`; a historical applied receipt is not proof that a
new process has applied policy. On restart the adapter revalidates sources and native capabilities,
then obtains fresh native acknowledgement for the same managed/native identity. The domain evidence
projector does not perform that acknowledgement: the native adapter owns the transition.

## Codex

Canonical instruction bodies are composed with supervisor instructions in memory and sent through
native `thread/start` and `thread/resume` `developerInstructions`. They are never sent as user text
or process arguments. Collaboration-mode settings retain native preset instructions separately:
their `developer_instructions` override remains null, not a replacement for thread instructions.
The execution host still owns sandbox/approval ceilings. The native provider maintains separate
context sections for collaboration-mode instructions and client developer instructions.

Selected skills use native `turn/start` skill items `{type:"skill",name,path}`. Before admission,
the adapter refreshes `skills/list` for the exact workspace and verifies each selected name/path is
uniquely discovered and enabled. The native runtime, not CCMux, loads skill bodies. Discovery and
selection are distinct from evidence that a real turn consumed a skill; live acceptance must prove
the latter. Applied native-selection evidence requires a successful skill-bearing turn admission or
an exact native user-message acknowledgement. A resume without such acknowledgement remains desired
until the next selected-skill turn; discovery alone does not upgrade it. A changed source invalidates
admission even if native discovery still lists its name.
Arbitrary per-tool and MCP permission mutation has no supported policy mapping here and is refused.

## OpenCode

Host policy points to an existing native agent and its canonical Markdown source. The adapter reads
classic `app.agents` (`GET /agent`), checks a unique selectable agent, and compares its native prompt
to the canonical Markdown body (only frontmatter and outer whitespace/CRLF normalization are
removed for comparison). The validated agent name is passed in native session prompt admission.
Source identity is pinned to the full file, including frontmatter. The native agent owns its system
prompt, tools, skills and agent loop; CCMux writes no duplicate agent configuration.

Optional `denyTools` is a restrictive assertion, not a grant or a mutation. Each requested tool must
already have an effective native all-resource denial with no later allow/ask exception. Failure
refuses admission. All other host-native permissions remain in force. There is no raw caller allow
list that can override a host denial. Arbitrary MCP restrictions and unsupported v2-only operations
are refused. This decision does not migrate the existing classic session writer to v2.

## Integration and evidence boundary

The create fingerprint and durable session store pin `ApplicationPolicyMetadata`. The private
materialization is recreated from host sources, not stored in the public receipt or a second
transcript database. Native adapters recheck policy before their mutation; create, bootstrap,
resume, message delivery and collaboration-mode changes must all use that same check. Native skill
items and the selected OpenCode agent must accompany every relevant native turn admission.

Focused domain tests cover reference/source/permission validation, independent profiles, repeat
resolution and changed-source restart refusal. They do not replace live two-profile native-turn,
skill-consumption, restart, control-operation or publication acceptance for the package.

Launch stamps store only immutable public policy metadata. List/monitoring stamp comparison never
reads application source bodies; those bounded reads happen at lifecycle and native admission
boundaries. Stale status projections downgrade applied policy evidence to unavailable.

`bun --no-env-file scripts/native-policy-acceptance.ts` exercises the current public service with
real installed Codex and OpenCode runtimes and existing native authentication. It creates isolated
configuration/state/tmux ownership and two canonical policy profiles per runtime. The user message
does not contain verification tokens: returned instruction-plus-skill or native-agent tokens prove
actual native consumption through bounded public content. The probe also checks duplicate create
and message receipts, daemon and provider restart with unchanged identities, changed required sources
refused before native spawn, and private-source/fixture secrecy in requests, responses and argv.
An exec trace records only native subcommands so a no-spawn assertion has a positive baseline.
Probe registrations are archived, processes are stopped, and private evidence/native history are
retained; production machine configuration and global native configuration are not edited.
