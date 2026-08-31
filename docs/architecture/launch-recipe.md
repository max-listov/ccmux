---
title: What shapes a session, and how ccmux knows it changed
description: The launch recipe — argv plus the external inputs an agent reads at startup — and why the RESTART column can be trusted
type: architecture
status: active
created: 2026-08-25
updated: 2026-08-30
---

# What shapes a session

A running agent never re-reads what it was configured with. Everything below is read once, at
startup, and lands only on the next restart. So "would relaunching this session give it something
different?" is the question `ccmux list` answers in its `RESTART` column, and the launch stamp is
what makes it answerable an hour later rather than something the operator has to remember.

## Four layers, one recipe

| Layer | Where it lives | How the stamp sees it |
|---|---|---|
| ccmux's own prompt, `--settings` hooks, statusline, mode, flags | argv | hashed argv |
| capabilities handed through the environment (identity pin, chat credential) | process env | variable **names** |
| the agent's global rule set, its MCP configuration | the user's files | digest per input |
| the env files in the session's own directory | the session directory | digest + variable names |

The first two were there from the start. The last two were not, and their absence had a measured
cost: a global rule set changed, every session on the fleet was running yesterday's rules, and the
column was blank for all of them. The only remedy left was bouncing two dozen sessions on three
machines without knowing which had actually fallen behind.

## Server-owned recipes selected through control

The public control API can select a named execution-host recipe for a newly managed Codex App
Server session. The reference contains only id and revision. The host definition resolves to the
same `Session.flags`, `Session.envFile`, environment builder and launch stamp described above; it is
not another launch path. Its canonical digest and safe capability labels are stored with the
session so create retry and restart can prove they are applying the same recipe.

The definition can require environment variable names and configure a native model provider through
the existing allowed `-c key=value` argv. A provider config names an environment key; the secret
value remains in the declared env file or host environment and never becomes argv. Missing inputs,
reserved CCMux names, refused native flags and revision/digest drift fail before provider spawn.

A Custom recipe additionally names which adapter answers for its model registry. `openrouter`
requires a credential environment name; `local` carries an OpenAI-compatible endpoint and an
optional one, because the common local model servers accept requests without authentication. The
endpoint is a recipe value and never a caller input, and it is accepted only as an http or https URL
whose host is `localhost` or a loopback, private or link-local address literal, with no embedded
credential, query or fragment. A public address cannot be configured as `local`, so the provenance
the catalog publishes for an answer is a property of the configuration rather than a label attached
to it. Every model in the registry declares the kind that serves it; a mismatch is refused when the
recipe is defined, not when a turn reaches the provider.

The local kind may also name its server with an optional `label`, reported beside the locality fact
and never used to select anything.

A recipe may additionally pin `collaborationMode: "plan"` (or the explicit provider default). This
is turn policy, not caller-authored prompt text: before every managed turn it starts, CCMux asks the installed
App Server for its collaboration-mode catalog, selects the named preset and uses the provider's
effort and built-in instructions while preserving the loaded thread's model, even if the preset
names another model. The check happens before a delivery pickup is persisted.
An absent method/preset or missing loaded-thread model fails closed; recipe-less sessions send no
mode override and retain the provider default. A human turn submitted directly by an attached TUI
uses that TUI's explicit interactive selector; it does not pass through the control turn boundary.

The control projections show only `{ id, revision, digest, capabilities, collaborationMode? }`. They do not show recipe
flags, paths, required environment names, file contents or values. See the
[control launch recipe decision](../decisions/2026-08-29-server-owned-control-launch-recipes.md).

An optional typed `modelSelection: { provider, model }` is independently fingerprinted and persisted
with the session. It composes with the resolved flags using the existing native configuration path,
is included in the launch stamp, and is checked against native start/resume responses. One profile
therefore serves multiple native catalog models. Safe selection metadata accompanies the recipe in
control receipts and projections; authentication, endpoints and permissions remain host-owned.

## Why the digests are narrow

An input is hashed **narrowly and by name**, never by the file it happens to sit in:

- The MCP table, not the configuration file around it. Agents rewrite those files constantly — start
  counters, per-project state, cached flags — and hashing the file would light the column for the
  whole fleet several times an hour. A column that cries wolf is worse than no column: it is the same
  failure that got `version` removed from the comparison, and it drowns the real `chat`/`mode`.
- Global rules, not project rules. A person edits project rules several times an hour while working
  in them; including those would flag whichever session is being worked in, permanently.
- A rule set is the entry file **plus what it imports**, resolved for this machine. Hashing only the
  entry would call two machines identical while they ran different rules — the same false "nothing
  changed", one level down.
- Not the agent's settings file. Its permissions block is written from inside a running session, so
  a session would mark *itself* stale mid-turn for a change already in effect.

Digests are fingerprints: a rule set is somebody's private text and an MCP table holds credentials,
so nothing is stored that could be read back out. Reads are cached by mtime, because stamps are
recomputed on every `list` and `fleet` — measured at ~1 ms cold and ~0.07 ms warm per session.

## Who owns what

The **provider** owns which external files its agent reads, because the locations are agent-specific
and the core must not learn them (`launchInputs` in the provider contract). The **core** owns the env
layer, because that one comes from the supervisor's own runtime rather than from any agent.

Unknown is never stale. A stamp written before an input existed carries `null` for it and is never
reported — the same doctrine as a missing stamp, and the reason the first upgrade to a build that
knows about a new input does not paint the whole fleet red.

## The env layer: from an accident to a declaration

`_run` is a Bun process started with the session's directory as its cwd. Bun loads that directory's
`.env` into its own environment, and the launcher copied its environment into the agent. So a
project's `.env` reached the agent **and every process the agent spawns** — MCP servers, shell tools,
subagents — with nobody having declared it.

Nobody designed this; it followed from the supervisor being written in Bun, which is the sharpest
form of the problem: an implementation detail had become product behaviour, and changing runtime
would have silently changed the product. Measured on a live fleet: 5 of 14 sessions were carrying
project variables this way, API keys among them.

The environment is now a **recipe**: inherited environment, minus whatever the working directory's
env files declare, plus the file the session declares (`envFile`), which wins. Two mechanisms hold
it, and they fail in different places — which is why there are two:

1. **The pane command carries `--no-env-file`**, so the runtime never loads those files into the
   supervisor at all. Verified against Bun 1.3.14.
2. **The recipe subtracts those names anyway** when building the agent's environment. Verified
   necessary: a `bun build --compile` binary never sees the flag (it lands in the app's argv, not the
   runtime's), and neither an environment variable nor `bunfig.toml` substitutes for it there — all
   four candidates probed. Without this, a compiled build would go back to leaking while every test
   still passed.

The subtraction is by name and therefore approximate in one case: a variable that is both in the
directory's env file and genuinely in the supervisor's environment is dropped too. That is the safe
direction — a missing variable is visible and fixable by declaring it, a leaked secret is neither —
and mechanism 1 makes the case unreachable in production.

### Why ccmux parses the declared file itself

Handing the path to the runtime's own `--env-file` would put the file's variables into the
**supervisor**, where a project file could then set `CCMUX_STATE_DIR` and repoint the whole instance.
Parsing here keeps the file's reach where it was declared to reach — the agent — and keeps the recipe
a property of ccmux rather than of its host runtime. `CCMUX_*` names are refused outright and
reported: a session grants a project variables, it does not let a project reconfigure its supervisor.

A declared file that is missing costs a variable, never the session. A supervisor whose sessions
refuse to boot is worse than one variable short — self-heal would beat itself against a vanished file
forever — so `list` prints the missing path and `doctor` repeats it.

### Migration is a state you can read

Sessions started before the recipe keep the environment they were launched with until they restart.
`doctor` lists exactly those, `ccmux env-file --adopt` turns what they are inheriting into
declarations, and when the list is empty the migration is provably over. The distinction is drawn
from the stamp: a stamp with no `inputs` map was written by a build that inherited, so its session is
still carrying those variables; a stamp whose `inputs.env` is null was written under the recipe, so a
file beside it is inert and reporting it would be crying wolf.
