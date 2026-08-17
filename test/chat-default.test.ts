import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chatEnabledFor, chatOverrideLabel } from "../src/config/chat.ts";
import { computeStamp, staleReasons } from "../src/agent/launchStamp.ts";
import { makeMachine, makeSession } from "./helpers.ts";

// Chat used to live only on the session, always born off. On a fleet that means every new session
// must be remembered, and a forgotten one is discovered when a peer does not answer. The machine
// level makes the deliberate act happen once per box — the default itself stays OFF, because chat
// traffic is still never implicit.

test("a session with no override inherits the machine", () => {
  expect(chatEnabledFor(makeSession(), makeMachine({ chatEnabled: true }))).toBe(true);
  expect(chatEnabledFor(makeSession(), makeMachine({ chatEnabled: false }))).toBe(false);
});

test("an override wins in BOTH directions — silence on a chatty box, and the reverse", () => {
  // Both matter: a client-facing session staying silent where the machine talks, and one session
  // talking on a machine that otherwise does not.
  expect(chatEnabledFor(makeSession({ chatEnabled: false }), makeMachine({ chatEnabled: true }))).toBe(false);
  expect(chatEnabledFor(makeSession({ chatEnabled: true }), makeMachine({ chatEnabled: false }))).toBe(true);
});

test("the default is still OFF at both levels", () => {
  // The point was never to make chat implicit — only to stop repeating the decision per session.
  expect(chatEnabledFor(makeSession(), makeMachine())).toBe(false);
});

test("changing the MACHINE default marks sessions for restart", () => {
  // The trap this avoids: the stamp hashing the session's raw field. Then flipping the machine
  // default would flag nothing, and the column would stay silent exactly where a restart is needed —
  // while chat framing and the Stop hook are launch-time and would not be live.
  const s = makeSession();
  const before = { ...computeStamp(s, makeMachine({ chatEnabled: false }), "ccmux"), ts: 0 };
  expect(staleReasons(before, computeStamp(s, makeMachine({ chatEnabled: true }), "ccmux"))).toContain("chat");
});

test("a session that overrides is NOT disturbed by the machine flipping", () => {
  const s = makeSession({ chatEnabled: false });
  const before = { ...computeStamp(s, makeMachine({ chatEnabled: false }), "ccmux"), ts: 0 };
  expect(staleReasons(before, computeStamp(s, makeMachine({ chatEnabled: true }), "ccmux"))).not.toContain("chat");
});

test("nothing reads the raw field behind the resolver's back", () => {
  // The whole reason the resolver exists. Eleven call sites fold these two levels; if any one of them
  // does it inline, half the system believes chat is on while the other half does not — and that is
  // a bug you find in production, from a message that silently never arrives.
  const root = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (p.endsWith(join("config", "chat.ts")) || p.endsWith(join("config", "schema.ts")) || p.endsWith(join("config", "sessions.ts"))) continue;
        for (const line of readFileSync(p, "utf8").split("\n")) {
          // `stamp.`/`now.`/`opts.` are already-resolved values, not Session rows.
          if (/\b(s|me|session|recipient)\.chatEnabled\b/.test(line)) offenders.push(`${p}: ${line.trim()}`);
        }
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});

test("what a session CARRIES is reported separately from what it will DO", () => {
  // Reporting the resolved value as the session's own would tell someone their session is
  // configured when it is only inheriting the machine's answer.
  expect(chatOverrideLabel(makeSession({ chatEnabled: true }))).toBe("chat override on");
  expect(chatOverrideLabel(makeSession({ chatEnabled: false }))).toBe("chat override off");
  expect(chatOverrideLabel(makeSession())).toBeNull();
  // ...while the resolver still answers the behaviour question for that same inheriting session.
  expect(chatEnabledFor(makeSession(), makeMachine({ chatEnabled: true }))).toBe(true);
});
