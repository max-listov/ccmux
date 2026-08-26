import { CHAT_GENERATION, SessionSchema, MachineConfigSchema } from "../src/config/schema.ts";
import type { ChatMessage, ChatPrincipal, ChatTarget, CodexAppPeer, ManagedPeer, Session, MachineConfig } from "../src/types.ts";

export const UUID = "11111111-1111-4111-8111-111111111111";

export function makeMachine(over: Record<string, unknown> = {}): MachineConfig {
  return MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/root/.claude/projects",
    rcPrefix: "prod",
    stateDir: "/tmp/ccmux-test-state",
    bootLabel: "ccmux.service",
    ...over,
  });
}

export function makeSession(over: Record<string, unknown> = {}): Session {
  return SessionSchema.parse({ name: "cc-x", dir: "/home/user", uuid: UUID, agent: "claude", ...over });
}

export function makePeer(over: Partial<ManagedPeer> = {}): ManagedPeer {
  return {
    kind: "managed",
    source: "ccmux",
    machine: "host-a",
    agent: "claude",
    session: "worker",
    threadId: UUID,
    ...over,
  };
}

export function makeCli(machine = "host-a"): ChatPrincipal {
  return { kind: "cli", source: "ccmux", machine };
}

export function makeAppPeer(over: Partial<CodexAppPeer> = {}): CodexAppPeer {
  return {
    kind: "codex-app",
    source: "codex-app",
    machine: "host-a",
    agent: "codex",
    threadId: UUID,
    name: "App task",
    ...over,
  };
}

export function makeOwner(): ChatTarget {
  return { kind: "owner" };
}

export function makeChatMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    v: CHAT_GENERATION,
    id: UUID,
    ts: "2026-08-05T00:00:00.000Z",
    from: makePeer({ session: "sender" }),
    to: makePeer({ session: "worker" }),
    body: "hello",
    task: null,
    defer: false,
    onBehalfOf: null,
    notBefore: null,
    ...over,
  };
}
