import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renewRefusal, renewSummary } from "../src/commands/renew.ts";
import { clearLifecycleBlock } from "../src/config/lifecycleBlocks.ts";
import { lifecycleBlockPath } from "../src/config/paths.ts";
import { makeMachine, makeSession, UUID } from "./helpers.ts";

test("renewing refuses while the conversation is still there, and says what it would drop", () => {
  const refusal = renewRefusal("agent-a", "/root/.claude/projects/p/x.jsonl", true, false);
  expect(refusal).not.toBeNull();
  expect(refusal).toContain("/root/.claude/projects/p/x.jsonl");
  // It must offer the non-destructive alternative, not just say no.
  expect(refusal).toMatch(/ccmux restart agent-a/);
  expect(refusal).toMatch(/--force/);
});

test("a conversation that is gone needs no confirmation — there is nothing to abandon", () => {
  expect(renewRefusal("agent-a", "/gone/x.jsonl", false, false)).toBeNull();
});

test("abandoning a live conversation is possible, but only when asked for explicitly", () => {
  expect(renewRefusal("agent-a", "/root/x.jsonl", true, true)).toBeNull();
});

test("the summary names what survived, because keeping it is the whole point", () => {
  const s = makeSession({
    name: "agent-a",
    dir: "/home/u/proj",
    permissionMode: "bypassPermissions",
    chatEnabled: true,
    promptModules: ["fleet"],
  });
  const text = renewSummary(s, "new-uuid");
  expect(text).toContain("new-uuid");
  expect(text).toContain("/home/u/proj");
  expect(text).toContain("bypassPermissions");
  expect(text).toContain("chat override on");
  expect(text).toContain("fleet");
});

test("a settings-free session reports only what it actually has", () => {
  const text = renewSummary(makeSession({ name: "agent-b", dir: "/home/u/plain" }), "u2");
  expect(text).toContain("/home/u/plain");
  expect(text).not.toMatch(/mode |chat |modules /);
});

test("clearing a block removes the file it is stored in", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-block-"));
  const m = makeMachine({ stateDir: dir });
  const path = lifecycleBlockPath(m, "agent-a");
  mkdirSync(join(dir, "lifecycle-blocks"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ name: "agent-a", agent: "claude", uuid: UUID, error: "conversation missing", at: new Date().toISOString() }),
  );

  clearLifecycleBlock(m, "agent-a");
  expect(existsSync(path)).toBe(false);
  // Clearing what is not there is not an error: rm runs this unconditionally.
  clearLifecycleBlock(m, "agent-a");
  rmSync(dir, { recursive: true, force: true });
});

test("unregistering a session takes its block with it", async () => {
  // A verdict describes a session. Once the session is gone it describes nobody, so leaving the
  // file behind hands a later session of the same name a judgement passed on someone else — safe
  // today only because neither generation nor uuid could match, which is luck, not design.
  const src = await Bun.file(new URL("../src/commands/rm.ts", import.meta.url)).text();
  expect(src).toMatch(/clearLifecycleBlock\(m, name\)/);
});
