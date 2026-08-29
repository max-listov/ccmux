import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "stitchkit";
import { createManagedSession } from "../commands/create.ts";
import { archiveSessionExact, loadSessions } from "../config/sessions.ts";
import { loadPendingSessions } from "../config/pendingSessions.ts";
import { withDirectoryLock } from "../config/registryLock.ts";
import { managedPeer } from "../chat/identity.ts";
import { killSession } from "../tmux/tmux.ts";
import type { MachineConfig, Session } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";
import type { ControlCreateSchema } from "./schema.ts";
import { ManagedPeerSchema } from "../config/schema.ts";
import { privateRuntimeDirectory } from "../agent/codex/ownedPaths.ts";

type CreateInput = z.input<typeof ControlCreateSchema>;
const CreateRowSchema = z.object({
  requestId: z.uuid(), fingerprint: z.string().length(64), generation: z.uuid(),
  name: z.string(), workspace: z.string(), flags: z.array(z.string()),
  status: z.enum(["pending", "complete", "failed"]), threadId: z.uuid().nullable(),
  error: z.string().max(512).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
type CreateRow = z.infer<typeof CreateRowSchema>;
const StoreSchema = z.array(CreateRowSchema).max(256);

const storePath = (m: Pick<MachineConfig, "stateDir">) => join(m.stateDir, "control", "create-requests.json");
const storeLockPath = (m: Pick<MachineConfig, "stateDir">) => join(m.stateDir, "control", "create-requests.lock");
const requestLockPath = (m: Pick<MachineConfig, "stateDir">, requestId: string) =>
  join(m.stateDir, "control", `create-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}.lock`);
function load(m: MachineConfig): CreateRow[] {
  const path = storePath(m);
  if (!existsSync(path)) return [];
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 512 * 1024) {
      throw new Error("unsafe create receipt store");
    }
    return StoreSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch { throw new AppError("CORRUPT_STATE", "Create receipt store is unavailable", 503); }
}
async function save(m: MachineConfig, rows: CreateRow[]): Promise<void> {
  privateRuntimeDirectory(dirname(storePath(m)));
  await atomicWrite(storePath(m), JSON.stringify(StoreSchema.parse(rows)), 0o600);
}
const fingerprint = (input: { name: string; workspace: string; flags: string[] }) =>
  createHash("sha256").update(JSON.stringify([input.name, input.workspace, input.flags])).digest("hex");
function normalizeWorkspace(path: string): string {
  let resolved: string;
  try { resolved = realpathSync(path); } catch { throw new AppError("INVALID_WORKSPACE", "Workspace does not exist", 400); }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) throw new AppError("INVALID_WORKSPACE", "Workspace is not a directory", 400);
  return resolved;
}
function matchingSession(m: MachineConfig, row: CreateRow): Session | null {
  return loadSessions(m).find((session) => session.name === row.name && session.registrationGeneration === row.generation) ?? null;
}

export async function createControlSession(m: MachineConfig, input: CreateInput, signal: AbortSignal,
  create: typeof createManagedSession = createManagedSession) {
  const workspace = normalizeWorkspace(input.workspace);
  const canonical = { name: input.name, workspace, flags: input.flags ?? [] };
  const digest = fingerprint(canonical);
  privateRuntimeDirectory(dirname(storeLockPath(m)));
  return withDirectoryLock(requestLockPath(m, input.requestId), async () => {
    let row!: CreateRow;
    let duplicate = false;
    await withDirectoryLock(storeLockPath(m), async () => {
      const rows = load(m);
      const found = rows.find((item) => item.requestId === input.requestId);
      if (found) {
        if (found.fingerprint !== digest) throw new AppError("IDEMPOTENCY_CONFLICT", "Create request payload changed", 409);
        row = found;
        duplicate = true;
        return;
      }
      const now = new Date().toISOString();
      row = CreateRowSchema.parse({ requestId: input.requestId, fingerprint: digest, generation: crypto.randomUUID(),
        ...canonical, status: "pending", threadId: null, error: null, createdAt: now, updatedAt: now });
      await save(m, [...rows.slice(-255), row]);
    }, "control create receipt");
    signal.throwIfAborted();
    if (row.status === "failed") throw new AppError("CREATE_FAILED", row.error ?? "Create request failed", 409);
    let session = matchingSession(m, row);
    if (session === null) {
      const pending = loadPendingSessions(m).some((item) => item.generation === row.generation);
      if (!pending) {
        try {
          session = await create(m, { name: row.name, dir: row.workspace, agent: "codex", flags: row.flags,
            router: false, runtime: "app-server", registrationGeneration: row.generation, chatEnabled: true });
        } catch (error) {
          session = matchingSession(m, row);
          if (session === null) {
            const message = String(error).slice(0, 512);
            await withDirectoryLock(storeLockPath(m), async () => save(m, load(m).map((item) => item.requestId === row.requestId
              ? { ...item, status: "failed" as const, error: message, updatedAt: new Date().toISOString() } : item)), "control create receipt");
            throw new AppError("CREATE_FAILED", "Managed Codex create failed", 409);
          }
        }
      }
    }
    const deadline = Date.now() + m.codexCorrelationTimeoutMs + 1_000;
    while (session === null && Date.now() < deadline) {
      signal.throwIfAborted();
      await Bun.sleep(50);
      session = matchingSession(m, row);
    }
    if (session === null) throw new AppError("CREATE_PENDING", "Create is still reconciling; retry the same request", 503);
    await withDirectoryLock(storeLockPath(m), async () => save(m, load(m).map((item) => item.requestId === row.requestId
      ? { ...item, status: "complete" as const, threadId: session!.uuid, updatedAt: new Date().toISOString() } : item)), "control create receipt");
    return { requestId: row.requestId, target: managedPeer(m.rcPrefix, session), workspace: row.workspace, duplicate };
  }, "control create request");
}

export async function archiveControlSession(m: MachineConfig, target: z.infer<typeof ManagedPeerSchema>) {
  const result = await archiveSessionExact(m, target.session, target.threadId);
  if (result === "missing") throw new AppError("IDENTITY_MISMATCH", "Managed identity changed or disappeared", 409);
  const stopped = await killSession(m, target.session);
  return { target, archived: true as const, duplicate: result === "duplicate", stopped };
}
