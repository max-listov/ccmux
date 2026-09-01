import type { AgentProvider } from '../agent/index.ts';
import { preflightOpenCode } from '../agent/opencode/server.ts';
import { sessionEnvRecipe } from '../agent/sessionEnv.ts';
import { CHAT_CREDENTIAL_ENV } from '../chat/auth.ts';

/** Native runtimes have no JSONL/pane parser. Their observations use the prepared native feed. */
export function nativeProvider(id: 'opencode' | 'custom' | 'claude'): AgentProvider {
  return {
    id,
    preflight: id === 'opencode' ? preflightOpenCode : () => undefined,
    buildArgv: (_s, m) => {
      if (id === 'custom') return ['stitchkit/agent-runtime/harness'];
      // Deliberately fictional but STABLE, like the Custom runtime's: the launch stamp compares
      // argv across restarts, and a native mode whose stamp drifts would demand restarts for
      // changes its runtime cannot act on. The real process is the ccmux-owned SDK bridge.
      if (id === 'claude') return ['ccmux/claude-native-bridge'];
      if (id !== 'opencode' || m.opencodeBin === undefined)
        throw new Error('Native executable is unavailable');
      return [m.opencodeBin, 'serve', '--hostname', '127.0.0.1', '--port', '<owned-ephemeral>'];
    },
    launchEnv: (_m, s) => sessionEnvRecipe(s, process.env, process.env.NODE_ENV).env,
    launchEnvKeys: () => [
      'CCMUX_SESSION',
      CHAT_CREDENTIAL_ENV,
      'OPENCODE_SERVER_USERNAME',
      'OPENCODE_SERVER_PASSWORD',
    ],
    launchInputs: () => [],
    historyFile: () => null,
    parse: () => {
      throw new Error('Native runtime history requires the structured control feed');
    },
    usedTokens: () => null,
    lastModel: () => null,
    scanPane: () => ({
      ready: false,
      state: 'indeterminate',
      atPrompt: null,
      contextLabel: '-',
      context: { text: null, usedTokens: null, limitTokens: null, percent: null },
    }),
  };
}
