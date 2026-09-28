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
export function writeOut(text: string): Promise<boolean> {
  return writeTo(process.stdout, text);
}

/** The same guarantee for stderr, for the paths that relay a remote answer's diagnostics. */
export function writeErr(text: string): Promise<boolean> {
  return writeTo(process.stderr, text);
}

/**
 * Write and wait for the queue to empty; false when the reader is gone.
 *
 * `write` returning false means the kernel took what it could and the rest is queued; `drain`
 * fires when that queue is empty. A closed reader (`| head`, a caller that stopped reading) ends
 * the pipe instead: the first write fails with EPIPE and every later one returns false on a stream
 * that will never drain and never report the error again. Waiting for `drain` there waited forever
 * while the runtime kept retrying the queued bytes — a `fleet` whose caller had finished spun a core
 * for hours. So a stream that errored, closed or was destroyed is a reader that left, which is an
 * ordinary end to a pipeline: nothing more is written and the caller is told.
 */
export async function writeTo(stream: NodeJS.WritableStream, text: string): Promise<boolean> {
  const gone = (): boolean => {
    const s = stream as NodeJS.WriteStream;
    return s.destroyed || s.errored != null || s.writableEnded;
  };
  if (gone()) return false;
  if (text === '') return true;
  if (stream.write(text)) return true;
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      stream.off('drain', settle);
      stream.off('error', settle);
      stream.off('close', settle);
      resolve();
    };
    stream.once('drain', settle);
    stream.once('error', settle);
    stream.once('close', settle);
    // The failure may already have happened inside `write`, before these listeners existed.
    if (gone()) settle();
  });
  return !gone();
}

/** `writeOut` with the newline a line-oriented consumer expects, replacing `console.log`. */
export function printLine(text: string): Promise<boolean> {
  return writeOut(`${text}\n`);
}
