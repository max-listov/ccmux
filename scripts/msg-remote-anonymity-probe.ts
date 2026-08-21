#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./bundle.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const REMOTE_DIR_RE = /^\/tmp\/ccmux-msg-remote-probe\.[A-Za-z0-9]+$/;
const SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

type CommandResult = { code: number; stdout: string; stderr: string };

async function run(argv: string[], stdin: string | null = null): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    stdin: stdin === null ? "ignore" : new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await Promise.race([
    child.exited,
    Bun.sleep(COMMAND_TIMEOUT_MS).then(() => {
      child.kill("SIGKILL");
      throw new Error(`command timed out: ${argv[0] ?? "unknown"}`);
    }),
  ]);
  return { code, stdout: await stdout, stderr: await stderr };
}

const host = Bun.argv[2];
if (host === undefined || !SSH_HOST_RE.test(host)) {
  console.error("usage: bun scripts/msg-remote-anonymity-probe.ts <ssh-host>");
  process.exit(1);
}

const localDir = mkdtempSync(join(tmpdir(), "ccmux-msg-remote-probe-"));
const bundlePath = join(localDir, "ccmux.js");
let remoteDir: string | null = null;
let primaryError: unknown = null;
const cleanupErrors: unknown[] = [];

try {
  if (!(await buildBundle(bundlePath))) throw new Error("probe bundle build failed");

  const allocated = await run(["ssh", host, "mktemp", "-d", "/tmp/ccmux-msg-remote-probe.XXXXXX"]);
  if (allocated.code !== 0) throw new Error(`remote mktemp failed: ${allocated.stderr.trim()}`);
  const candidate = allocated.stdout.trim();
  if (!REMOTE_DIR_RE.test(candidate)) throw new Error("remote mktemp returned an unexpected path");
  remoteDir = candidate;

  const upload = await run(["scp", bundlePath, `${host}:${remoteDir}/ccmux.js`]);
  if (upload.code !== 0) throw new Error(`bundle upload failed: ${upload.stderr.trim()}`);

  const remoteScript = `
set -eu
probe_dir="$1"
mkdir -p "$probe_dir/state"
printf '%s\\n' '{"claudeBin":"/bin/false","tmuxBin":"/bin/false","projectsDir":"/tmp","rcPrefix":"host-a","stateDir":"'"$probe_dir"'/state","bootLabel":"probe.service"}' > "$probe_dir/machine.json"
printf '%s\\n' '{"name":"worker","dir":"/tmp","uuid":"${THREAD_ID}","agent":"claude","chatEnabled":true}' > "$probe_dir/state/sessions.jsonl"
CCMUX_CONFIG="$probe_dir/machine.json" bun "$probe_dir/ccmux.js" msg worker hello
ledger_count=$(wc -l < "$probe_dir/state/chat.jsonl")
printf 'PROBE_LEDGER_COUNT=%s\\n' "$ledger_count"
`;
  const executed = await run(["ssh", host, "bash", "-s", "--", remoteDir], remoteScript);
  const warningObserved = executed.stderr.includes("running under ssh without a managed sender")
    && executed.stderr.includes("cannot reply to the originating agent");
  const deliveryObserved = executed.stdout.includes("sent ccmux/cli@host-a")
    && executed.stdout.includes("PROBE_LEDGER_COUNT=1");
  if (executed.code !== 0 || !warningObserved || !deliveryObserved) {
    throw new Error(
      `remote SSH command-path probe failed: ${JSON.stringify({
        exitCode: executed.code,
        warningObserved,
        deliveryObserved,
        ledgerCountObserved: executed.stdout.includes("PROBE_LEDGER_COUNT=1"),
        stdout: executed.stdout.replaceAll(remoteDir, "<remote-dir>").trim(),
        stderr: executed.stderr.replaceAll(remoteDir, "<remote-dir>").trim(),
      })}`,
    );
  }

  console.log(JSON.stringify({ warningObserved, deliveryObserved, isolatedState: true }));
} catch (error) {
  primaryError = error;
} finally {
  if (remoteDir !== null) {
    const cleanup = await run(["ssh", host, "rm", "-rf", "--", remoteDir]).catch((error) => {
      cleanupErrors.push(error);
      return null;
    });
    if (cleanup !== null && cleanup.code !== 0) cleanupErrors.push(new Error("remote cleanup failed"));
  }
  try {
    rmSync(localDir, { recursive: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
}

if (primaryError !== null || cleanupErrors.length > 0) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter((error) => error !== null),
    "msg remote anonymity probe failed",
  );
}
