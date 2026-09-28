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
};

function execStart(ctx: BootContext): string {
  return [...ctx.selfArgv, 'daemon'].join(' ');
}

export function renderSystemdUnit(ctx: BootContext): string {
  return `[Unit]
Description=ccmux — persistent self-healing Claude Code tmux fleet
After=network-online.target
Wants=network-online.target
# systemd never gives up on the supervisor. A tripped start limit is terminal: the unit stays
# failed and every session is unsupervised until a person happens to look. And the budget is not
# this unit's alone — every start request counts, including those a unit that Requires= this one
# makes each time it restarts, so a neighbour's crash loop spends it. After a crash reboot the
# daemon failed ten times on a lock the crash had left, a dependent adapter looping beside it spent
# the other ten starts of a budget of twenty, and systemd stopped restarting the daemon for good.
# A crash loop of the bundle itself is the boot guard's to cure (it reverts an
# unproven bundle); anything else clears by retrying, which RestartSec paces. launchd's KeepAlive
# never gives up either: both platforms keep the same promise.
StartLimitIntervalSec=0

[Service]
Type=simple
User=${ctx.user}
Environment=HOME=${ctx.home}
Environment=CCMUX_CONFIG=${ctx.configPath}
Environment=PATH=${ctx.pathEnv}
ExecStart=${execStart(ctx)}
# Restart=always, not on-failure: 143 is declared a success below, and on-failure would then
# leave the daemon down after its own update bounce — the one restart it asks for by name.
Restart=always
RestartSec=15
# 143 is the daemon shutting down when asked: its own post-update bounce, or a systemctl restart.
# Without this every ordinary restart is journalled as "Failed with result 'exit-code'", so the unit
# reports a failure each time it does exactly what it was built to do, and the one line an operator
# reads first is trained to mean nothing.
SuccessExitStatus=143
# the daemon is a supervisor — its tmux sessions OUTLIVE it. KillMode=process kills ONLY the
# daemon pid on stop/restart; without it systemd default (control-group) SIGTERMs the whole
# cgroup — including every spawned tmux session — so systemctl restart / ccmux update would
# drop all live conversations. This is the core "sessions survive the bounce" guarantee.
KillMode=process
# The same guarantee, against the other way systemd can take the fleet down with the daemon. Every
# session this supervisor starts — the tmux server, each agent, and whatever those agents spawn —
# lives in this unit's cgroup, and the default OOMPolicy is "stop": one process in that cgroup
# killed by the kernel's OOM killer stops the whole unit. That is not a theory. A headless browser
# a session had opened was picked by a host-wide OOM kill, and systemd stopped the supervisor over
# it — "Failed with result 'oom-kill'", every session orphaned, and the shutdown that followed was
# abrupt enough that the run never recorded its own stop. "continue" keeps the supervisor up so it
# can do the one thing it exists for — notice what died and heal it.
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
`;
}

export function renderLaunchdPlist(ctx: BootContext): string {
  const args = [...ctx.selfArgv, 'daemon'].map((a) => `    <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ctx.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${ctx.home}</string>
    <key>CCMUX_CONFIG</key><string>${ctx.configPath}</string>
    <key>PATH</key><string>${ctx.pathEnv}</string>
  </dict>
  <key>StandardOutPath</key><string>${ctx.logDir}/${ctx.label}.log</string>
  <key>StandardErrorPath</key><string>${ctx.logDir}/${ctx.label}.err</string>
</dict>
</plist>
`;
}
