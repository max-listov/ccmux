import { once } from 'node:events';

/**
 * Hand a whole answer to stdout and wait until it is gone.
 *
 * `console.log` returns before the bytes are delivered, and a process that ends with bytes still
 * queued loses them at a 64 KiB boundary: the answer arrives cut, at exactly 65536 or 98304 bytes,
 * with exit 0. A consumer cannot tell that from a complete answer except by failing to parse it,
 * which is the worst way to find out — so every command whose output can exceed a pipe buffer
 * writes through here.
 *
 * Measured rather than assumed: a slow reader lost the tail of a `console.log` (and of
 * `Bun.write`) while `write` + `drain` delivered all of it. The trigger that exposed it — a module
 * elsewhere in the graph switching this process to a different stdout stream — has since been fixed
 * upstream, and this stays: waiting for the pipe to drain is what a writer owes a reader that has
 * not caught up, and no command can know how fast its consumer reads.
 */
export async function writeOut(text: string): Promise<void> {
  await writeTo(process.stdout, text);
}

/** The same guarantee for stderr, for the paths that relay a remote answer's diagnostics. */
export async function writeErr(text: string): Promise<void> {
  await writeTo(process.stderr, text);
}

async function writeTo(stream: NodeJS.WriteStream, text: string): Promise<void> {
  if (text === '') return;
  // `write` returning false means the kernel took what it could and the rest is queued; `drain`
  // fires when that queue is empty. A closed reader (`| head`) ends the pipe rather than draining
  // it, and that is an ordinary end to a pipeline, not a failure to report.
  if (!stream.write(text)) await once(stream, 'drain').catch(() => undefined);
}

/** `writeOut` with the newline a line-oriented consumer expects, replacing `console.log`. */
export async function printLine(text: string): Promise<void> {
  await writeOut(`${text}\n`);
}
