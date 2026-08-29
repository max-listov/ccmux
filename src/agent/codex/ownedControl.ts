import { constants, closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { MachineConfig } from "../../types.ts";
import { atomicWrite } from "../../util/atomic.ts";
import { privateRuntimeDirectory } from "./ownedPaths.ts";

export const NativeResponseCommandSchema = z.object({
  operationId: z.uuid(), generation: z.uuid(), requestId: z.string().min(1).max(256),
  fingerprint: z.string().length(64), kind: z.enum(["approval", "input"]),
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).nullable(),
  answers: z.record(z.string().min(1).max(256), z.array(z.string().max(4_096)).min(1).max(32)).nullable(),
}).strict();
export type NativeResponseCommand = z.infer<typeof NativeResponseCommandSchema>;
export const NativeResponseReceiptSchema = z.object({
  operationId: z.uuid(), requestId: z.string().min(1).max(256), fingerprint: z.string().length(64),
  outcome: z.enum(["submitted", "rejected"]), reason: z.string().max(512).nullable(),
}).strict();
export type NativeResponseReceipt = z.infer<typeof NativeResponseReceiptSchema>;

export function nativeResponseFingerprint(input: Pick<NativeResponseCommand, "generation" | "requestId" | "kind" | "decision" | "answers">): string {
  const answers = input.answers === null ? null : Object.fromEntries(Object.entries(input.answers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, values]) => [id, [...values]]));
  return createHash("sha256").update(JSON.stringify([
    input.generation, input.requestId, input.kind, input.decision, answers,
  ])).digest("hex");
}

const key = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 24);
const root = (m: Pick<MachineConfig, "stateDir">, name: string): string => join(m.stateDir, "codex-control", key(name));
export const nativeCommandPath = (m: Pick<MachineConfig, "stateDir">, name: string): string => join(root(m, name), "command.json");
export const nativeReceiptPath = (m: Pick<MachineConfig, "stateDir">, name: string): string => join(root(m, name), "receipt.json");

function boundedJson(path: string, maxBytes = 64 * 1024): unknown | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    return size > maxBytes ? null : JSON.parse(bytes.toString("utf8", 0, size));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readNativeCommand(m: Pick<MachineConfig, "stateDir">, name: string): NativeResponseCommand | null {
  return NativeResponseCommandSchema.safeParse(boundedJson(nativeCommandPath(m, name))).data ?? null;
}
export function readNativeReceipt(m: Pick<MachineConfig, "stateDir">, name: string): NativeResponseReceipt | null {
  return NativeResponseReceiptSchema.safeParse(boundedJson(nativeReceiptPath(m, name))).data ?? null;
}
export async function writeNativeCommand(m: Pick<MachineConfig, "stateDir">, name: string, command: NativeResponseCommand): Promise<void> {
  privateRuntimeDirectory(dirname(nativeCommandPath(m, name)));
  await atomicWrite(nativeCommandPath(m, name), JSON.stringify(NativeResponseCommandSchema.parse(command)), 0o600);
}
export async function writeNativeReceipt(m: Pick<MachineConfig, "stateDir">, name: string, receipt: NativeResponseReceipt): Promise<void> {
  privateRuntimeDirectory(dirname(nativeReceiptPath(m, name)));
  await atomicWrite(nativeReceiptPath(m, name), JSON.stringify(NativeResponseReceiptSchema.parse(receipt)), 0o600);
}
export function clearNativeCommand(m: Pick<MachineConfig, "stateDir">, name: string): void {
  try { unlinkSync(nativeCommandPath(m, name)); } catch { /* already consumed */ }
}
