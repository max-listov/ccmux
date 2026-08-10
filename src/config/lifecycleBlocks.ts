import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { LifecycleBlockSchema } from "./schema.ts";
import type { LifecycleBlock, MachineConfig, Session } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";
import { lifecycleBlockPath } from "./paths.ts";
import { withSessionRegistryLock } from "./registryLock.ts";
import { loadPendingRows } from "./pendingStore.ts";
import { loadSessions } from "./sessions.ts";
import { recoverPromotionsUnlocked } from "./sessionRegistry.ts";

export function readLifecycleBlock(m: MachineConfig, name: string): LifecycleBlock | null {
  const path = lifecycleBlockPath(m, name);
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return LifecycleBlockSchema.parse(value);
}

export function readLifecycleBlockForSession(m: MachineConfig, session: Session): LifecycleBlock | null {
  const block = readLifecycleBlock(m, session.name);
  if (!block || block.agent !== session.agent) return null;
  if (session.registrationGeneration !== undefined) {
    return block.generation === session.registrationGeneration ? block : null;
  }
  return block.uuid === session.uuid ? block : null;
}

export async function writeLifecycleBlock(m: MachineConfig, block: LifecycleBlock): Promise<void> {
  const parsed = LifecycleBlockSchema.parse(block);
  await withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const ready = loadSessions(m).find((session) => session.name === parsed.name && session.agent === parsed.agent);
    const pending = loadPendingRows(m).find((item) => item.session.name === parsed.name && item.session.agent === parsed.agent);
    const matchesReady = ready !== undefined && (
      ready.registrationGeneration !== undefined
        ? parsed.generation === ready.registrationGeneration
        : parsed.uuid === ready.uuid
    );
    const matchesPending = pending !== undefined && parsed.generation === pending.generation;
    if (!matchesReady && !matchesPending) return;
    const path = lifecycleBlockPath(m, parsed.name);
    mkdirSync(dirname(path), { recursive: true });
    await atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  });
}

export async function clearLifecycleBlockIfGeneration(m: MachineConfig, name: string, generation: string): Promise<void> {
  await withSessionRegistryLock(m, async () => {
    const block = readLifecycleBlock(m, name);
    if (block?.generation !== generation) return;
    const path = lifecycleBlockPath(m, name);
    if (existsSync(path)) unlinkSync(path);
  });
}

/** Explicit user start/restart is the recovery action; daemon heal never clears a terminal block. */
export function clearLifecycleBlock(m: MachineConfig, name: string): void {
  const path = lifecycleBlockPath(m, name);
  if (existsSync(path)) unlinkSync(path);
}
