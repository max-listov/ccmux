import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv } from "./launch.ts";
import { historyFile } from "./resume.ts";
import { parse, usedTokens } from "./transcript.ts";
import { scanPane } from "./pane.ts";

/** Claude Code provider — everything agent-specific for `agent: "claude"`. */
export const claudeProvider: AgentProvider = {
  id: "claude",
  buildArgv,
  launchEnv,
  historyFile,
  parse,
  usedTokens,
  scanPane,
};
