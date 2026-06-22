import { test, expect } from "bun:test";
import { renderSystemdUnit, renderLaunchdPlist, type BootContext } from "../src/boot/render.ts";

const ctx: BootContext = {
  selfArgv: ["/usr/local/bin/ccmux"],
  label: "ccmux.service",
  user: "root",
  home: "/root",
  configPath: "/root/.config/ccmux/machine.json",
  pathEnv: "/root/.bun/bin:/usr/bin:/bin",
  logDir: "/var/log",
};

test("systemd unit: supervisor model, correct ExecStart, no ExecStop / no dangerous flag", () => {
  const u = renderSystemdUnit(ctx);
  expect(u).toContain("ExecStart=/usr/local/bin/ccmux daemon");
  expect(u).toContain("Type=simple");
  expect(u).toContain("Restart=on-failure");
  expect(u).toContain("User=root");
  expect(u).toContain("Environment=HOME=/root");
  expect(u).not.toContain("ExecStop"); // sessions outlive the daemon
  expect(u).not.toContain("dangerously");
});

test("launchd plist: valid structure, KeepAlive SuccessfulExit false, daemon arg", () => {
  const mac: BootContext = {
    ...ctx,
    label: "com.ccmux.daemon",
    home: "/Users/user",
    logDir: "/Users/user/Library/Logs",
    selfArgv: ["/Users/user/.local/bin/ccmux"],
  };
  const p = renderLaunchdPlist(mac);
  expect(p.startsWith("<?xml")).toBe(true);
  expect(p).toContain("<string>com.ccmux.daemon</string>");
  expect(p).toContain("<string>/Users/user/.local/bin/ccmux</string>");
  expect(p).toContain("<string>daemon</string>");
  expect(p).toContain("<key>SuccessfulExit</key><false/>");
});

test("render is deterministic (install compares-then-writes relies on this)", () => {
  expect(renderSystemdUnit(ctx)).toBe(renderSystemdUnit(ctx));
  expect(renderLaunchdPlist(ctx)).toBe(renderLaunchdPlist(ctx));
});

test("bundle-mode selfArgv (bun + js) renders into ExecStart (P1-6: no hardcoded bun path)", () => {
  const bundle: BootContext = { ...ctx, selfArgv: ["/root/.bun/bin/bun", "/opt/ccmux/ccmux.js"] };
  expect(renderSystemdUnit(bundle)).toContain(
    "ExecStart=/root/.bun/bin/bun /opt/ccmux/ccmux.js daemon",
  );
});
