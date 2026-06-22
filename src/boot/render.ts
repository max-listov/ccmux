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
  return [...ctx.selfArgv, "daemon"].join(" ");
}

export function renderSystemdUnit(ctx: BootContext): string {
  return `[Unit]
Description=ccmux — persistent self-healing Claude Code tmux fleet
After=network-online.target
Wants=network-online.target
# backstop against a genuine crash-loop (config self-test already exits 0 on bad config)
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${ctx.user}
Environment=HOME=${ctx.home}
Environment=CCMUX_CONFIG=${ctx.configPath}
Environment=PATH=${ctx.pathEnv}
ExecStart=${execStart(ctx)}
Restart=on-failure
RestartSec=3
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
  const args = [...ctx.selfArgv, "daemon"].map((a) => `    <string>${a}</string>`).join("\n");
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
