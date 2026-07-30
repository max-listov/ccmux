import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv } from "./launch.ts";
import { historyFile } from "./resume.ts";
import { detectFork } from "./fork.ts";
import { parse, usedTokens, lastModel } from "./transcript.ts";
import { scanPane } from "./pane.ts";

/** Codex provider — everything agent-specific for `agent: "codex"`. Launch pins Codex's
 *  self-assigned id via detectFork reconcile (Codex has no --session-id); reading is 1:1 with Claude. */
export const codexProvider: AgentProvider = {
  id: "codex",
  buildArgv,
  launchEnv,
  historyFile,
  detectFork,
  parse,
  usedTokens,
  lastModel,
  scanPane,
};
