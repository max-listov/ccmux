import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig, Session } from '../../types.ts';
import { HOME } from '../../util/env.ts';
import { envFilePath } from '../launch/launchInputs.ts';
import { parseEnvFile } from '../launch/sessionEnv.ts';

/**
 * Where one Claude session keeps its state: the profile it runs under.
 *
 * A profile is a `CLAUDE_CONFIG_DIR`. Claude writes the conversation to `<dir>/projects/…` and its
 * account and trust flags to `<dir>/.claude.json`; without the variable the same files are
 * `~/.claude/projects` and `~/.claude.json` — a different file, not the same one under another
 * name (`~/.claude/.claude.json` exists and holds no account). So "not set" and "set to the default
 * directory" are different answers, and `configDir: null` is the first one.
 *
 * The profile is read from what the SESSION declared (its env file) and from the machine's
 * `projectsDir`, never from the environment of whichever process asks. The daemon, a `ccmux list`
 * typed inside another profile's session, and the supervisor loop all have different environments;
 * a session whose profile depended on who looked would be a different session to each of them. The
 * launch recipe applies the same declared file, so what is computed here is what the agent got.
 * A machine whose daemon environment itself carries `CLAUDE_CONFIG_DIR` declares that profile as
 * its `projectsDir`.
 */
export interface ClaudeProfile {
  /** The declared `CLAUDE_CONFIG_DIR`, or null when the session declares none. */
  configDir: string | null;
  /** Where the agent writes this session's conversations. */
  projectsDir: string;
  /** The file holding the login (`oauthAccount`) and the per-folder trust flags. */
  globalConfigFile: string;
  /** The directory holding the user-scope `CLAUDE.md` and `settings.json`. */
  userDir: string;
  /**
   * True when the session's declared environment makes it pay or authenticate some other way than
   * the login stored in `globalConfigFile` (a token, a cloud provider, a gateway). The stored login
   * is then not who this session is, and must not be attributed to it. An API key is not on this
   * list: the launch drops it when the profile has a login, so the login still wins.
   */
  ownCredentials: boolean;
}

/** Variables that put a session on something other than the profile's stored login. */
export const CREDENTIAL_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
] as const;

interface Declared {
  configDir: string | null;
  ownCredentials: boolean;
}

const declared = new Map<string, { stamp: string; value: Declared }>();
const NONE: Declared = { configDir: null, ownCredentials: false };

/** What one env file declares about the profile, cached by the file's mtime and size so the answer
 *  costs a stat — it is asked on every history lookup, and those run in the daemon's hot loops.
 *  Values other than the profile directory are reduced to a yes/no here and never kept. */
function declaredProfile(path: string): Declared {
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    declared.delete(path);
    return NONE;
  }
  const cached = declared.get(path);
  if (cached !== undefined && cached.stamp === stamp) return cached.value;
  let value = NONE;
  try {
    const env = parseEnvFile(readFileSync(path, 'utf8'), { HOME });
    const dir = env.CLAUDE_CONFIG_DIR;
    value = {
      configDir: dir !== undefined && dir.trim() !== '' ? dir.trim().replace(/\/+$/, '') : null,
      ownCredentials: CREDENTIAL_KEYS.some((key) => (env[key] ?? '').trim() !== ''),
    };
  } catch {
    // Not remembered: an unreadable file (permissions change only the inode's ctime, not the stamp)
    // must be read again, not answered from the failure.
    return NONE;
  }
  declared.set(path, { stamp, value });
  return value;
}

export function claudeProfile(
  session: Pick<Session, 'dir' | 'envFile'>,
  m: Pick<MachineConfig, 'projectsDir'>,
): ClaudeProfile {
  const path = envFilePath(session);
  const { configDir, ownCredentials } = path === null ? NONE : declaredProfile(path);
  if (configDir === null)
    return {
      configDir: null,
      projectsDir: m.projectsDir,
      globalConfigFile: `${HOME}/.claude.json`,
      userDir: `${HOME}/.claude`,
      ownCredentials,
    };
  return {
    ownCredentials,
    configDir,
    projectsDir: join(configDir, 'projects'),
    globalConfigFile: join(configDir, '.claude.json'),
    userDir: configDir,
  };
}

/** Every projects root this machine's sessions write to: the machine's own plus one per distinct
 *  declared profile. Where a conversation that is not at its expected path can still be found. */
export function knownProjectsDirs(
  sessions: readonly Pick<Session, 'dir' | 'envFile'>[],
  m: Pick<MachineConfig, 'projectsDir'>,
): string[] {
  return [...new Set([m.projectsDir, ...sessions.map((s) => claudeProfile(s, m).projectsDir)])];
}
