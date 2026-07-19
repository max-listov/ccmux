import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv } from "./launch.ts";
import { detectFork } from "./fork.ts";
import { historyFile } from "./resume.ts";
import { parse, usedTokens } from "./transcript.ts";
import { scanPane, resumePickerAnswer } from "./pane.ts";

/** Claude Code provider — everything agent-specific for `agent: "claude"`. */
export const claudeProvider: AgentProvider = {
  id: "claude",
  buildArgv,
  launchEnv,
  historyFile,
  detectFork,
  parse,
  usedTokens,
  scanPane,
  resumePickerAnswer,
};
