import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import { lastModel, parse, usedTokens } from "../agent/codex/transcript.ts";
import { loadSessions } from "../config/sessions.ts";
import type { ExternalSession, MachineConfig, WriterRuntime } from "../types.ts";
import { MtimeCache } from "../util/mtimeCache.ts";
import { readFirstLine, readTailUntil } from "../util/readLines.ts";
import { externalCapabilities } from "./capabilities.ts";
import { inspectCodexThreadLocks, type CodexLockInspection } from "./codexLocks.ts";
import { externalSessionKey } from "./keys.ts";
import { processAncestors, processSnapshot, type ProcessSnapshot } from "./processes.ts";

const CodexSessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  timestamp: z.string().optional(),
  payload: z.object({
    id: z.uuid(),
    cwd: z.string().startsWith("/").optional(),
    originator: z.string().optional(),
    source: z.unknown().optional(),
    thread_source: z.unknown().optional(),
  }),
});

type CodexMeta = z.infer<typeof CodexSessionMetaSchema>;
type CodexStored = { meta: CodexMeta; path: string };

const TAIL_LINES = 2000;
const cache = new MtimeCache<Pick<ExternalSession, "lastActivityMs" | "lastModel" | "usedTokens" | "lastMessage">>();

function readMeta(path: string): CodexMeta | null {
  const first = readFirstLine(path);
  if (!first) return null;
  try {
    const parsed = CodexSessionMetaSchema.safeParse(JSON.parse(first));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function storedRollouts(m: MachineConfig): CodexStored[] {
  if (!m.codexSessionsDir || !existsSync(m.codexSessionsDir)) return [];
  const glob = new Glob("**/rollout-*.jsonl");
  const out: CodexStored[] = [];
  for (const path of glob.scanSync({ cwd: m.codexSessionsDir, absolute: true })) {
    const meta = readMeta(path);
    if (meta) out.push({ meta, path });
  }
  return out;
}

function sourceText(source: unknown): string {
  if (typeof source === "string") return source.toLowerCase();
  if (typeof source === "object" && source !== null && "subagent" in source) return "subagent";
  return "";
}

export function codexOrigin(meta: CodexMeta): ExternalSession["origin"] {
  const source = sourceText(meta.payload.source);
  const threadSource = sourceText(meta.payload.thread_source);
  const originator = meta.payload.originator?.toLowerCase() ?? "";
  if (source.includes("subagent") || threadSource.includes("subagent")) return "subagent";
  // `source` is the interaction surface; runtime ownership is reported independently from lsof
  // ancestry. A desktop-owned writer can therefore correctly have origin=vscode.
  if (source.includes("vscode")) return "vscode";
  if (source.includes("appserver") || source.includes("app_server") || source.includes("app-server")) return "app-server";
  if (source === "exec") return "exec";
  if (source.includes("cli")) return "cli";
  if (source.includes("desktop")) return "desktop";
  if (originator.includes("desktop")) return "desktop";
  if (originator.includes("vscode")) return "vscode";
  if (originator.includes("exec")) return "exec";
  if (originator.includes("cli")) return "cli";
  return "unknown";
}

export function isDedicatedCodexCommand(command: string, codexBin: string | undefined): boolean {
  if (codexBin === undefined) return false;
  const executable = command.trim().split(/\s+/, 1)[0];
  if (!executable) return false;
  if (executable === codexBin) return true;
  if (!isAbsolute(executable) || !isAbsolute(codexBin)) return false;
  try {
    return realpathSync(executable) === realpathSync(codexBin);
  } catch {
    return false;
  }
}

function runtimeFor(
  inspection: CodexLockInspection,
  rows: ProcessSnapshot[] | null,
  holderThreadCounts: Map<number, number>,
  currentPid: number,
  codexBin: string | undefined,
): WriterRuntime | null {
  if (inspection.evidence !== "observed") return null;
  if (inspection.holders.length !== 1 || rows === null) {
    return {
      kind: inspection.holders.length > 1 ? "shared" : "unknown",
      pid: null,
      startTime: null,
      processGroup: null,
      reason: inspection.holders.length > 1 ? "multiple processes hold the exact writer lock" : "process ancestry is unavailable",
    };
  }
  const holder = inspection.holders[0];
  if (!holder) return null;
  const row = rows.find((item) => item.pid === holder.pid);
  if (!row) {
    return { kind: "unknown", pid: holder.pid, startTime: null, processGroup: null, reason: "lock holder left the process snapshot" };
  }
  if ((holderThreadCounts.get(holder.pid) ?? 0) > 1) {
    return {
      kind: "shared",
      pid: row.pid,
      startTime: row.startTime,
      processGroup: row.processGroup,
      reason: "one shared runtime holds writer locks for multiple threads",
    };
  }
  const chain = processAncestors(rows, holder.pid);
  const commands = chain.map((item) => item.command.toLowerCase());
  const ownAncestors = new Set(processAncestors(rows, currentPid).map((item) => item.pid));
  let kind: WriterRuntime["kind"] = "unknown";
  let reason = "writer lock is held but runtime ancestry is not recognized";
  if (ownAncestors.has(holder.pid)) {
    kind = "self";
    reason = "writer is an ancestor of this ccmux process";
  } else if (commands.some((command) => /(?:^|\s)_(?:run|bootstrap)\s/.test(command))) {
    kind = "managed";
    reason = "writer descends from a ccmux supervisor";
  } else if (commands.some((command) => command.includes("chatgpt.app/") || command.includes("codex.app/"))) {
    kind = "desktop";
    reason = "writer descends from a desktop application";
  } else if (commands.some((command) => command.includes("visual studio code.app/") || command.includes("cursor.app/") || command.includes("extensionhost"))) {
    kind = "vscode";
    reason = "writer descends from an editor host";
  } else if (commands.some((command) => command.includes("app-server"))) {
    kind = "app-server";
    reason = "writer belongs to an app-server process tree";
  } else if (isDedicatedCodexCommand(row.command, codexBin)) {
    kind = "dedicated-cli";
    reason = "one dedicated Codex process holds the exact writer lock";
  }
  return { kind, pid: row.pid, startTime: row.startTime, processGroup: row.processGroup, reason };
}

function activity(path: string): Pick<ExternalSession, "lastActivityMs" | "lastModel" | "usedTokens" | "lastMessage"> {
  return cache.get(path, () => {
    // Bounded in bytes, not just lines: rollouts carry records large enough that a 2000-line
    // window once meant reading gigabytes to display a model name.
    const tail = readTailUntil(path, TAIL_LINES, (lines) => lastModel(lines) !== null && usedTokens(lines) !== null);
    const messages = parse(tail.slice(-120), 1, 280);
    const lastMessage = messages.at(-1) ?? null;
    const parsedTime = lastMessage?.createdAt ? Date.parse(lastMessage.createdAt) : NaN;
    let lastActivityMs = Number.isFinite(parsedTime) ? parsedTime : null;
    if (lastActivityMs === null) {
      try { lastActivityMs = statSync(path).mtimeMs; } catch { lastActivityMs = null; }
    }
    return { lastActivityMs, lastModel: lastModel(tail), usedTokens: usedTokens(tail), lastMessage };
  }) ?? { lastActivityMs: null, lastModel: null, usedTokens: null, lastMessage: null };
}

function lockOnlyIds(m: MachineConfig): string[] {
  if (!m.codexHome) return [];
  try {
    return readdirSync(`${m.codexHome}/thread-writer-locks`)
      .filter((name) => name.endsWith(".lock"))
      .map((name) => name.slice(0, -5))
      .filter((id) => z.uuid().safeParse(id).success);
  } catch {
    return [];
  }
}

export function discoverCodex(m: MachineConfig): ExternalSession[] {
  const managed = new Set(loadSessions(m).filter((session) => session.agent === "codex").map((session) => session.uuid));
  const stored = storedRollouts(m).filter((item) => !managed.has(item.meta.payload.id));
  const ids = new Set([...stored.map((item) => item.meta.payload.id), ...lockOnlyIds(m)].filter((id) => !managed.has(id)));
  const inspections = inspectCodexThreadLocks(m, [...ids]);
  const rows = processSnapshot();
  const holderThreadCounts = new Map<number, number>();
  for (const inspection of inspections.values()) {
    for (const pid of new Set(inspection.holders.map((holder) => holder.pid))) {
      holderThreadCounts.set(pid, (holderThreadCounts.get(pid) ?? 0) + 1);
    }
  }
  const byId = new Map(stored.map((item) => [item.meta.payload.id, item]));
  const out: ExternalSession[] = [];
  for (const threadId of ids) {
    const storedItem = byId.get(threadId);
    const inspection = inspections.get(threadId);
    if (!inspection) continue;
    // A pre-turn lock file is inventory only while a real process holds it. Stale lock files vanish.
    if (!storedItem && inspection.evidence !== "observed") continue;
    const writerRuntime = runtimeFor(inspection, rows, holderThreadCounts, process.pid, m.codexBin);
    // A correlated pending bootstrap is already ccmux-owned even before registry promotion.
    if (writerRuntime?.kind === "managed") continue;
    const storage = storedItem ? "stored" : "missing";
    const data = storedItem ? activity(storedItem.path) : { lastActivityMs: null, lastModel: null, usedTokens: null, lastMessage: null };
    out.push({
      key: externalSessionKey("codex", m.rcPrefix, threadId),
      plane: "external",
      provider: "codex",
      host: m.rcPrefix,
      threadId,
      dir: storedItem?.meta.payload.cwd ?? null,
      path: storedItem?.path ?? null,
      origin: storedItem ? codexOrigin(storedItem.meta) : "unknown",
      storage,
      writerEvidence: inspection.evidence,
      writerRuntime,
      capabilities: externalCapabilities(storage, inspection.evidence, writerRuntime),
      ...data,
    });
  }
  return out;
}
