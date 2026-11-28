import { antigravityLaunchOptions } from '../agent/antigravity/namedProfiles.ts';
import {
  ANTIGRAVITY_MIN_VERSION,
  ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
  antigravityBin,
  preflightAntigravity,
} from '../agent/antigravity/preflight.ts';
import type { AgentProvider } from '../agent/index.ts';
import { IDENTITY_ENV_KEYS, pinIdentity } from '../agent/launch/identityEnv.ts';
import { sessionEnvRecipe } from '../agent/launch/sessionEnv.ts';
import { preflightOpenCode } from '../agent/opencode/server.ts';
import { isAntigravityProfileBinding } from '../config/antigravityProfileSchema.ts';

/** Native runtimes have no JSONL/pane parser. Their observations use the prepared native feed. */
export function nativeProvider(
  id: 'opencode' | 'custom' | 'claude' | 'antigravity',
): AgentProvider {
  return {
    id,
    preflight:
      id === 'opencode'
        ? preflightOpenCode
        : id === 'antigravity'
          ? async (m, profile) => {
              const binding = isAntigravityProfileBinding(profile) ? profile : undefined;
              const launch = antigravityLaunchOptions(m, binding);
              await preflightAntigravity(m, [], {
                minVersion: launch.forceFileStorage
                  ? ANTIGRAVITY_MULTIPROFILE_MIN_VERSION
                  : ANTIGRAVITY_MIN_VERSION,
                dataDir: launch.dataDir,
              });
            }
          : () => undefined,
    buildArgv: (s, m) => {
      if (id === 'custom') return ['stitchkit/agent-runtime/harness'];
      // Deliberately fictional but STABLE, like the Custom runtime's: the launch stamp compares
      // argv across restarts, and a native mode whose stamp drifts would demand restarts for
      // changes its runtime cannot act on. The real process is the stitchmux-owned SDK bridge.
      if (id === 'claude') return ['stitchmux/claude-native-bridge'];
      if (id === 'antigravity') {
        const bin = antigravityBin(m);
        if (!bin) throw new Error('Antigravity CLI (agy) is not configured on this host');
        const binding = isAntigravityProfileBinding(s.profile) ? s.profile : undefined;
        const launch = antigravityLaunchOptions(m, binding);
        return [bin, 'acp', '--stdio', '--process-per-session', '--sandbox', ...launch.dirFlags];
      }
      if (id !== 'opencode' || m.opencodeBin === undefined)
        throw new Error('Native executable is unavailable');
      return [m.opencodeBin, 'serve', '--hostname', '127.0.0.1', '--port', '<owned-ephemeral>'];
    },
    launchEnv: (m, s) =>
      pinIdentity(sessionEnvRecipe(s, process.env, process.env.NODE_ENV).env, m, s),
    launchEnvKeys: () => [
      ...IDENTITY_ENV_KEYS,
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
      context: {
        text: null,
        usedTokens: null,
        limitTokens: null,
        percent: null,
        rawLimitTokens: null,
        window: null,
      },
    }),
  };
}
