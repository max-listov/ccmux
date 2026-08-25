import type { AgentProvider } from "../index.ts";
import { buildArgv, launchEnv, launchEnvKeys, launchInputs, preflight } from "./launch.ts";
import { historyFile } from "./resume.ts";
import { parse, usedTokens, lastModel } from "./transcript.ts";
import { scanPane } from "./pane.ts";

/** Codex provider — fresh identity is promoted by the pending bootstrap transaction. */
export const codexProvider: AgentProvider = {
  id: "codex",
  preflight,
  buildArgv,
  launchEnv,
  launchEnvKeys,
  launchInputs,
  historyFile,
  parse,
  usedTokens,
  lastModel,
  scanPane,
};
