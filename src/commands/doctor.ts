import { escalationRefusal } from '../agent/claude/launch.ts';
import { STALLED_HOLD_MS } from '../chat/holdReason.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { printLine } from '../util/stdout.ts';
import { buildDoctorReport, type DoctorReport, sampleNames } from './doctorChecks.ts';
import { parseFlags } from './flags.ts';

/** `ccmux doctor`: one report, rendered as JSON or as text — never two sets of checks. */
export async function cmdDoctor(args: string[]): Promise<number> {
  const flags = parseFlags('doctor', args, [0, 0]);
  const report = await buildDoctorReport(loadMachineConfig());
  if (flags.bool('json')) await printLine(JSON.stringify(report));
  else for (const line of doctorText(report)) console.log(line);
  return 0;
}

/** The human rendering of a report. Every line is derived from the report; nothing is checked here. */
export function doctorText(r: DoctorReport): string[] {
  const out: string[] = [];
  const say = (line: string) => out.push(line);
  say(`ccmux ${r.version}`);
  say(`self:       ${r.self}`);
  say(`agent cli:  ${r.promptInvocation}`);
  // The three roots, named, because "where does this thing keep its files" used to be answerable
  // only by hunting through a home directory — and the answer differed per machine.
  say(`config:     ${r.configFile}`);
  say(`state:      ${r.stateDir}`);
  say(`code:       ${r.dataDir}`);
  say(`cache:      ${r.cacheDir}`);
  say(`rc prefix:  ${r.rcPrefix}`);
  say(`boot label: ${r.bootLabel}`);
  say(`claude: ${r.bins.claude} (${r.deps.claude ? 'ok' : 'missing'})`);
  say(
    `codex:  ${r.bins.codex ?? '—'} (${r.bins.codex ? (r.deps.codex ? 'ok' : 'missing') : 'not set'})`,
  );
  say(`tmux:   ${r.bins.tmux} (${r.deps.tmux ? 'ok' : 'missing'})`);
  if (r.fleet.length > 0) {
    say('fleet:');
    for (const c of r.fleet) {
      const mark = c.ok ? 'ok' : c.reachable ? 'PROBLEM' : 'unreachable';
      const route = c.via === 'remote' ? 'via remote adapter' : `→ ${c.alias}`;
      say(`  ${c.machine} ${route} (${mark})${c.ok ? '' : ` — ${c.detail}`}`);
    }
    if (r.fleetSelfLabelled)
      say(
        `  PROBLEM — '${r.rcPrefix}' is this machine's own rcPrefix, so '${r.rcPrefix}:<session>' always resolves LOCALLY and that entry is dead. Give each machine a distinct rcPrefix.`,
      );
  }
  if (r.remoteTransport !== null)
    say(
      `remote: ${r.remoteTransport.ready ? `adapter socket ${r.remoteTransport.socket}` : `PROBLEM — no adapter socket at ${r.remoteTransport.socket}`}`,
    );
  if (r.unhonourableModes.length > 0) {
    say(`perms:  PROBLEM — configured but impossible here: ${r.unhonourableModes.join(', ')}`);
    say(`        ${escalationRefusal('bypassPermissions', true) ?? ''}`);
  }
  if (r.mutedChat.length > 0) {
    say(
      `chat:   PROBLEM — ${r.mutedChat.length} session(s) can receive but NOT send (started before the send capability existed): ${r.mutedChat.join(', ')}`,
    );
    say(`        fix: ccmux restart ${r.mutedChat[0]}   (the capability is handed out at launch)`);
  }
  // Mail that is held rather than delivered is invisible from the sending side by construction: the
  // send succeeded, and everything after that happens on this machine. A stall therefore has to be
  // findable HERE, or it is findable nowhere.
  const stuck = r.chat.stalled ?? [];
  if (stuck.length > 0) {
    say(
      `chat:   ${stuck.length} message(s) held longer than ${Math.round(STALLED_HOLD_MS / 60_000)} minutes and not delivered:`,
    );
    for (const s of stuck) say(`        ${s.session} — ${s.reason}`);
    say(
      '        the mail is not lost; nothing will move it until that condition clears. See: ccmux inbox <session>',
    );
  }
  for (const problem of r.chat.problems) say(`chat:   PROBLEM — ${problem}`);
  // A skipped record must be VISIBLE somewhere prominent: an append-only history that quietly looks
  // shorter than it is has stopped being one.
  if ((r.chat.unreadableRecords ?? 0) > 0) {
    say(
      `chat:   ${r.chat.unreadableRecords} ledger record(s) this ccmux cannot read — written by a newer build.`,
    );
    say(
      '        Not an error and nothing is lost: they are stepped over, their positions kept, and this machine reads them once it is upgraded.',
    );
  }
  if (r.launchInputs.length > 0) {
    say('inputs: what shapes a session besides argv (hashed; a change here shows in RESTART)');
    for (const o of r.launchInputs) {
      const spread = o.variants > 1 ? `, ${o.variants} distinct configurations, e.g.` : ' —';
      say(`        ${o.reason.padEnd(6)} ${o.sessions} session(s)${spread} ${o.example}`);
    }
  }
  const stillInheriting = r.sessionEnv.filter((o) => o.kind === 'inherited');
  const declaredEnv = r.sessionEnv.filter((o) => o.kind === 'declared');
  if (declaredEnv.length > 0) {
    say(`env:    ${declaredEnv.length} session(s) declare an env file:`);
    for (const o of declaredEnv) {
      const note = o.missing
        ? ' — MISSING; the session starts without it'
        : o.drifted
          ? ' — file changed since launch, restart to pick it up'
          : '';
      say(`        ${o.name} — ${o.keys.length} name(s) from ${o.paths.join(', ')}${note}`);
    }
  }
  if (stillInheriting.length > 0) {
    // A PROBLEM because it is one, and a FINITE one: these are sessions started before the recipe
    // shipped. Naming the exact command to end it is the difference between a report and a chore.
    say(
      `env:    PROBLEM — ${stillInheriting.length} session(s) still run on an UNDECLARED env file from their own directory:`,
    );
    for (const o of stillInheriting) {
      say(
        `        ${o.name} — ${o.keys.length} name(s) from ${o.paths.join(', ')}${o.drifted ? ' (file changed since launch — the session still has the old values)' : ''}`,
      );
      if (o.keys.length > 0) say(`          ${sampleNames(o.keys)}`);
    }
    say(
      '        These were started before the environment became a declared recipe: the runtime loaded those files',
    );
    say(
      '        into the supervisor and the launcher passed them to the agent — and to every process it spawns.',
    );
    say('        A restart now would take them away, so declare them first if they are needed:');
    say('        fix: ccmux env-file --adopt --dry-run   (then without --dry-run, then restart)');
    say('        Names only are shown here; values are never read into any diagnostic.');
  }
  if (r.atPrompt === null)
    say('prompt: unknown — tmux could not be asked which sessions sit at a menu');
  else if (r.atPrompt.length > 0) {
    say(
      `prompt: PROBLEM — ${r.atPrompt.length} session(s) sitting at a menu, unable to act until it is answered:`,
    );
    for (const w of r.atPrompt) say(`        ${w.name} — ${w.question}`);
    say(
      "        These read as 'idle' to every other signal. Answer in the pane, or set trustPrompt in machine.json so the supervisor answers the ones it is allowed to.",
    );
  }
  if (!r.bundle.present) {
    say(
      `bundle: PROBLEM — nothing at ${r.bundle.path}, which is what the boot unit and the 'ccmux' shim both launch.`,
    );
    say(
      '        A running daemon serves from memory, so the fleet looks healthy until something restarts it.',
    );
    say(
      '        fix: ccmux update   (restores it), or reinstall: curl -fsSL <releaseUrl>/../install.sh | bash',
    );
  }
  say(`daemon: ${r.daemon.state}${r.daemon.manager ? ` (${r.daemon.manager})` : ''}`);
  return out;
}
