import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv } from "./launch.ts";
import { historyFile } from "./resume.ts";
import { parse, usedTokens, lastModel } from "./transcript.ts";
import { scanPane } from "./pane.ts";

/** Codex provider — everything agent-specific for `agent: "codex"`.
 *  Reading (transcript/pane/locate) is 1:1 with Claude; launch has a documented gap. */
export const codexProvider: AgentProvider = {
  id: "codex",
  buildArgv,
  launchEnv,
  historyFile,
  parse,
  usedTokens,
  lastModel,
  scanPane,
};
