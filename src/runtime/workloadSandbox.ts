import type { AgentProcessSandbox } from 'stitchkit/agent-runtime';
import { spawnFiniteWorkload } from './finiteWorkload.ts';
import { type FiniteWorkloads, WorkloadProtocolSchema } from './workloadContract.ts';

export function finiteWorkloadSandbox(config: FiniteWorkloads): AgentProcessSandbox {
  return {
    // Any failure to describe the launcher is "unavailable", never an exception: Stitchkit calls
    // probe() before it is inside a promise, so a throw here escapes as a raw error with a path in it.
    probe: async () => {
      if (process.platform !== 'linux')
        return { grade: 'unavailable', reason: 'run-workload-platform-unsupported' };
      try {
        const child = Bun.spawn([config.launcherBin, '--describe'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          timeout: 5000,
        });
        const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        if (code === 0 && WorkloadProtocolSchema.safeParse(JSON.parse(output)).success)
          return {
            grade: 'partial',
            restrictions: ['process-contained'],
            gaps: ['network-denied', 'secrets-hidden', 'write-contained'],
          };
      } catch {
        /* missing launcher, unreadable or non-JSON description: unavailable below */
      }
      return { grade: 'unavailable', reason: 'workload-launcher-protocol-unavailable' };
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
