import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRegistryLockPath } from "../src/config/paths.ts";
import { withSessionRegistryLock } from "../src/config/registryLock.ts";
import { makeMachine } from "./helpers.ts";

test("registry lock reaps only a stale dead owner and remains reusable", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ccmux-registry-lock-"));
  const machine = makeMachine({ stateDir });
  const lock = sessionRegistryLockPath(machine);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
    pid: 2_147_483_647,
    token: "11111111-1111-4111-8111-111111111111",
  })}\n`);
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lock, stale, stale);

  try {
    await expect(withSessionRegistryLock(machine, async () => "recovered")).resolves.toBe("recovered");
    await expect(withSessionRegistryLock(machine, async () => "reused")).resolves.toBe("reused");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
