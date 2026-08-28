import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentKind, MachineConfig, PendingSession, Session } from "../types.ts";
import { PendingSessionSchema, SessionSchema } from "../config/schema.ts";
import {
  appendSession,
  findSession,
  loadSessions,
  removeSessionIfGeneration,
  removeSessionIfUuid,
} from "../config/sessions.ts";
import { loadPendingSessions, removePendingSession, reservePendingSession } from "../config/pendingSessions.ts";
import { clearLifecycleBlockIfGeneration, readLifecycleBlock } from "../config/lifecycleBlocks.ts";
import { getProvider } from "../agent/index.ts";
import { killSessionIfGeneration } from "../tmux/tmux.ts";
import { startBootstrapSession, startSession } from "./lifecycle.ts";
import { preflightOwnedCodex } from "../agent/codex/ownedLaunch.ts";

export type CreateManagedInput = {
  name: string;
  dir: string;
  agent: AgentKind;
  flags: string[];
  router: boolean;
  runtime?: string;
  /** Declared at creation so the session's very FIRST launch already runs the recipe it will keep —
   *  otherwise a session is born inheriting and has to be migrated the day it is made. */
  envFile?: string;
};

export type CodexBootstrapOperation =
  | { kind: "create" }
  | { kind: "adopt"; sourceThreadId: string }
  | { kind: "fork"; sourceThreadId: string };

function sessionFields(input: CreateManagedInput): Omit<Session, "uuid"> {
  return SessionSchema.omit({ uuid: true }).parse({
    name: input.name,
    dir: input.dir,
    agent: input.agent,
    flags: input.flags,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.router ? { promptModules: ["router"], chatEnabled: true } : {}),
    ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
  });
}

async function createClaude(m: MachineConfig, input: CreateManagedInput): Promise<Session> {
  const session = SessionSchema.parse({ ...sessionFields(input), uuid: randomUUID() });
  await appendSession(m, session);
  try {
    await startSession(m, session.name, session.dir);
    return session;
  } catch (error) {
    await removeSessionIfUuid(m, session.name, session.uuid);
    throw error;
  }
}

async function rollbackPending(m: MachineConfig, pending: PendingSession, error: string): Promise<never> {
  await killSessionIfGeneration(m, pending.session.name, pending.generation);
  await removePendingSession(m, pending.generation);
  await removeSessionIfGeneration(m, pending.session.name, pending.generation);
  await clearLifecycleBlockIfGeneration(m, pending.session.name, pending.generation);
  throw new Error(error);
}

export async function createCodexBootstrap(
  m: MachineConfig,
  input: CreateManagedInput,
  operation: CodexBootstrapOperation,
): Promise<Session> {
  getProvider("codex").preflight(m);
  if (findSession(loadSessions(m), input.name) || loadPendingSessions(m).some((item) => item.session.name === input.name)) {
    throw new Error(`'${input.name}' already exists`);
  }
  const generation = randomUUID();
  const pending = PendingSessionSchema.parse({
    generation,
    marker: `ccmux_${generation}`,
    operation,
    session: sessionFields(input),
    createdAt: new Date().toISOString(),
    status: "pending",
  });
  await reservePendingSession(m, pending);
  try {
    await startBootstrapSession(m, pending.session.name, pending.session.dir, pending.generation);
  } catch (error) {
    return rollbackPending(m, pending, `Codex ${operation.kind} bootstrap could not start: ${String(error)}`);
  }
  const deadline = Date.now() + m.codexCorrelationTimeoutMs + 1_000;
  while (Date.now() < deadline) {
    const ready = findSession(loadSessions(m), pending.session.name);
    if (ready?.registrationGeneration === generation) return ready;
    if (ready) return rollbackPending(m, pending, "Codex session name was claimed by another create transaction");
    const current = loadPendingSessions(m).find((item) => item.generation === generation);
    if (!current) {
      const rebound = findSession(loadSessions(m), pending.session.name);
      if (rebound?.registrationGeneration === generation) return rebound;
      if (rebound) return rollbackPending(m, pending, "Codex session name was claimed by another create transaction");
      const block = readLifecycleBlock(m, pending.session.name);
      const error = block?.generation === generation
        ? block.error
        : `Codex ${operation.kind} bootstrap disappeared before promotion`;
      return rollbackPending(m, pending, error);
    }
    if (current.status === "blocked") return rollbackPending(m, pending, current.error ?? "Codex bootstrap blocked");
    await Bun.sleep(50);
  }
  return rollbackPending(m, pending, `Codex ${operation.kind} correlation timed out`);
}

function externalCodexName(m: MachineConfig, dir: string, threadId: string, wantName?: string): string {
  const sessions = loadSessions(m);
  const base = wantName ?? `cc-${basename(dir)}`;
  if (!findSession(sessions, base) && !loadPendingSessions(m).some((item) => item.session.name === base)) return base;
  return `${base}-${threadId.slice(0, 4)}`;
}

export async function adoptCodexThread(
  m: MachineConfig,
  dir: string,
  threadId: string,
  wantName?: string,
): Promise<Session> {
  return createCodexBootstrap(m, {
    name: externalCodexName(m, dir, threadId, wantName),
    dir,
    agent: "codex",
    flags: [],
    router: false,
  }, { kind: "adopt", sourceThreadId: threadId });
}

export async function forkCodexThread(
  m: MachineConfig,
  dir: string,
  sourceThreadId: string,
  wantName?: string,
): Promise<Session> {
  return createCodexBootstrap(m, {
    name: externalCodexName(m, dir, sourceThreadId, wantName),
    dir,
    agent: "codex",
    flags: [],
    router: false,
  }, { kind: "fork", sourceThreadId });
}

/** Shared transactional create path for CLI and TUI. */
export async function createManagedSession(m: MachineConfig, input: CreateManagedInput): Promise<Session> {
  const fields = sessionFields(input);
  if (fields.runtime === "app-server" && fields.agent !== "codex") throw new Error("app-server runtime requires --agent codex");
  if (fields.runtime === "app-server") preflightOwnedCodex(m, input.flags);
  getProvider(input.agent).preflight(m);
  if (findSession(loadSessions(m), input.name) || loadPendingSessions(m).some((item) => item.session.name === input.name)) {
    throw new Error(`'${input.name}' already exists`);
  }
  return input.agent === "codex" ? createCodexBootstrap(m, input, { kind: "create" }) : createClaude(m, input);
}
