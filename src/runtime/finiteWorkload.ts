import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FiniteWorkloads,
  launcherExitCode,
  WORKLOAD_CANCEL_GRACE_MS,
  WORKLOAD_DIRECTORY_PREFIX,
  type WorkloadOutcome,
  WorkloadOutcomeSchema,
} from './workloadContract.ts';

export interface FiniteWorkloadInput {
  label: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  maxStdinBytes: number;
  stdin?: Uint8Array;
}

/** The installed launcher owns admission and cleanup; this adapter owns only its process IO. */
export function spawnFiniteWorkload(config: FiniteWorkloads, input: FiniteWorkloadInput) {
  const directory = mkdtempSync(join(tmpdir(), WORKLOAD_DIRECTORY_PREFIX));
  // The payload's writable scratch is a directory of its own, apart from the request (which holds
  // the declared environment) and the result the launcher writes.
  const scratch = join(directory, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  const request = join(directory, 'request.json');
  const result = join(directory, 'result.json');
  writeFileSync(
    request,
    JSON.stringify({
      schema: 'node-workload-request/v1',
      label: input.label,
      mode: 'disposable',
      profileFile: config.profileFile,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      scratchRoot: scratch,
      env: input.environment,
      envPolicy: 'declared-only',
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      maxStdinBytes: input.maxStdinBytes,
    }),
    { mode: 0o600 },
  );
  const child = spawn(config.launcherBin, ['--request', request, '--result', result], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  let cancelled = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (escalation !== null) return true;
    cancelled = true;
    escalation = setTimeout(() => child.kill('SIGKILL'), WORKLOAD_CANCEL_GRACE_MS);
    return child.kill('SIGTERM');
  };
  // The launcher enforces the payload's deadline; this bounds the launcher itself.
  const deadline = setTimeout(cancel, input.timeoutMs + WORKLOAD_CANCEL_GRACE_MS);
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  let launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  child.stdin.on('error', (error) => {
    launchError = error;
  });
  child.stdin.end(input.stdin);
  const settled = new Promise<WorkloadOutcome>((resolve) => {
    child.once('close', async (code, signal) => {
      let outcome: WorkloadOutcome;
      try {
        outcome = WorkloadOutcomeSchema.parse(JSON.parse(await readFile(result, 'utf8')));
        if (code !== launcherExitCode(outcome) || signal !== null)
          throw new Error('workload-result-exit-mismatch');
      } catch (error) {
        outcome = {
          schema: 'node-workload-result/v1',
          status: 'failed',
          reason:
            cancelled && signal === 'SIGKILL'
              ? 'workload-cancel-timeout'
              : 'workload-outcome-unavailable',
          detail: launchError?.message ?? (error instanceof Error ? error.message : String(error)),
        };
      }
      clearTimeout(deadline);
      if (escalation !== null) clearTimeout(escalation);
      // Launcher has settled; SDK manifests/registry are separate and never erased here.
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        outcome = {
          schema: 'node-workload-result/v1',
          status: 'failed',
          reason: 'workload-request-cleanup-failed',
          detail: String(error),
        };
      }
      exitCode = outcome.status === 'completed' ? outcome.exitCode : null;
      signalCode = outcome.status === 'completed' ? outcome.signal : null;
      resolve(outcome);
      if (events.listenerCount('error') > 0) {
        if (outcome.status !== 'completed')
          events.emit('error', new Error(`${outcome.reason}: ${outcome.detail}`));
        else if (outcome.reason !== null) events.emit('error', new Error(outcome.reason));
      }
      events.emit('exit', exitCode, signalCode);
      events.emit('close', exitCode, signalCode);
    });
  });
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout: child.stdout,
    stderr: child.stderr,
    settled,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    // Stitchkit requests SIGKILL for abort; the launcher needs SIGTERM to await tree cleanup, and
    // gets a bounded grace before the SIGKILL that was asked for.
    kill(_signal: 'SIGKILL') {
      return cancel();
    },
    on: events.on.bind(events),
  };
}

/**
 * Remove request directories a crashed owner left behind. The request holds the declared
 * environment, chat credential included; the launcher removes nothing it did not create, and the
 * owner that would have removed it is gone. Own directories only, and only past any deadline.
 */
export function sweepFiniteWorkloadDirectories(maxAgeMs: number, nowMs = Date.now()): number {
  const root = tmpdir();
  const uid = process.getuid?.();
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(WORKLOAD_DIRECTORY_PREFIX)) continue;
    const path = join(root, name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory() || stat.uid !== uid || nowMs - stat.mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      /* gone or not ours to inspect */
    }
  }
  return removed;
}
