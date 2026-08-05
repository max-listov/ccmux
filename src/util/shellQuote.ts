/**
 * POSIX single-quote a string for a REMOTE shell.
 *
 * Everything else in ccmux launches processes as an argv array precisely so there is no shell and
 * nothing to quote (see util/spawn.ts). `ssh` is the one unavoidable exception: it joins its
 * arguments with spaces and hands the result to the remote login shell, so every value we send —
 * session name, task label, a `--then` note — is shell source on the far side. Session names legally
 * contain `;`, `$`, backticks and parens, so interpolating one raw would be a remote command
 * injection, not merely a quoting bug.
 *
 * Single quotes disable ALL interpretation in POSIX shells; the only character that cannot appear
 * inside them is `'` itself, which is closed, escaped and reopened (`'\''`). Newlines survive as-is.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Quote a whole argv into one remote command string. */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
