import { findSession, loadSessions } from '../config/sessions.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { readRuntimeDiagnostics } from '../runtime/diagnostics.ts';
import { capturePane, hasSession } from '../tmux/tmux.ts';

export async function cmdLogs(name: string | undefined, args: string[]): Promise<number> {
  if (!name) {
    console.log(
      'usage: ccmux logs <name> [lines] [--json]   ·   <machine>:<name> for another fleet machine',
    );
    return 1;
  }
  const fwd = await forwardIfRemote(name, 'logs', args);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  // A name this machine does not have is a miss by address, not an empty capture: "nothing to
  // capture" is true of a stopped session and false of a typo, and both exited zero.
  if (!findSession(loadSessions(m), name)) {
    console.error(`unknown session: ${name}`);
    return 1;
  }
  const json = args.includes('--json');
  const lineArg = args.find((a) => /^\d+$/.test(a));
  const lines = lineArg ? Number.parseInt(lineArg, 10) : 100;
  // A session whose runtime failed has no pane left to capture, and that is exactly the moment its
  // logs are asked for. Printing nothing then answers "the pane was empty" to the question "why did
  // this die" — two facts that look identical and mean opposite things. The recorded diagnostic is
  // the answer, it is on this machine already, and until now nothing could reach it: the files are
  // named by a hash of session and stage, and the stage was never printed anywhere.
  const alive = await hasSession(m, name);
  const text = alive ? await capturePane(m, name, lines) : '';
  const diagnostics = alive
    ? { matched: [], unattributed: 0 }
    : await readRuntimeDiagnostics(m, name);
  if (json) {
    console.log(
      JSON.stringify({
        session: name,
        capturedAt: new Date().toISOString(),
        lines,
        running: alive,
        text,
        diagnostics: diagnostics.matched,
        unattributedDiagnostics: diagnostics.unattributed,
      }),
    );
    return 0;
  }
  if (alive) {
    process.stdout.write(text);
    return 0;
  }
  process.stdout.write(`${name} has no live pane — nothing to capture.\n`);
  if (diagnostics.matched.length === 0) {
    process.stdout.write(
      diagnostics.unattributed === 0
        ? 'No runtime diagnostic was recorded for it.\n'
        : `No runtime diagnostic names it. ${diagnostics.unattributed} were recorded before the session name was stored; which session each belongs to is not recoverable.\n`,
    );
    return 0;
  }
  for (const entry of diagnostics.matched) {
    process.stdout.write(`\n${entry.at} · ${entry.stage}\n${entry.detail.trimEnd()}\n`);
    if (entry.stderr !== null && entry.stderr.trim() !== '')
      process.stdout.write(`stderr:\n${entry.stderr.trimEnd()}\n`);
  }
  return 0;
}
