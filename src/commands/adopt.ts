import { describeWriter } from '../agent/claude/writers.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { loadMachineConfig } from '../config/machine.ts';
import {
  adoptCodexExternal,
  adoptSession,
  findTranscript,
  forkAdopt,
  forkCodexExternal,
  LiveWritersError,
  takeoverAdopt,
  takeoverCodexExternal,
} from '../session/adopt.ts';
import { parseFlags } from './flags.ts';

export async function cmdAdopt(args: string[]): Promise<number> {
  const flags = parseFlags('adopt', args, [2, 3]);
  const providerResult = AgentKindSchema.safeParse(flags.positionals[0]);
  const uuid = flags.positionals[1] as string;
  if (
    !providerResult.success ||
    !uuid ||
    (providerResult.data !== 'claude' && providerResult.data !== 'codex')
  ) {
    console.log(
      'usage: ccmux adopt <claude|codex> <uuid> [name] [--fork | --takeover --confirm-writer <pid>]',
    );
    return 1;
  }
  const provider = providerResult.data;
  const fork = flags.bool('fork');
  const takeover = flags.bool('takeover');
  if (fork && takeover) {
    console.log('adopt: choose exactly one of --fork or --takeover');
    return 1;
  }
  const confirmedPid = flags.int('confirm-writer') ?? null;
  const name = flags.positionals[2];
  const m = loadMachineConfig();
  if (provider === 'codex') {
    try {
      const managed = fork
        ? await forkCodexExternal(m, uuid, name)
        : takeover
          ? Number.isInteger(confirmedPid) && confirmedPid !== null && confirmedPid > 1
            ? await takeoverCodexExternal(m, uuid, confirmedPid, name)
            : (() => {
                throw new Error(
                  '--takeover requires --confirm-writer <pid> from the current inventory',
                );
              })()
          : await adoptCodexExternal(m, uuid, name);
      console.log(
        `${fork ? 'forked' : takeover ? 'took over' : 'adopted'} Codex ${uuid.slice(0, 8)} as '${managed}'`,
      );
      return 0;
    } catch (error) {
      console.log(`adopt: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const t = findTranscript(m, uuid);
  if (!t) {
    console.log(`adopt: no transcript found for ${uuid} under ${m.projectsDir}`);
    return 1;
  }
  try {
    if (fork) {
      const managed = await forkAdopt(m, uuid, name);
      console.log(
        `forked ${uuid.slice(0, 8)} as '${managed}' (new uuid, original untouched) — resumed in ccmux tmux.`,
      );
      return 0;
    }
    if (takeover) {
      const managed = await takeoverAdopt(m, t.dir, uuid, name);
      console.log(
        `took over ${uuid.slice(0, 8)} as '${managed}' — previous writer(s) stopped, resumed in ccmux tmux.`,
      );
      console.log(
        'note: a supervised writer (desktop app) may respawn — if the fork returns, close it at the source.',
      );
      return 0;
    }
    const managed = await adoptSession(m, t.dir, uuid, name);
    console.log(
      `adopted ${uuid.slice(0, 8)} as '${managed}' (dir ${t.dir}) — resumed in ccmux tmux.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof LiveWritersError) {
      console.log(
        `adopt: ${uuid.slice(0, 8)} is LIVE — ${e.writers.map(describeWriter).join(', ')}.`,
      );
      console.log('a second resume would fork the conversation. choose explicitly:');
      console.log(
        `  ccmux adopt claude ${uuid} --fork      # safe: copy under a new uuid, original untouched`,
      );
      console.log(
        `  ccmux adopt claude ${uuid} --takeover  # kill the writer(s), then adopt the original`,
      );
      return 1;
    }
    console.log(`adopt: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
