import { appResolveFailureText, resolveAppOutcome } from '../chat/appResolve.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { printLine } from '../util/stdout.ts';

/** `ccmux _codex-app-resolve <thread>` — what another machine runs here to name an App thread. */
export async function cmdResolveCodexApp(args: string[]): Promise<number> {
  const outcome = await resolveAppOutcome(loadMachineConfig(), args[0] ?? '');
  await printLine(JSON.stringify(outcome));
  if (outcome.ok) return 0;
  console.error(`codex app resolve: ${appResolveFailureText(outcome.failure)}`);
  return 1;
}
