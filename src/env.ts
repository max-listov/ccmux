import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const compiled = basename(exec).toLowerCase() !== 'bun';
  if (compiled) return [exec]; // single-file compiled binary
  // Running under bun. This module is either src/env.ts (dev → entry is cli.ts beside it)
  // or it's been bundled into the single prod file (→ that file IS the entry to re-exec).
  const self = fileURLToPath(import.meta.url);
  const entry = basename(self) === 'env.ts' ? join(dirname(self), 'cli.ts') : self;
  return [exec, entry];
}

export const SELF_ARGV: readonly string[] = resolveSelfArgv();

/**
 * The same re-exec, with the runtime told NOT to load `.env` from wherever it lands.
 *
 * Used for the `_run` pane, whose cwd IS the session's directory. Without it the runtime loads that
 * directory's env files into the supervisor, and everything the supervisor hands to the agent — and
 * that the agent hands to every process it spawns — carries the project's secrets, undeclared.
 * Measured before this existed: 5 of 14 sessions on one machine were carrying project variables,
 * API keys among them.
 *
 * It only applies to the `bun <entry>` form, which is what production runs. A `bun build --compile`
 * binary never sees the flag — it lands in the app's argv, not the runtime's, and no environment
 * variable or bunfig substitutes for it (all four candidates probed). That is precisely why
 * `agent/sessionEnv.ts` subtracts those names again when building the agent's environment: the
 * guarantee must not rest on a flag one build shape silently ignores.
 */
export function withNoEnvFile(argv: readonly string[]): readonly string[] {
  // A compiled single-file build is `[binary]` with no runtime in front of it, and the flag would
  // land in the app's own argv — accepted, ignored, and quietly misleading. Left alone there on
  // purpose: `agent/sessionEnv.ts` is what holds the guarantee in that shape.
  return argv.length > 1 ? [argv[0] as string, '--no-env-file', ...argv.slice(1)] : argv;
}

export const SELF_ARGV_NO_ENV_FILE: readonly string[] = withNoEnvFile(SELF_ARGV);
/** Absolute, always-spawnable invocation of THIS tool (bun+bundle / compiled binary). Correct
 *  for machine re-execs — the `_run` supervisor, the boot unit, the detached restart-worker —
 *  which must not depend on any PATH. NOT what we teach an in-session agent (see below). */
export const SELF_DISPLAY: string = SELF_ARGV.join(' ');

/** Fixed install location of the `ccmux` PATH shim (`scripts/install.sh` → `~/.local/bin/ccmux`,
 *  a 2-line `exec bun <bundle>`). Kept in sync with that installer by convention. */
export const SHIM_PATH = join(HOME, '.local', 'bin', 'ccmux');

/** The shim points at the DEFAULT cache's bundle, so an isolated instance — which has its own
 *  cache — must not teach that shim: it would run the wrong code and the wrong config. */
const DEFAULT_CACHE_DIR = join(HOME, '.cache', 'ccmux');

/** Decide which form to teach: bare `ccmux` when the shim is installed, else the absolute
 *  invocation. Pure — separated from the filesystem check so it's unit-testable. */
export function pickInvocation(shimInstalled: boolean, absolute: string): string {
  return shimInstalled ? 'ccmux' : absolute;
}

/**
 * The ccmux invocation to teach an in-session agent (injected prompt). Prefer the bare
 * `ccmux` shim so fleet agents call it cleanly, instead of copying an absolute path prefix
 * into every command — the crutch `workflow.md §13` forbids. The shim's presence is checked
 * by its FIXED install path, NOT the daemon's own PATH: the prompt is built in the daemon
 * process (thin launchd/systemd PATH that may not see the shim), while the child session runs
 * with an aligned login PATH that does. Falls back to the absolute invocation only when the
 * shim isn't installed (fresh machine before bootstrap, or the bundle was run directly).
 */
export function promptInvocation(): string {
  // An isolated instance (its own cache) must teach its OWN re-exec, not the shared shim — that
  // shim runs the default cache's bundle, i.e. the wrong code and config for a dev instance.
  const onDefaultCache = (process.env.CCMUX_CACHE_DIR ?? DEFAULT_CACHE_DIR) === DEFAULT_CACHE_DIR;
  return pickInvocation(onDefaultCache && existsSync(SHIM_PATH), SELF_DISPLAY);
}

/** Running from live source (`ccmux-dev` → bun src/cli.ts) vs the frozen prod bundle/binary.
 *  Source modules are `.ts`; the prod bundle is a single `.js` (compiled binary is neither).
 *  Used to badge the TUI header so dev is never confused with prod at the same version. */
export const IS_DEV: boolean = fileURLToPath(import.meta.url).endsWith('.ts');
