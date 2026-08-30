import { existsSync, readFileSync } from "node:fs";
import type { MachineConfig, Session } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";
import { sessionsPath } from "./paths.ts";
import { SessionSchema } from "./schema.ts";

const HEADER = "# managed agent sessions — ccmux owns this file (JSONL v2)";

export function loadReadyRows(m: MachineConfig): Session[] {
  if (!existsSync(sessionsPath(m))) return [];
  const out: Session[] = [];
  for (const raw of readFileSync(sessionsPath(m), "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith("{")) throw new Error("bad sessions v2 line (expected JSON with explicit agent)");
    const value: unknown = JSON.parse(line);
    const session = SessionSchema.parse(value);
    if (session.runtime === "app-server" && session.agent !== "codex") throw new Error("app-server runtime requires agent=codex");
    if ((session.agent === "opencode" || session.agent === "custom") && session.runtime !== "native")
      throw new Error("This provider requires a native runtime");
    if (session.runtime === "native" && (!session.nativeSession || session.agent !== session.nativeSession.runtime))
      throw new Error("Native runtime requires an exact provider continuation");
    out.push(session);
  }
  return out;
}

export async function writeReadyRows(m: MachineConfig, sessions: Session[]): Promise<void> {
  const body = sessions.map((session) => JSON.stringify(session)).join("\n");
  await atomicWrite(sessionsPath(m), `${HEADER}\n${body}${body ? "\n" : ""}`);
}
