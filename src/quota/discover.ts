import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claudeProfile } from '../agent/claude/profileRoot.ts';
import { envFilePath } from '../agent/launch/launchInputs.ts';
import { readEnvFile } from '../agent/launch/sessionEnv.ts';
import type { MachineConfig, Session } from '../types.ts';
import { HOME } from '../util/env.ts';
import type { ProbeTarget } from './probe.ts';

/**
 * Every place on this machine an agent account is signed in, whether or not anyone is using it.
 *
 * A profile is a directory the vendor's program keeps a login in: a Claude config directory, a Codex
 * home. They are found three ways, because each misses something the others find — the profiles the
 * registered sessions declare (a session is the proof it is used), the default profile every program
 * has, and sibling directories in the home folder that hold a login (an account signed in by hand
 * that no session has been created for yet, which is exactly the one nobody would think to ask
 * about). A directory is a profile only if it holds a login, so a backup copy or a cache is not.
 */

export interface QuotaTarget extends ProbeTarget {
  /** The registered sessions of this machine running under the profile. */
  sessions: string[];
}

/** Cached by modification time and size: the file is large, Claude rewrites it only now and then,
 *  and this is asked on every fleet read. */
const loginCache = new Map<string, { stamp: string; holds: boolean }>();

function holdsClaudeLogin(file: string): boolean {
  let stamp: string;
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return false;
  }
  const cached = loginCache.get(file);
  if (cached?.stamp === stamp) return cached.holds;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: unknown } | null;
    const holds =
      parsed !== null && typeof parsed === 'object' && parsed.oauthAccount !== undefined;
    loginCache.set(file, { stamp, holds });
    return holds;
  } catch {
    return false; // being rewritten right now: not cached, asked again next time
  }
}

const COPY_NAME = /backup|\.bak|\.old|\.orig|\.tmp|[-_.]copy|[-_.]before/i;

function siblings(home: string, prefix: '.claude' | '.codex'): string[] {
  let entries: string[];
  try {
    entries = readdirSync(home, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          new RegExp(`^\\${prefix}[-_.]`).test(entry.name) &&
          // A saved copy of a profile holds the same login and is not a second place it runs.
          !COPY_NAME.test(entry.name),
      )
      .map((entry) => join(home, entry.name));
  } catch {
    return [];
  }
  return entries.sort();
}

/** By provider, the default profile before the others, then by key — stable across reads. */
function ordered(found: ReadonlyMap<string, QuotaTarget>): QuotaTarget[] {
  const rank = (t: QuotaTarget): string => `${t.provider}:${t.home === null ? '0' : '1'}:${t.key}`;
  return [...found.values()].sort((a, b) => rank(a).localeCompare(rank(b)));
}

export function discoverTargets(
  m: Pick<MachineConfig, 'projectsDir'>,
  sessions: readonly Session[],
  opts: { scan?: boolean; home?: string } = {},
): QuotaTarget[] {
  const home = opts.home ?? HOME;
  const found = new Map<string, QuotaTarget>();
  const add = (target: Omit<QuotaTarget, 'sessions'>, session: string | null): void => {
    const existing = found.get(target.key);
    if (existing === undefined)
      found.set(target.key, { ...target, sessions: session === null ? [] : [session] });
    else {
      if (session !== null) existing.sessions.push(session);
      existing.envFile ??= target.envFile;
    }
  };

  for (const session of sessions) {
    if (session.archived) continue;
    if (session.agent === 'claude') {
      const profile = claudeProfile(session, m);
      add(
        {
          provider: 'claude',
          key: `claude:${profile.configDir ?? 'default'}`,
          home: profile.configDir,
          // A session on its own credentials (a token, a cloud provider) is not signed in as the
          // profile's account; its env file would make the probe ask as someone else.
          envFile: profile.ownCredentials ? null : envFilePath(session),
        },
        session.name,
      );
    } else if (session.agent === 'codex') {
      const path = envFilePath(session);
      // `$HOME` in a declared value is expanded the way the launch expands it.
      const declared =
        path === null ? undefined : readEnvFile(path, { HOME: home }).CODEX_HOME?.trim();
      const dir = declared === undefined || declared === '' ? null : declared.replace(/\/+$/, '');
      add(
        { provider: 'codex', key: `codex:${dir ?? 'default'}`, home: dir, envFile: path },
        session.name,
      );
    }
  }

  // The scan reads files in the home folder (a login file is large); the registered sessions alone
  // already name every profile that is in use, which is all the per-row view needs.
  if (opts.scan === false) return ordered(found);

  if (holdsClaudeLogin(join(home, '.claude.json')))
    add({ provider: 'claude', key: 'claude:default', home: null, envFile: null }, null);
  for (const dir of siblings(home, '.claude'))
    if (holdsClaudeLogin(join(dir, '.claude.json')))
      add({ provider: 'claude', key: `claude:${dir}`, home: dir, envFile: null }, null);

  if (existsSync(join(home, '.codex', 'auth.json')))
    add({ provider: 'codex', key: 'codex:default', home: null, envFile: null }, null);
  for (const dir of siblings(home, '.codex'))
    if (existsSync(join(dir, 'auth.json')))
      add({ provider: 'codex', key: `codex:${dir}`, home: dir, envFile: null }, null);

  return ordered(found);
}
