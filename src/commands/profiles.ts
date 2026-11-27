import { namedClaudeProfiles, selectClaudeProfile } from '../agent/claude/namedProfiles.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { profileAuthStatus } from '../quota/probe.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { parseFlags } from './flags.ts';

export async function cmdProfiles(args: string[]): Promise<number> {
  const flags = parseFlags('profiles', args, [1, 1]);
  if ((flags.str('agent') ?? 'claude') !== 'claude')
    throw new Error('Named profiles are available for Claude only');
  const m = loadMachineConfig();
  const action = flags.positionals[0];
  const name = flags.str('profile');
  if (action === 'list' && name === undefined) {
    const profiles = namedClaudeProfiles(m).map(({ name, source, configDir }) => ({
      name,
      source,
      configDir,
    }));
    if (flags.bool('json')) await printLine(JSON.stringify(profiles));
    else
      for (const line of tableLines(
        ['PROFILE', 'SOURCE', 'CONFIG DIRECTORY'],
        profiles.map((p) => [p.name, p.source, p.configDir ?? '(implicit)']),
      ))
        console.log(line);
    return 0;
  }
  if (action !== 'doctor' || name === undefined)
    throw new Error('Use profiles list or profiles doctor --profile NAME');
  const profile = selectClaudeProfile(m, 'claude', name);
  const result = await profileAuthStatus(m, profile.configDir);
  const loggedIn = result.ok ? result.status.loggedIn : null;
  const authMethod = result.ok ? (result.status.authMethod ?? null) : null;
  const error = result.ok ? null : result.error;
  if (flags.bool('json'))
    await printLine(JSON.stringify({ name, source: profile.source, loggedIn, authMethod, error }));
  else
    console.log(
      `${name}: ${error ?? (loggedIn ? `signed in (${authMethod ?? 'unknown method'})` : 'signed out')}`,
    );
  return loggedIn === true ? 0 : 1;
}
