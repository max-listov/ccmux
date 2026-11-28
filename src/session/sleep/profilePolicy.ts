import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { antigravityProfileDataDir } from '../../agent/antigravity/namedProfiles.ts';
import { antigravityDataDir } from '../../agent/antigravity/preflight.ts';
import { claudeProfile } from '../../agent/claude/profileRoot.ts';
import { codexProfile } from '../../agent/codex/profileRoot.ts';
import { envFilePath, expandHome } from '../../agent/launch/launchInputs.ts';
import { isAntigravityProfileBinding } from '../../config/antigravityProfileSchema.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { HOME } from '../../util/home.ts';
import { LOCK_TIMEOUT_MS, withLock } from '../../util/lock.ts';

/**
 * Canonical provider profile grouping and sleep-policy enforcement (`pinned` + `minAwakePerProfile`).
 *
 * Lock hierarchy across the whole sleep subsystem:
 *   `profile-policy.lock` -> `admission.lock` (per-session) -> `registry.lock`
 * Never acquire `profile-policy.lock` or `admission.lock` while holding `registry.lock`.
 */

function expandPath(raw: string, home = HOME): string {
  if (home === HOME) return expandHome(raw);
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

function canonicalDir(raw: string, baseDir: string, home = HOME): string {
  const absolute = resolve(baseDir, expandPath(raw.trim(), home));
  try {
    return realpathSync(absolute).replace(/\/+$/, '');
  } catch {
    return absolute.replace(/\/+$/, '');
  }
}

export type SessionProfileResult = { readonly key: string } | { readonly unavailable: string };

/**
 * Resolve the canonical profile key that groups sessions sharing one provider account / Remote
 * Control surface.
 *
 * - With no config directory, Claude reads `~/.claude.json`. An explicit `~/.claude` reads
 *   `~/.claude/.claude.json` and gets its own group. Bedrock, Vertex and other custom credentials
 *   receive a separate key so only sessions sharing the OAuth profile count toward its minimum.
 * - Codex: unset `CODEX_HOME` and explicit `~/.codex` share `~/.codex/auth.json`, so both map to
 *   the same canonical `codex:<realpath>`.
 * - An unreadable declared `envFile` makes the profile unavailable.
 */
export function sessionProfileKey(
  session: Pick<Session, 'agent' | 'dir' | 'envFile' | 'profile'>,
  m: Pick<MachineConfig, 'projectsDir' | 'codexHome' | 'codexSessionsDir'> &
    Partial<Pick<MachineConfig, 'antigravityDataDir'>>,
  home = HOME,
): SessionProfileResult {
  const declaredEnv = envFilePath(session);
  if (declaredEnv !== null) {
    try {
      if (!statSync(declaredEnv).isFile()) {
        return { unavailable: `Declared envFile is not a regular file: ${declaredEnv}` };
      }
      readFileSync(declaredEnv, 'utf8');
    } catch {
      return { unavailable: `Declared envFile is unreadable: ${declaredEnv}` };
    }
  }
  if (session.agent === 'claude') {
    const profile = claudeProfile(session, m);
    if (profile.ownCredentials) {
      const material = `${declaredEnv ?? 'none'}\0${profile.configDir ?? 'default'}`;
      const digest = createHash('sha256').update(material).digest('hex').slice(0, 12);
      return { key: `claude:custom-auth:${digest}` };
    }
    if (profile.configDir === null) return { key: 'claude:default' };
    return { key: `claude:${canonicalDir(profile.configDir, session.dir, home)}` };
  }
  if (session.agent === 'codex') {
    const profile = codexProfile(session, m, home);
    const effective = profile.codexHome ?? join(home, '.codex');
    return { key: `codex:${canonicalDir(effective, session.dir, home)}` };
  }
  if (session.agent === 'antigravity') {
    const binding = isAntigravityProfileBinding(session.profile) ? session.profile : undefined;
    const dataDir = binding
      ? antigravityProfileDataDir(m, binding, home)
      : antigravityDataDir(m, home);
    return { key: `antigravity:${canonicalDir(dataDir, session.dir, home)}` };
  }
  return { key: `${session.agent}:default` };
}

/** Host-level lock serializing profile-wide `minAwakePerProfile` checks + `requested` admission. */
export function withProfilePolicyLock<T>(
  m: Pick<MachineConfig, 'stateDir'>,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withLock(
    join(m.stateDir, 'sleep-policy.lock'),
    async () => {
      signal?.throwIfAborted();
      return run();
    },
    'sleep profile policy',
    LOCK_TIMEOUT_MS,
    signal,
  );
}

export type SleepPolicyVerdict =
  | { readonly allowed: true; readonly profileKey: string | null }
  | {
      readonly allowed: false;
      readonly code: 'PINNED_SESSION' | 'MIN_AWAKE_PER_PROFILE' | 'PROFILE_UNAVAILABLE';
      readonly reason: string;
    };

export type SessionHealthState = 'idle' | 'working' | 'prompt' | 'stopped' | 'blocked' | 'unknown';

export function isHealthyAwakeState(state: SessionHealthState | undefined): boolean {
  return state === 'idle' || state === 'working';
}

/**
 * Enforce `pinned`, readable `envFile`, and `minAwakePerProfile` across healthy awake peers in the
 * same provider profile. When `forcePolicy` is true (explicit manual `--force`), policy guards are
 * bypassed while safety/idle guards in `idleProof` still stand.
 */
export function evaluateSleepPolicy(input: {
  readonly m: MachineConfig;
  readonly session: Session;
  readonly sessions: readonly Session[];
  readonly running: ReadonlySet<string>;
  readonly sleeping: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
  readonly states?: ReadonlyMap<string, SessionHealthState>;
  readonly forcePolicy?: boolean;
  readonly home?: string;
}): SleepPolicyVerdict {
  const { m, session, sessions, running, sleeping, blocked, states, forcePolicy = false } = input;
  const home = input.home ?? HOME;
  const profile = sessionProfileKey(session, m, home);
  if (forcePolicy) {
    return { allowed: true, profileKey: 'key' in profile ? profile.key : null };
  }
  if (session.pinned === true) {
    return {
      allowed: false,
      code: 'PINNED_SESSION',
      reason: 'Session is pinned awake (pass --force to override policy)',
    };
  }
  // Delegated headless child sessions are bounded subagent workers, not interactive Remote Control
  // entry points: they are never blocked by `minAwakePerProfile` and never count toward it.
  if (session.delegation !== undefined) {
    return { allowed: true, profileKey: 'key' in profile ? profile.key : null };
  }
  if ('unavailable' in profile) {
    return {
      allowed: false,
      code: 'PROFILE_UNAVAILABLE',
      reason: profile.unavailable,
    };
  }
  const minAwake = m.idleSleep.minAwakePerProfile;
  if (minAwake <= 0) return { allowed: true, profileKey: profile.key };
  let otherHealthyAwake = 0;
  for (const other of sessions) {
    if (other.name === session.name || other.archived || other.delegation !== undefined) continue;
    if (!running.has(other.name) || sleeping.has(other.name) || blocked.has(other.name)) continue;
    if (states !== undefined && !isHealthyAwakeState(states.get(other.name))) continue;
    const otherProfile = sessionProfileKey(other, m, home);
    if ('key' in otherProfile && otherProfile.key === profile.key) {
      otherHealthyAwake++;
    }
  }
  if (otherHealthyAwake < minAwake) {
    return {
      allowed: false,
      code: 'MIN_AWAKE_PER_PROFILE',
      reason: `Profile ${profile.key} requires at least ${minAwake} healthy awake session(s)`,
    };
  }
  return { allowed: true, profileKey: profile.key };
}
