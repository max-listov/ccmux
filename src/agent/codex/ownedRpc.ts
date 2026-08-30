import type { MachineConfig, Session } from "../../types.ts";
import type { CodexRpcOptions } from "./rpc.ts";
import { connectCodexSocket } from "./socket.ts";
import { ownedCodexSocket } from "./ownedPaths.ts";

// These notifications are not turn state. In particular app/list/updated can be megabytes of
// connector metadata, broadcast when an interactive client refreshes its app catalogue.
export const OWNED_CODEX_OMIT_NOTIFICATIONS = [
  "app/list/updated", "item/reasoning/textDelta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/mcpToolCall/progress",
];

export function connectOwnedCodex(m: MachineConfig, s: Pick<Session, "name">,
  callbacks: Pick<CodexRpcOptions, "signal" | "onEvent" | "onRequest" | "onClose"> = {}) {
  return connectCodexSocket(ownedCodexSocket(m, s.name), { ...callbacks,
    experimentalApi: true, maxMessageBytes: 2 * 1024 * 1024,
    optOutNotificationMethods: OWNED_CODEX_OMIT_NOTIFICATIONS,
  });
}
