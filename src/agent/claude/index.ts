import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv } from "./launch.ts";
import { detectFork } from "./fork.ts";
import { historyFile } from "./resume.ts";
import { parse, usedTokens, lastModel } from "./transcript.ts";
import { scanPane, resumePickerAnswer, chatDeliverable, inputBusy } from "./pane.ts";

/** Claude Code provider — everything agent-specific for `agent: "claude"`. */
export const claudeProvider: AgentProvider = {
  id: "claude",
  buildArgv,
  launchEnv,
  historyFile,
  detectFork,
  parse,
  usedTokens,
  lastModel,
  scanPane,
  resumePickerAnswer,
  chatDeliverable,
  inputBusy,
};
