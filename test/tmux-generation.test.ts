import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasSession, killSessionIfGeneration, newSession, tmuxArgv } from "../src/tmux/tmux.ts";
import { makeMachine } from "./helpers.ts";

test("bootstrap rollback kills only the tmux session carrying its exact generation", async () => {
  const tmuxBin = Bun.which("tmux");
  if (!tmuxBin) throw new Error("tmux is required for generation-scoped rollback");
  const dir = mkdtempSync(join(tmpdir(), "ccmux-tmux-generation-"));
  const tmuxSocket = `ccmux-generation-${process.pid}`;
  const machine = makeMachine({ stateDir: dir, tmuxBin, tmuxSocket });
  const generation = "11111111-1111-4111-8111-111111111111";

  try {
    await newSession(machine, "agent-a", dir, ["sleep", "30"], { CCMUX_BOOTSTRAP_GENERATION: generation });
    expect(await killSessionIfGeneration(machine, "agent-a", "22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(await hasSession(machine, "agent-a")).toBe(true);
    expect(await killSessionIfGeneration(machine, "agent-a", generation)).toBe(true);
    expect(await hasSession(machine, "agent-a")).toBe(false);
  } finally {
    Bun.spawnSync(tmuxArgv(machine, "kill-server"), { stdout: "ignore", stderr: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});
