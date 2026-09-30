import { runClaudeNativeProcess } from '../src/agent/claude/native/process.ts';
import { runOwnedCodexProcess } from '../src/agent/codex/owned/process.ts';
import { loadMachineConfig } from '../src/config/machine.ts';
import { SessionSchema } from '../src/session/schema.ts';

const m = loadMachineConfig(),
  s = SessionSchema.parse(JSON.parse(Bun.argv[3] ?? ''));
let before = process.cpuUsage(),
  start = performance.now(),
  measured = false;
const begin = setTimeout(() => {
  before = process.cpuUsage();
  start = performance.now();
  measured = true;
}, 5000);
const end = setTimeout(
  () => {
    const cpu = process.cpuUsage(before),
      elapsedMs = performance.now() - start;
    console.log(
      JSON.stringify({
        elapsedMs,
        cpu,
        corePercent: (cpu.user + cpu.system) / elapsedMs / 10,
        measured,
      }),
    );
    process.kill(process.pid, 'SIGTERM');
  },
  5000 + Number(Bun.argv[2]) * 1000,
);
try {
  await (s.agent === 'codex' ? runOwnedCodexProcess(m, s) : runClaudeNativeProcess(m, s));
} finally {
  clearTimeout(begin);
  clearTimeout(end);
}
