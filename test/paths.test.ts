import { test, expect } from "bun:test";
import { dirname } from "node:path";
import {
  STATE_DIR,
  CACHE_DIR,
  APP_BUNDLE,
  STAGED_BUNDLE,
  RELEASES_DIR,
  STATUS_DIR,
  LOG_FILE,
  BOOT_ATTEMPTS,
  sessionsPath,
  chatLedgerPath,
  chatCursorsPath,
  chatAckPath,
  outboxPath,
  outboxAckPath,
} from "../src/config/paths.ts";
import { makeMachine } from "./helpers.ts";

// The layout exists to answer one question by itself — "can I delete this?" — so these tests assert
// the PROPERTY (durable vs disposable, one directory, derived not configured) rather than spelling
// out strings a rename would have to chase.

const stateFiles = [sessionsPath, chatLedgerPath, chatCursorsPath, chatAckPath, outboxPath, outboxAckPath];

test("everything durable sits in ONE directory, taken from the config", () => {
  // The defect this replaces: the directory came from a config field holding a FILE path, and five
  // other files were derived from that file's parent — so one careless value silently relocated the
  // whole set into an unrelated folder.
  const m = makeMachine({ stateDir: "/tmp/ccmux-layout" });
  for (const f of stateFiles) expect(dirname(f(m))).toBe("/tmp/ccmux-layout");
});

test("each durable file is named, and no two share a name", () => {
  const m = makeMachine({ stateDir: "/tmp/ccmux-layout" });
  const names = stateFiles.map((f) => f(m));
  expect(new Set(names).size).toBe(names.length);
  // Named with a real extension: the registry used to be the one file without one, which is exactly
  // why it read as junk next to the others.
  for (const n of names) expect(n).toMatch(/\.(jsonl|json)$/);
});

test("two configs never share state — the property tests and isolated instances rely on", () => {
  const a = makeMachine({ stateDir: "/tmp/ccmux-a" });
  const b = makeMachine({ stateDir: "/tmp/ccmux-b" });
  for (const f of stateFiles) expect(f(a)).not.toBe(f(b));
});

test("disposable and durable never share a root", () => {
  // The whole point of the split. If a bundle ever lands under the state root, "delete the cache to
  // reclaim space" starts eating the registry.
  expect(STATE_DIR).not.toBe(CACHE_DIR);
  for (const p of [APP_BUNDLE, STAGED_BUNDLE, RELEASES_DIR]) expect(p.startsWith(`${CACHE_DIR}/`)).toBe(true);
  for (const p of [STATUS_DIR, LOG_FILE, BOOT_ATTEMPTS]) expect(p.startsWith(`${STATE_DIR}/`)).toBe(true);
});

test("both roots are absolute and end in the tool's own directory", () => {
  // Derived, not configured — a fresh machine must land correctly with nothing written by hand,
  // which is what stops the layout from drifting per machine the way the old one did.
  for (const root of [STATE_DIR, CACHE_DIR]) {
    expect(root.startsWith("/")).toBe(true);
    expect(root.endsWith("/ccmux")).toBe(true);
  }
});

test("nothing lands directly in the home directory", () => {
  // The visible symptom that started this: bare dotfiles scattered next to a user's own folders,
  // indistinguishable from junk — including the one file whose loss orphans every session.
  const m = makeMachine({ stateDir: STATE_DIR });
  const home = process.env.HOME ?? "";
  for (const p of [...stateFiles.map((f) => f(m)), APP_BUNDLE, LOG_FILE]) {
    expect(dirname(p)).not.toBe(home);
  }
});
