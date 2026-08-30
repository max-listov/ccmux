import { bindProcessSignals } from 'stitchkit/server';
import { loadMachineConfig } from '../config/machine.ts';
import { convergeBundleLocation } from '../config/migrateBundle.ts';
import { APP_BUNDLE, BOOT_ATTEMPTS } from '../config/paths.ts';
import { createDaemonApplication } from '../daemon/application.ts';
import { IS_DEV } from '../env.ts';
import { bootGuardStart } from '../util/bootGuard.ts';
import { log, setLogLevel } from '../util/log.ts';

/** One managed daemon lifetime; tmux/provider processes deliberately outlive it. */
export async function cmdDaemon(): Promise<number> {
  if (!IS_DEV && bootGuardStart(BOOT_ATTEMPTS, APP_BUNDLE) === 'revert') return 1;
  let m: ReturnType<typeof loadMachineConfig>;
  try {
    m = loadMachineConfig();
    setLogLevel(m.logLevel);
    if (!IS_DEV) await convergeBundleLocation(m);
  } catch (error) {
    log.error({ msg: 'machine config invalid; daemon not starting', err: String(error) });
    return 0;
  }
  const { application } = createDaemonApplication(m);
  let code = 143;
  const signals = bindProcessSignals(application, {
    onShutdown: (sig) => {
      code = signalExitCode(sig);
      log.info({ msg: 'daemon stopping', sig, code });
    },
    onError: (phase, error) =>
      log.error({ msg: 'daemon shutdown failed', phase, err: String(error) }),
    onEscalationBlocked: (sig) => process.exit(signalExitCode(sig)),
  });
  try {
    const state = await application.start();
    log.info({
      msg: 'ccmux daemon up',
      rcPrefix: m.rcPrefix,
      interval: m.ensureInterval,
      lifecycle: state.lifecycle,
    });
    const result = await signals.promise;
    log.info({ msg: 'daemon stopped', result });
    // A forced drain may leave a non-cooperative operation. End only this daemon;
    // otherwise the boot unit could never start its replacement.
    if (result?.outcome === 'forced') process.exit(code);
    return code;
  } catch (error) {
    log.error({ msg: 'daemon lifecycle failed', err: String(error) });
    await application.shutdown();
    return 1;
  } finally {
    signals.close();
  }
}

/** Nonzero death-by-signal lets the boot unit restore the daemon after a stray signal. */
export function signalExitCode(sig: NodeJS.Signals): number {
  return sig === 'SIGINT' ? 130 : 143;
}
