import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv, launchEnvKeys, launchInputs, preflight } from "./launch.ts";
import { detectFork } from "./fork.ts";
import { historyFile, findHistoryElsewhere } from "./resume.ts";
import { parse, usedTokens, lastModel } from "./transcript.ts";
import { scanPane, promptAnswer, inspectChatPane } from "./pane.ts";

/** Claude Code provider — everything agent-specific for `agent: "claude"`. */
export const claudeProvider: AgentProvider = {
  id: "claude",
  preflight,
  buildArgv,
  launchEnv,
  launchEnvKeys,
  launchInputs,
  historyFile,
  findHistoryElsewhere,
  detectFork,
  parse,
  usedTokens,
  lastModel,
  scanPane,
  promptAnswer,
  inspectChatPane,
};
