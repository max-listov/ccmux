import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FiniteWorkloads, WorkloadOutcome } from './workloadContract.ts';
import { WorkloadOutcomeSchema } from './workloadContract.ts';

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
  const directory = mkdtempSync(join(tmpdir(), 'ccmux-finite-'));
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
      scratchRoot: directory,
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
        const expected =
          outcome.status === 'completed'
            ? (outcome.exitCode ?? 1)
            : outcome.status === 'refused'
              ? 125
              : 126;
        if (code !== expected || signal !== null) throw new Error('workload-result-exit-mismatch');
      } catch (error) {
        outcome = {
          schema: 'node-workload-result/v1',
          status: 'failed',
          reason: 'workload-outcome-unavailable',
          detail: launchError?.message ?? (error instanceof Error ? error.message : String(error)),
        };
      }
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
    // Stitchkit requests SIGKILL for abort; the launcher needs SIGTERM to await tree cleanup.
    kill(_signal: 'SIGKILL') {
      return child.kill('SIGTERM');
    },
    on: events.on.bind(events),
  };
}
