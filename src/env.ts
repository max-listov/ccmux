import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

export const PLATFORM = process.platform; // "darwin" | "linux"
export const UID = process.getuid?.() ?? 0;
export const HOME = homedir(); // never $HOME string-parse

/**
 * A spawnable invocation of THIS tool as an argv prefix — prepend a verb to re-exec
 * ccmux (used by the tmux `_run` pane command and the injected prompt's <SELF>).
 *
 * P0-11: inside a `bun build --compile` binary, `import.meta.url` resolves to a
 * virtual bunfs path that is NOT a spawnable file. `process.execPath` IS the on-disk
 * executable there, so it's the correct primary. In dev (`bun run src/cli.ts`),
 * `process.execPath` is the `bun` binary, so we must re-exec as `bun <cli.ts>`.
 */
function resolveSelfArgv(): string[] {
  const exec = process.execPath;
  const compiled = basename(exec).toLowerCase() !== "bun";
  if (compiled) return [exec]; // single-file compiled binary
  // Running under bun. This module is either src/env.ts (dev → entry is cli.ts beside it)
  // or it's been bundled into the single prod file (→ that file IS the entry to re-exec).
  const self = fileURLToPath(import.meta.url);
  const entry = basename(self) === "env.ts" ? join(dirname(self), "cli.ts") : self;
  return [exec, entry];
}

export const SELF_ARGV: readonly string[] = resolveSelfArgv();
/** Human/shell-readable form for the injected prompt text. */
export const SELF_DISPLAY: string = SELF_ARGV.join(" ");

/** Running from live source (`ccmux-dev` → bun src/cli.ts) vs the frozen prod bundle/binary.
 *  Source modules are `.ts`; the prod bundle is a single `.js` (compiled binary is neither).
 *  Used to badge the TUI header so dev is never confused with prod at the same version. */
export const IS_DEV: boolean = fileURLToPath(import.meta.url).endsWith(".ts");
