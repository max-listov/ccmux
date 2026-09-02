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
# A backstop against a genuine crash-loop, sized so that NOTHING the daemon does on purpose can
# trip it. The daemon restarts itself after applying an update, and a tripped start limit is
# terminal: systemd stops trying, leaves the unit failed, and the supervisor stays dead until a
# person happens to look. Two machines spent two hours that way when an update bounce landed
# alongside an unrelated systemd re-exec and the six starts that followed exhausted a budget of
# five per minute.
#
# A deliberate bounce happens at most once per update check (five minutes apart), so two per window
# is the ceiling. A real crash-loop exits at once and needs twenty restarts to trip — five minutes
# at this delay, comfortably inside the window. The macOS side never gives up at all; the daemon
# being permanently killable on one platform and not the other was the asymmetry, not the policy.
StartLimitIntervalSec=600
StartLimitBurst=20

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
