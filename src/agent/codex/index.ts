import type { AgentProvider } from '../index.ts';
import { buildArgv, launchEnv, launchEnvKeys, launchInputs, preflight } from './launch.ts';
import { inspectChatPane, scanPane } from './pane.ts';
import { historyFile } from './resume.ts';
import { lastModel, parse, usedTokens } from './transcript.ts';

/** Codex provider — fresh identity is promoted by the pending bootstrap transaction. */
export const codexProvider: AgentProvider = {
  id: 'codex',
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
  inspectChatPane,
  chatPickup: 'transcript',
};
