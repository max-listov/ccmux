---
title: Finite workload admission
description: The installed-launcher contract used by the attachment decoder and custom commands.
status: active
created: 2026-10-02 13:39 +07:00
updated: 2026-10-05 21:30 +07:00
type: architecture
---

ccmux can hand finite processes to an installed workload launcher that speaks
`node-workload-protocol/v1`. The launcher owns admission, the node budget and cleanup of the
process tree; ccmux does not keep a second resource registry. The machine config enables it with
one optional field:

```json
{
  "finiteWorkloads": {
    "launcherBin": "/usr/local/bin/node-workload-run",
    "profileFile": "/etc/workload/profile.json"
  }
}
```

Both paths are absolute. Numeric ceilings and reserves belong to the node profile, not to the
consumer. Without the field, processes are started directly, as before, without this resource
protection. With the field set, an unavailable launcher, an unsupported platform, an admission
refusal or a protocol error ends the operation with a reason; there is no fallback to a direct
spawn. Enable the field after the host policy is qualified — installing an update does not enable it.

## Execution

`src/runtime/finiteWorkload.ts` creates its own temporary directory (`0700`) holding the request
(`0600`) and the result, plus a separate `scratch/` subdirectory that is the payload's writable
scratch root. It runs the launcher without a shell with `--request` / `--result`. The
`node-workload-request/v1` request carries the payload argv, cwd, the declared-only environment,
the profile, the deadline and IO bounds. Binary stdin/stdout stay apart from the structured outcome.

`node-workload-result/v1` distinguishes completed, refused and failed. The outcome is believed only
when the launcher's exit code agrees with it (`launcherExitCode` in `workloadContract.ts`): refused
125, failed 126, completed the payload's code — and a payload ended by a signal, which has no code,
is reported by the launcher as 1. A payload that itself exits 125 stays completed. A missing or
malformed outcome is an exact internal error. ccmux removes only its own request directory after
the launcher has finished; it never erases the admission registry or SDK manifests.

The request holds the declared environment, which for a custom session includes its chat
credential. The launcher reads it at start; the file lives until the launcher settles. A directory
left behind by an owner that died is removed by the daemon's daily maintenance pass (first run a
minute after start), once it is older than every workload deadline plus grace.

## Cancellation

Cancelling a custom command asks the adapter for SIGKILL; the adapter sends the launcher SIGTERM so
the launcher can take the payload tree down, and escalates to SIGKILL after
`WORKLOAD_CANCEL_GRACE_MS`. The same escalation bounds the launcher itself at its deadline plus the
grace. An escalated cancel settles as `failed` / `workload-cancel-timeout`: bounded beats complete
when the launcher does not answer. The installed launcher guards against its caller dying through
its own process-instance identity; ccmux does not reproduce that mechanism.

## Connected paths

The attachment decoder passes binary input and keeps its usual image-validation result. Abort waits
for settlement, which the escalation above bounds. An admission failure keeps its internal cause;
the outside sees the `AttachmentFault` contract.

The custom `run_command` tool is connected through the published `AgentProcessSandbox.spawn`.
`probe()` reports `partial` (process-contained) only for a launcher on Linux that describes protocol
v1; a missing launcher, a description that is not JSON or any other failure reports `unavailable` —
it never throws. This is a partial sandbox: network, secrets and workspace write isolation are not
claimed. The scratch limit is not a hard quota for arbitrary files in the tool's cwd. A 30 s deadline
and 32 768 bytes of output keep the existing custom-command bounds.

## Boundaries

Native provider servers, the custom harness, resident MCP servers, tmux and the daemon are not
placed in a finite slot. Resource protection for resident trees needs its own supported contract
and policy. External writers do not become managed by ancestry alone. The finite contract is
unsupported on Darwin: configured execution refuses explicitly, and a missing configuration is
never reported as protection in force.

`test/finite-workload.test.ts` drives a protocol-v1 fake launcher through completed, refused,
exit-mismatch and signalled-payload outcomes, an ignored cancellation, a missing launcher, `probe()`
and the sweep of abandoned request directories.
