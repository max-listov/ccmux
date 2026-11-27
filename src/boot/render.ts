import * as serviceHost from 'stitchkit/service-host';

// Pure boot-unit template builders — no I/O, fully unit-testable. Both render the
// SAME `<self> daemon` invocation; `selfArgv` comes from process.execPath (P1-6:
// never a hardcoded bun path), so compiled-binary and dev/bundle installs both work.

export type BootContext = {
  selfArgv: readonly string[]; // e.g. ["/usr/local/bin/ccmux"] or ["/root/.bun/bin/bun","/opt/ccmux/ccmux.js"]
  label: string; // systemd: "ccmux.service"; launchd: "com.ccmux.daemon"
  user: string;
  home: string;
  configPath: string;
  pathEnv: string;
  logDir: string; // launchd stdout/stderr files live here
  /** macOS signed app-bundle launcher (`~/Applications/ccmux.app/Contents/MacOS/ccmux-launcher`).
   *  Prepended ONLY inside `renderLaunchdPlist`, never in `bootArgv()` or the PATH shim. */
  macosLauncher?: string;
};

export type TmuxBootContext = {
  label: string; // launchd: "com.ccmux.tmux"
  tmuxBin: string;
  tmuxSocket?: string;
  home: string;
  configPath: string;
  pathEnv: string;
  logDir: string;
  macosLauncher: string;
};

export function renderSystemdUnit(ctx: BootContext): string {
  // Supervisor guarantees:
  // - `startLimitIntervalSec: 0` + `restart: 'always'` + `restartSec: 15`: systemd never gives up on
  //   the supervisor (a tripped start limit is terminal, and dependent units share the budget).
  // - `successExitStatus: [143]`: post-update bounce / `systemctl restart` exits 143 cleanly without
  //   marking the unit failed; paired with `restart: 'always'` so the bounce still restarts it.
  // - `killMode: 'process'` + `oomPolicy: 'continue'`: live tmux sessions and spawned agents outlive
  //   daemon restarts and survive an OOM kill of a child process in the unit's cgroup.
  return serviceHost.renderSystemdServiceUnit({
    description: 'ccmux — persistent self-healing Claude Code tmux fleet',
    scope: 'system',
    after: ['network-online.target'],
    wants: ['network-online.target'],
    startLimitIntervalSec: 0,
    type: 'simple',
    user: ctx.user,
    environment: {
      HOME: ctx.home,
      CCMUX_CONFIG: ctx.configPath,
      PATH: ctx.pathEnv,
    },
    execStart: [...ctx.selfArgv, 'daemon'],
    restart: 'always',
    restartSec: 15,
    successExitStatus: [143],
    killMode: 'process',
    oomPolicy: 'continue',
    wantedBy: ['multi-user.target'],
  });
}

function launchAgent(
  ctx: BootContext | TmuxBootContext,
  programArguments: string[],
  tmux: boolean,
): string {
  return serviceHost.renderLaunchdPlist({
    label: ctx.label,
    programArguments,
    environmentVariables: { HOME: ctx.home, CCMUX_CONFIG: ctx.configPath, PATH: ctx.pathEnv },
    standardOutPath: `${ctx.logDir}/${ctx.label}.log`,
    standardErrorPath: `${ctx.logDir}/${ctx.label}.err`,
    processType: 'Background',
    runAtLoad: true,
    keepAlive: tmux ? true : { successfulExit: false },
    ...(tmux ? { throttleInterval: 10 } : {}),
  });
}

export function renderLaunchdPlist(ctx: BootContext): string {
  return launchAgent(
    ctx,
    [...(ctx.macosLauncher ? [ctx.macosLauncher] : []), ...ctx.selfArgv, 'daemon'],
    false,
  );
}

/** Tmux has its own job and survives a restart of the daemon. */
export function renderLaunchdTmuxPlist(ctx: TmuxBootContext): string {
  return launchAgent(
    ctx,
    [ctx.macosLauncher, ctx.tmuxBin, '-u', ...(ctx.tmuxSocket ? ['-L', ctx.tmuxSocket] : []), '-D'],
    true,
  );
}
