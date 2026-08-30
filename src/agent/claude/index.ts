import type { AgentProvider } from '../index.ts';
import { detectFork } from './fork.ts';
import { buildArgv, launchEnv, launchEnvKeys, launchInputs, preflight } from './launch.ts';
import { inspectChatPane, promptAnswer, scanPane } from './pane.ts';
import { findHistoryElsewhere, historyFile } from './resume.ts';
import { lastModel, parse, usedTokens } from './transcript.ts';

/** Claude Code provider — everything agent-specific for `agent: "claude"`. */
export const claudeProvider: AgentProvider = {
  id: 'claude',
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
