import type { AgentProcessSandbox } from 'stitchkit/agent-runtime';
import { z } from 'zod';
import { spawnFiniteWorkload } from './finiteWorkload.ts';
import type { FiniteWorkloads } from './workloadContract.ts';

export function finiteWorkloadSandbox(config: FiniteWorkloads): AgentProcessSandbox {
  return {
    probe: () => {
      if (process.platform !== 'linux')
        return { grade: 'unavailable', reason: 'run-workload-platform-unsupported' };
      const result = Bun.spawnSync([config.launcherBin, '--describe'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
      });
      const protocol = z.looseObject({
        schema: z.literal('node-workload-protocol/v1'),
        command: z.literal('node-workload-run'),
        platform: z.literal('linux'),
        mode: z.literal('disposable'),
        supervisor: z.literal('direct-parent-process-instance'),
      });
      if (
        result.exitCode !== 0 ||
        !protocol.safeParse(JSON.parse(result.stdout.toString())).success
      )
        return { grade: 'unavailable', reason: 'workload-launcher-protocol-unavailable' };
      return {
        grade: 'partial',
        restrictions: ['process-contained'],
        gaps: ['network-denied', 'secrets-hidden', 'write-contained'],
      };
    },
    prepare: (input) => ({
      executable: input.executable,
      args: [...input.args],
      environment: input.environment,
    }),
    spawn: (input) =>
      spawnFiniteWorkload(config, {
        ...input,
        label: 'custom finite command',
        environment: input.environment,
        timeoutMs: 30_000,
        maxOutputBytes: 32 * 1024,
        maxStdinBytes: 1,
      }),
  };
}
