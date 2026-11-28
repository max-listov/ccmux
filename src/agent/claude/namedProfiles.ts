import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  isAntigravityProfileBinding,
  isClaudeProfileBinding,
} from '../../config/antigravityProfileSchema.ts';
import {
  type ClaudeProfileBinding,
  ProfileDirectorySchema,
  ProfileNameSchema,
} from '../../config/claudeProfileSchema.ts';
import type { AgentKind, MachineConfig, Session } from '../../types.ts';
import { HOME } from '../../util/home.ts';
import { verifyAntigravityProfile } from '../antigravity/namedProfiles.ts';
import { digestOf, envFilePath } from '../launch/launchInputs.ts';
import { readEnvFile } from '../launch/sessionEnv.ts';
import { CLAUDE_PROFILE_AUTH_ENV } from './profileRoot.ts';

type ProfileHost = Pick<MachineConfig, 'claudeProfiles'>;
type SessionProfileHost = Pick<
  MachineConfig,
  'claudeProfiles' | 'antigravityDataDir' | 'antigravityProfiles'
>;
const RegistrySchema = z.object({
  version: z.literal(1),
  profiles: z.array(
    z.object({
      name: ProfileNameSchema,
      code: z.object({ configDir: ProfileDirectorySchema }).nullish(),
    }),
  ),
});
const LoginSchema = z.object({
  oauthAccount: z.object({ accountUuid: z.string().min(1).nullish() }).nullish(),
});
const implicit = { source: 'default', name: 'default', configDir: null } as const;

export function claudeProfileId(binding: ClaudeProfileBinding): string {
  return binding.configDir === null ? 'default' : `claude-${digestOf(binding.configDir)}`;
}

function readOptionalJson(path: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${path}`, { cause: error });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
}

function machineProfiles(m: ProfileHost): ClaudeProfileBinding[] {
  return Object.entries(m.claudeProfiles ?? {}).map(([name, configDir]) => ({
    name,
    configDir,
    source: 'machine',
  }));
}

function importedProfiles(registryPath: string): ClaudeProfileBinding[] {
  const data = readOptionalJson(registryPath);
  if (data === undefined) return [];
  const registry = RegistrySchema.safeParse(data);
  if (!registry.success)
    throw new Error(`Invalid claude-multiprofile registry in ${registryPath}`, {
      cause: registry.error,
    });
  return registry.data.profiles.flatMap(({ name, code }) =>
    code
      ? [{ name, source: 'claude-multiprofile' as const, configDir: code.configDir, registryPath }]
      : [],
  );
}

/** Only the installed manager's local registry is consumed, never a launcher or alias. */
export function namedClaudeProfiles(m: ProfileHost): ClaudeProfileBinding[] {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && isAbsolute(xdg) ? xdg : join(HOME, '.config');
  const profiles = [
    implicit,
    ...machineProfiles(m),
    ...importedProfiles(join(root, 'claude-multiprofile', 'profiles.json')),
  ];
  const names = new Set<string>();
  for (const { name } of profiles) {
    if (names.has(name)) throw new Error(`Ambiguous Claude profile name: ${name}`);
    names.add(name);
  }
  return profiles;
}

function physicalDirectory(path: string): string {
  try {
    const dir = realpathSync(path);
    if (statSync(dir).isDirectory()) return dir;
  } catch (error) {
    throw new Error(`Claude profile directory unavailable: ${path}`, { cause: error });
  }
  throw new Error(`Claude profile path is not a directory: ${path}`);
}

function accountDigest(dir: string | null): string | undefined {
  const file = join(dir ?? HOME, '.claude.json');
  const data = readOptionalJson(file);
  if (data === undefined) return undefined;
  const login = LoginSchema.safeParse(data);
  if (!login.success)
    throw new Error(`Invalid Claude account metadata in ${file}`, { cause: login.error });
  const id = login.data.oauthAccount?.accountUuid;
  return id ? createHash('sha256').update(id).digest('hex') : undefined;
}

/** Resolve once at admission. A restart uses the saved location and identity. */
export function selectClaudeProfile(
  m: ProfileHost,
  agent: AgentKind,
  name: string,
): ClaudeProfileBinding {
  if (agent !== 'claude')
    throw new Error('Named profiles are available for Claude and Antigravity only');
  const declared =
    name === implicit.name ? implicit : namedClaudeProfiles(m).find((p) => p.name === name);
  if (!declared) throw new Error(`Unknown Claude profile: ${name}`);
  const binding =
    declared.source === 'default'
      ? declared
      : { ...declared, configDir: physicalDirectory(declared.configDir) };
  const digest = accountDigest(binding.configDir);
  return digest === undefined ? binding : { ...binding, accountDigest: digest };
}

/** A renamed label can keep the same directory. A reassigned label must never retarget a conversation. */
export function verifyClaudeProfile(m: ProfileHost, binding: ClaudeProfileBinding): void {
  if (binding.source !== 'default') {
    // A daemon can have a different XDG_CONFIG_HOME from the terminal that registered the session.
    const profiles =
      binding.source === 'machine' ? machineProfiles(m) : importedProfiles(binding.registryPath);
    if (profiles.filter((p) => p.name === binding.name).length > 1)
      throw new Error(`Ambiguous Claude profile name: ${binding.name}`);
    const original = profiles.find((p) => p.name === binding.name);
    if (original !== undefined) {
      if (
        original.configDir === null ||
        physicalDirectory(original.configDir) !== binding.configDir
      )
        throw new Error(`Claude profile ${binding.name} now points to a different directory`);
    } else {
      const renamed = profiles.some((p) => {
        if (!p.configDir) return false;
        try {
          return realpathSync(p.configDir) === binding.configDir;
        } catch {
          return false;
        }
      });
      if (!renamed)
        throw new Error(
          `Claude profile ${binding.name} is no longer registered at its pinned directory`,
        );
    }
  }
  if (
    binding.accountDigest !== undefined &&
    accountDigest(binding.configDir) !== binding.accountDigest
  )
    throw new Error(`Claude profile ${binding.name} no longer identifies the pinned account`);
}

export function verifySessionProfile(
  m: SessionProfileHost,
  session: Pick<Session, 'agent' | 'dir' | 'envFile' | 'profile'>,
): void {
  const binding = session.profile;
  if (!binding) return;
  if (session.agent === 'antigravity') {
    if (!isAntigravityProfileBinding(binding))
      throw new Error('Antigravity session requires an Antigravity profile binding');
    verifyAntigravityProfile(m, binding);
    return;
  }
  if (session.agent !== 'claude' || !isClaudeProfileBinding(binding))
    throw new Error('Named profiles are available for Claude and Antigravity only');
  verifyClaudeProfile(m, binding);
  const path = envFilePath(session);
  if (!path) return;
  const declared = readEnvFile(path, { ...Bun.env, HOME });
  if (declared.HOME && physicalDirectory(declared.HOME) !== physicalDirectory(HOME))
    throw new Error(`Claude profile ${binding.name} conflicts with HOME in the declared env file`);
  const conflict = CLAUDE_PROFILE_AUTH_ENV.find((key) => declared[key]?.trim());
  if (conflict)
    throw new Error(
      `Claude profile ${binding.name} conflicts with ${conflict} in the declared env file`,
    );
  const dir = declared.CLAUDE_CONFIG_DIR?.trim();
  if (dir && (binding.configDir === null || physicalDirectory(dir) !== binding.configDir))
    throw new Error(
      `Claude profile ${binding.name} conflicts with CLAUDE_CONFIG_DIR in the declared env file`,
    );
}
