import { SessionSchema, MachineConfigSchema } from "../src/config/schema.ts";
import type { Session, MachineConfig } from "../src/types.ts";

export const UUID = "11111111-1111-4111-8111-111111111111";

export function makeMachine(over: Record<string, unknown> = {}): MachineConfig {
  return MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/root/.claude/projects",
    rcPrefix: "prod",
    sessionsFile: "/tmp/ccmux-test.sessions",
    bootLabel: "ccmux.service",
    ...over,
  });
}

export function makeSession(over: Record<string, unknown> = {}): Session {
  return SessionSchema.parse({ name: "cc-x", dir: "/home/user", uuid: UUID, ...over });
}
