import { existsSync, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { lastModel, parse, usedTokens } from "../agent/claude/transcript.ts";
import { classifyWriters, externalResumingUuids, parsePs, type Writer } from "../agent/claude/writers.ts";
import { rec, str } from "../agent/normalize.ts";
import { loadSessions } from "../config/sessions.ts";
import type { ExternalSession, MachineConfig, WriterRuntime } from "../types.ts";
import { unknownTurnState } from "./turnSchema.ts";
import { MtimeCache } from "../util/mtimeCache.ts";
import { readHeadLines, readTailUntil } from "../util/readLines.ts";
import { externalCapabilities } from "./capabilities.ts";
import { externalSessionKey } from "./keys.ts";

const HEAD_BYTES = 64 * 1024;
const TAIL_LINES = 2000;
const cache = new MtimeCache<Pick<ExternalSession, "dir" | "lastActivityMs" | "lastModel" | "usedTokens" | "lastMessage"> | null>();

function processData(): { targets: Set<string>; output: string } | null {
  try {
    const result = Bun.spawnSync(["ps", "-ax", "-o", "pid=,ppid=,command="], { stderr: "ignore" });
    if (!result.success) return null;
    const output = result.stdout.toString();
    return { targets: externalResumingUuids(parsePs(output)), output };
  } catch {
    return null;
  }
}

function firstCwd(lines: string[]): string | null {
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const cwd = str(rec(JSON.parse(raw))?.cwd);
      if (cwd?.startsWith("/")) return cwd;
    } catch {
      // A bounded head slice can end with one partial JSON record.
    }
  }
  return null;
}

function writerRuntime(writers: Writer[]): WriterRuntime | null {
  if (writers.length === 0) return null;
  if (writers.length > 1) {
    return { kind: "shared", pid: null, startTime: null, processGroup: null, reason: "multiple Claude processes resume this thread" };
  }
  const writer = writers[0];
  if (!writer) return null;
  const kind: WriterRuntime["kind"] = writer.kind === "desktop" ? "desktop" : writer.kind === "self" ? "self" : "dedicated-cli";
  return {
    kind,
    pid: writer.pid,
    startTime: null,
    processGroup: null,
    reason: writer.kind === "desktop" ? "Claude desktop process resumes this thread" : writer.kind === "self" ? "this ccmux process descends from the writer" : "one dedicated Claude CLI process resumes this thread",
  };
}

function readSession(path: string): Pick<ExternalSession, "dir" | "lastActivityMs" | "lastModel" | "usedTokens" | "lastMessage"> | null {
  return cache.get(path, () => {
    const tail = readTailUntil(path, TAIL_LINES, (lines) => lastModel(lines) !== null && usedTokens(lines) !== null);
    if (tail.length === 0) return null;
    const messages = parse(tail.slice(-120), 1, 280);
    const lastMessage = messages.at(-1) ?? null;
    const parsedTime = lastMessage?.createdAt ? Date.parse(lastMessage.createdAt) : NaN;
    let lastActivityMs = Number.isFinite(parsedTime) ? parsedTime : null;
    if (lastActivityMs === null) {
      try { lastActivityMs = statSync(path).mtimeMs; } catch { lastActivityMs = null; }
    }
    return {
      dir: firstCwd(readHeadLines(path, HEAD_BYTES)) ?? firstCwd(tail),
      lastActivityMs,
      lastModel: lastModel(tail),
      usedTokens: usedTokens(tail),
      lastMessage,
    };
  });
}

export function discoverClaude(m: MachineConfig): ExternalSession[] {
  if (!existsSync(m.projectsDir)) return [];
  const live = processData();
  if (!live) return [];
  const managed = new Set(loadSessions(m).filter((session) => session.agent === "claude").map((session) => session.uuid));
  const targets = new Set([...live.targets].filter((threadId) => !managed.has(threadId)));
  if (targets.size === 0) return [];
  const processes = parsePs(live.output);
  const out: ExternalSession[] = [];
  let projectDirs: string[];
  try { projectDirs = readdirSync(m.projectsDir); } catch { return []; }
  for (const projectDir of projectDirs) {
    const root = `${m.projectsDir}/${projectDir}`;
    let files: string[];
    try { files = readdirSync(root); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const threadId = file.slice(0, -6);
      if (!targets.has(threadId)) continue;
      const path = `${root}/${file}`;
      const data = readSession(path);
      if (!data) continue;
      const writers = classifyWriters(processes, threadId, process.pid);
      const runtime = writerRuntime(writers);
      const evidence = writers.length > 0 ? "observed" : "unknown";
      out.push({
        key: externalSessionKey("claude", m.rcPrefix, threadId),
        plane: "external",
        provider: "claude",
        host: m.rcPrefix,
        threadId,
        dir: data.dir,
        path,
        origin: runtime?.kind === "desktop" ? "desktop" : "cli",
        storage: "stored",
        writerEvidence: evidence,
        writerRuntime: runtime,
        turnState: unknownTurnState("unsupported", "unsupported-provider"),
        capabilities: externalCapabilities("stored", evidence, runtime),
        lastActivityMs: data.lastActivityMs,
        lastModel: data.lastModel,
        usedTokens: data.usedTokens,
        lastMessage: data.lastMessage,
      });
    }
  }
  return out.sort((a, b) => basename(a.dir ?? "").localeCompare(basename(b.dir ?? "")) || a.threadId.localeCompare(b.threadId));
}
