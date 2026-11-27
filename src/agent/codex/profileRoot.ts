import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig, Session } from '../../types.ts';
import { HOME } from '../../util/env.ts';
import { envFilePath } from '../launch/launchInputs.ts';
import { parseEnvFile } from '../launch/sessionEnv.ts';

/**
 * Where one Codex session keeps its state: the profile it runs under.
 *
 * A profile is a `CODEX_HOME` declared in the session's env file. Codex writes rollouts to
 * `<CODEX_HOME>/sessions/…` and reads `AGENTS.md` and `config.toml` from `<CODEX_HOME>`.
 * Without a per-session declaration, the machine's `codexHome` and `codexSessionsDir` are the
 * default. Like `claudeProfile`, this never reads `process.env.CODEX_HOME` from whichever process
 * happens to ask, so daemon, CLI and supervisor agree on where the session lives.
 */
export interface CodexProfile {
  /** The declared `CODEX_HOME`, or null when the session declares none. */
  configDir: string | null;
  /** Effective `CODEX_HOME`: the session's declared profile, else the machine default. */
  codexHome: string | undefined;
  /** Effective sessions directory: `<profile>/sessions`, else the machine default. */
  sessionsDir: string | undefined;
}

const declared = new Map<string, { stamp: string; configDir: string | null }>();

function declaredConfigDir(path: string, home: string): string | null {
  const key = `${path}\0${home}`;
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    declared.delete(key);
    return null;
  }
  const cached = declared.get(key);
  if (cached !== undefined && cached.stamp === stamp) return cached.configDir;
  let configDir: string | null = null;
  try {
    const env = parseEnvFile(readFileSync(path, 'utf8'), { HOME: home });
    const raw = env.CODEX_HOME?.trim();
    configDir = raw !== undefined && raw !== '' ? raw.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
  declared.set(key, { stamp, configDir });
  return configDir;
}

export function codexProfile(
  session: Pick<Session, 'dir' | 'envFile'>,
  m: Pick<MachineConfig, 'codexHome' | 'codexSessionsDir'>,
  home = HOME,
): CodexProfile {
  const path = envFilePath(session);
  const configDir = path === null ? null : declaredConfigDir(path, home);
  if (configDir === null)
    return {
      configDir: null,
      codexHome: m.codexHome,
      sessionsDir: m.codexSessionsDir,
    };
  return {
    configDir,
    codexHome: configDir,
    sessionsDir: join(configDir, 'sessions'),
  };
}
