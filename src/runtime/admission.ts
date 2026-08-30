import { join } from "node:path";
import type { MachineConfig, Session } from "../types.ts";
import { withDirectoryLock } from "../config/registryLock.ts";
import { managedRuntimeRoot } from "./status.ts";
import { privateRuntimeDirectory } from "../agent/codex/ownedPaths.ts";

/** Shared by provider pickup and control mutations, not a transport-local mutex. */
export function withNativeAdmission<T>(m: MachineConfig, s: Session, run: () => Promise<T>): Promise<T> {
  const root = managedRuntimeRoot(m, s);
  privateRuntimeDirectory(root);
  return withDirectoryLock(join(root, "admission.lock"), run, "native admission");
}
