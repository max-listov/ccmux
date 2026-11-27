import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileAtomicSync } from 'stitchkit/files';
import { HOME } from '../util/home.ts';

/**
 * One-time move of a machine from the product's previous name to Stitchmux, run before anything
 * else touches the durable directories. REMOVE IN THE RELEASE AFTER THE RENAME — with the window
 * readers marked "rename window" (`managedPeerSource`, `sessionEnv`, the legacy pane option) —
 * per `2026-11-27-rename-ccmux-to-stitchmux.md`.
 *
 * Every step is idempotent and structural: it moves the four XDG directories, renames the files
 * whose names carried the old word, and rewrites only the identifiers that carried it — the
 * `source` of a managed address, the keys built from it, and paths into the moved config directory.
 * Session names and project paths that merely contain the word are data and stay as they are.
 */

const OLD = 'ccmux';
const NEW = 'stitchmux';

export interface RenameRoots {
  readonly legacy: string;
  readonly current: string;
  /**
   * The data root holds only the installed code, which the new install has replaced: an entry
   * present under both names is the previous release's copy and is removed, not reported.
   */
  readonly superseded?: boolean;
}

function xdg(envValue: string | undefined, fallback: string): string {
  return envValue?.startsWith('/') ? envValue : fallback;
}

/** The four roots this machine moves; a root pinned by an explicit override is not touched. */
export function renameRoots(env: NodeJS.ProcessEnv = process.env, home = HOME): RenameRoots[] {
  const roots: RenameRoots[] = [];
  const add = (override: string | undefined, base: string) => {
    if (override !== undefined) return;
    roots.push({ legacy: join(base, OLD), current: join(base, NEW) });
  };
  add(env.STITCHMUX_CONFIG, xdg(env.XDG_CONFIG_HOME, join(home, '.config')));
  add(env.STITCHMUX_STATE_DIR, xdg(env.XDG_STATE_HOME, join(home, '.local', 'state')));
  if (env.STITCHMUX_DATA_DIR === undefined) {
    const base = xdg(env.XDG_DATA_HOME, join(home, '.local', 'share'));
    roots.push({ legacy: join(base, OLD), current: join(base, NEW), superseded: true });
  }
  add(env.STITCHMUX_CACHE_DIR, xdg(env.XDG_CACHE_HOME, join(home, '.cache')));
  return roots;
}

/** The legacy path is the window's link to the new root, not a directory left to move. */
function isBridge(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A legacy root that still holds something of its own. */
const legacyPresent = (root: RenameRoots): boolean =>
  existsSync(root.legacy) && !isBridge(root.legacy);

/**
 * Leave the legacy path as a link to the new root. Supervisors of sessions started before the
 * update run the previous release's code and resolve the previous paths until they restart; through
 * the link they read and write the moved directory instead of recreating an empty one beside it
 * (2026-11-27: the previous daemon did exactly that). Inside a root no path carries the product's
 * name, so the same relative paths meet. A process that recreated the directory first keeps it.
 */
function bridgeRoot(root: RenameRoots): void {
  try {
    symlinkSync(root.current, root.legacy);
  } catch {
    // EEXIST: something recreated the directory between the move and here; it stays as it is.
  }
}

/**
 * Move `legacy` to `current`. When `current` already exists — a process created it before this
 * ran — each entry moves across unless the same name is already there; those stay behind and are
 * reported, and the legacy directory is removed only once it is empty. A moved root that the
 * previous release still resolves is left behind as a link (`bridgeRoot`); the code copy is not.
 */
export function moveRoot(root: RenameRoots): { moved: boolean; conflicts: string[] } {
  if (!legacyPresent(root)) return { moved: false, conflicts: [] };
  if (!existsSync(root.current)) {
    renameSync(root.legacy, root.current);
    if (root.superseded !== true) bridgeRoot(root);
    return { moved: true, conflicts: [] };
  }
  const conflicts: string[] = [];
  for (const entry of readdirSync(root.legacy)) {
    const target = join(root.current, entry);
    if (!existsSync(target)) renameSync(join(root.legacy, entry), target);
    else if (root.superseded === true)
      rmSync(join(root.legacy, entry), { recursive: true, force: true });
    else conflicts.push(entry);
  }
  if (conflicts.length === 0) {
    rmdirSync(root.legacy);
    if (root.superseded !== true) bridgeRoot(root);
  }
  return { moved: true, conflicts };
}

/**
 * Lay the installation down at the new data root while the process still runs from the legacy one.
 *
 * Everything this release points at — its PATH command, the boot unit it converges on every daemon
 * start, `claudeNativeSdk` once `machine.json` is rewritten — names the new root, so a copy must be
 * there before any of them is written; the running bundle itself cannot move. Entries already at the
 * new root are kept. The legacy copy stays until a run from the new location finds it superseded.
 */
export function copyRunningRoot(root: RenameRoots): void {
  mkdirSync(root.current, { recursive: true });
  for (const entry of readdirSync(root.legacy)) {
    const target = join(root.current, entry);
    if (!existsSync(target))
      cpSync(join(root.legacy, entry), target, { recursive: true, verbatimSymlinks: true });
  }
  const app = join(root.current, 'app');
  if (existsSync(app)) renameNamedFiles(app);
}

/** Files whose own name carried the old word: the logs, the declared service's files, the bundle. */
export function renameNamedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const renamed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(`${OLD}.`)) continue;
    const next = `${NEW}.${entry.slice(OLD.length + 1)}`;
    if (existsSync(join(dir, next))) continue;
    renameSync(join(dir, entry), join(dir, next));
    renamed.push(next);
  }
  return renamed;
}

// An unescaped JSON string position: a quote not preceded by a backslash, so the same words inside
// a message body (escaped as \") are never rewritten.
const SOURCE = /(?<!\\)"source"\s*:\s*"ccmux"/g;
const KEY = /(?<!\\)"ccmux:/g;

/** Rewrite the managed-address identifiers in one JSON or JSONL text; null when nothing changed. */
export function rewriteIdentifiers(text: string, configPaths: RenameRoots | null): string | null {
  let next = text.replace(SOURCE, `"source":"${NEW}"`).replace(KEY, `"${NEW}:`);
  if (configPaths !== null)
    next = next.split(`"${configPaths.legacy}/`).join(`"${configPaths.current}/`);
  return next === text ? null : next;
}

/** State files that store managed addresses or keys built from them. */
const STATE_FILES = [
  'chat.jsonl',
  'chat-cursors.json',
  'chat-ack.jsonl',
  'outbox.jsonl',
  'outbox-ack.jsonl',
  'sessions.jsonl',
  join('attachments', 'index.json'),
];

/** Rewrite one file atomically when it holds identifiers to rewrite. */
function rewriteFile(path: string, configPaths: RenameRoots | null): boolean {
  if (!existsSync(path)) return false;
  const next = rewriteIdentifiers(readFileSync(path, 'utf8'), configPaths);
  if (next === null) return false;
  writeFileAtomicSync(path, next, { mode: 0o600 });
  return true;
}

/** `machine.json`: paths into the moved config directory. */
export function rewriteMachineConfig(text: string, configPaths: RenameRoots | null): string | null {
  if (configPaths === null) return null;
  const next = text.split(`"${configPaths.legacy}/`).join(`"${configPaths.current}/`);
  return next === text ? null : next;
}

/**
 * `machine.json`: the previous release's default boot labels and bundle id. Only `install` applies
 * this, together with retiring the previous units: a daemon still started by the previous unit must
 * keep addressing the unit it runs under until then.
 */
export function rewriteBootLabels(text: string): string | null {
  const next = text
    .replace(/"bootLabel"\s*:\s*"com\.ccmux\.daemon"/, '"bootLabel": "com.stitchmux.daemon"')
    .replace(/"bootLabel"\s*:\s*"ccmux\.service"/, '"bootLabel": "stitchmux.service"')
    .replace(/"tmuxBootLabel"\s*:\s*"com\.ccmux\.tmux"/, '"tmuxBootLabel": "com.stitchmux.tmux"')
    .replace(/"macosBundleId"\s*:\s*"com\.ccmux\.app"/, '"macosBundleId": "com.stitchmux.app"');
  return next === text ? null : next;
}

/** Apply `rewriteBootLabels` to the machine file in place; true when it changed. */
export function adoptNewBootLabels(machineFile: string): boolean {
  if (!existsSync(machineFile)) return false;
  const next = rewriteBootLabels(readFileSync(machineFile, 'utf8'));
  if (next === null) return false;
  writeFileAtomicSync(machineFile, next, { mode: 0o600 });
  return true;
}

export interface RenameReport {
  /** Legacy roots left in place because this process runs from inside them. */
  readonly deferred: string[];
  readonly moved: string[];
  readonly conflicts: string[];
  readonly renamed: string[];
  readonly rewritten: string[];
}

/** True while this machine still has the previous release's directories and has not moved them. */
export function renamePending(env: NodeJS.ProcessEnv = process.env, home = HOME): boolean {
  const roots = renameRoots(env, home);
  const state = roots.find((r) => r.current.includes(join('state', NEW)));
  if (state !== undefined && existsSync(join(state.current, '.renamed-from-ccmux'))) return false;
  // A superseded root already copied to its new place is moved: only the copy is left to drop.
  return roots.some(
    (root) => legacyPresent(root) && !(root.superseded === true && existsSync(root.current)),
  );
}

/**
 * Drop the previous release's code copy once this process no longer runs from it, and mark the move
 * finished. Run by the daemon only: it starts from the new location after `stitchmux install`, and
 * until then the boot unit still starts it from the legacy copy, which then stays.
 */
export function retireSupersededRoots(
  env: NodeJS.ProcessEnv = process.env,
  home = HOME,
  runningBundle: string | undefined = Bun.main,
): string[] {
  const roots = renameRoots(env, home);
  const runningFrom = runningBundle ?? '';
  const retired: string[] = [];
  for (const root of roots) {
    if (root.superseded !== true || !legacyPresent(root) || !existsSync(root.current)) continue;
    if (runningFrom.startsWith(`${root.legacy}/`)) return [];
    if (moveRoot(root).conflicts.length === 0) retired.push(root.legacy);
  }
  const state = roots.find((r) => r.current.includes(join('state', NEW)));
  if (
    retired.length > 0 &&
    state !== undefined &&
    existsSync(state.current) &&
    !roots.some(legacyPresent)
  )
    writeFileAtomicSync(join(state.current, '.renamed-from-ccmux'), new Date().toISOString());
  return retired;
}

/**
 * Process ids of running daemons of either name, other than `self`, from `ps -Ao pid=,command=`.
 * `self` holds this process and its parent: on macOS the boot unit starts the daemon through a
 * launcher whose own command line ends in the same words.
 */
export function daemonsOtherThan(self: readonly number[], psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (
      !self.includes(pid) &&
      /(?:^|[\s/])(?:ccmux|stitchmux|cli)\.(?:js|ts) daemon\s*$/.test(match[2] ?? '')
    )
      pids.push(pid);
  }
  return pids;
}

/**
 * Commands that never read or write a machine's state, so they neither wait for the move nor make
 * it. `_attachment-validate` is the image decoder the daemon runs with an EMPTY environment — the
 * operator's real home: from a test suite on a machine still under the previous name, that child
 * moved the live machine's state away from its running daemon (2026-11-27 23:28).
 */
const STATELESS_COMMANDS: ReadonlySet<string> = new Set([
  '_attachment-validate',
  'help',
  '--help',
  '-h',
  'version',
  '--version',
  '-v',
  'completions',
]);

export interface RenameGateDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  /** This process and its parent. */
  readonly self: readonly number[];
  readonly runningBundle: string | undefined;
  /** `ps -Ao pid=,command=`. */
  readonly ps: () => string;
  /** Stop the previous release's daemon unit; `install` only. */
  readonly stopPreviousDaemon: () => Promise<void>;
}

function defaultGateDeps(): RenameGateDeps {
  return {
    env: process.env,
    home: HOME,
    self: [process.pid, process.ppid],
    runningBundle: Bun.main,
    ps: () => Bun.spawnSync(['ps', '-Ao', 'pid=,command=']).stdout.toString(),
    stopPreviousDaemon: async () => {
      const argv =
        process.platform === 'darwin'
          ? [
              'launchctl',
              'bootout',
              `gui/${process.getuid?.() ?? 0}/${PREVIOUS_BOOT_UNITS.launchdDaemon}`,
            ]
          : ['systemctl', 'stop', PREVIOUS_BOOT_UNITS.systemdDaemon];
      await Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' }).exited;
    },
  };
}

/**
 * Who may move a machine's directories, and when. Only the daemon starting — the previous release's
 * daemon is gone, replaced by this one — and `install`, which first stops the previous daemon unit.
 * Either way no other daemon may be running: it would keep writing into directories that move under
 * it. Every other command refuses on a machine that has not moved yet, so a client run from a source
 * checkout beside a live previous release never touches its state (2026-11-27: one did, and the live
 * machine lost its state and its command for an hour). Returns the refusal, or null to go on.
 */
export async function renameGate(
  command: string | undefined,
  deps: RenameGateDeps = defaultGateDeps(),
): Promise<string | null> {
  if (command !== undefined && STATELESS_COMMANDS.has(command)) return null;
  if (!renamePending(deps.env, deps.home)) {
    if (command === 'daemon') retireSupersededRoots(deps.env, deps.home, deps.runningBundle);
    return null;
  }
  if (command !== 'daemon' && command !== 'install')
    return 'this machine still keeps its state under the previous name (ccmux); the daemon moves it when it starts, or run: stitchmux install';
  if (command === 'install') await deps.stopPreviousDaemon();
  const others = daemonsOtherThan(deps.self, deps.ps());
  if (others.length > 0)
    return `a daemon (pid ${others.join(', ')}) still uses this machine's state under the previous name — stop it, then run again`;
  const report = migrateFromCcmux(deps.env, deps.home, deps.runningBundle);
  if (report !== null && report.conflicts.length > 0)
    return `moving from the previous name left entries that exist in both places: ${report.conflicts.join(', ')} — resolve them, then run again`;
  return null;
}

/** Run the whole move once; a marker in the state directory makes later runs free. */
export function migrateFromCcmux(
  env: NodeJS.ProcessEnv = process.env,
  home = HOME,
  runningBundle: string | undefined = Bun.main,
): RenameReport | null {
  const roots = renameRoots(env, home);
  const config = roots.find((r) => r.current.endsWith(join('.config', NEW))) ?? null;
  const state = roots.find((r) => r.current.includes(join('state', NEW))) ?? null;
  const stateDir = state?.current ?? env.STITCHMUX_STATE_DIR;
  if (stateDir !== undefined && existsSync(join(stateDir, '.renamed-from-ccmux'))) return null;
  if (!roots.some(legacyPresent)) return null;

  const report: RenameReport = {
    deferred: [],
    moved: [],
    conflicts: [],
    renamed: [],
    rewritten: [],
  };
  // The bundle this process runs from, and the boot unit that starts it, may still sit in the
  // legacy data directory: moving it now would pull the code out from under the boot unit's next
  // start. It is copied instead, and the legacy copy goes when a run from the new location — after
  // `stitchmux install` — finds it superseded.
  const runningFrom = runningBundle ?? '';
  for (const root of roots) {
    if (runningFrom.startsWith(`${root.legacy}/`)) {
      copyRunningRoot(root);
      report.deferred.push(root.legacy);
      continue;
    }
    const moved = moveRoot(root);
    if (moved.moved) report.moved.push(root.current);
    for (const entry of moved.conflicts) report.conflicts.push(join(root.legacy, entry));
  }
  if (state !== null) report.renamed.push(...renameNamedFiles(state.current));
  if (config !== null) {
    report.renamed.push(...renameNamedFiles(join(config.current, 'services')));
    const machine = join(config.current, 'machine.json');
    if (existsSync(machine)) {
      const next = rewriteMachineConfig(readFileSync(machine, 'utf8'), config);
      if (next !== null) {
        writeFileAtomicSync(machine, next, { mode: 0o600 });
        report.rewritten.push(machine);
      }
    }
  }
  if (state !== null)
    for (const file of STATE_FILES)
      if (rewriteFile(join(state.current, file), config))
        report.rewritten.push(join(state.current, file));
  if (state !== null && report.conflicts.length === 0 && report.deferred.length === 0) {
    mkdirSync(state.current, { recursive: true });
    writeFileAtomicSync(join(state.current, '.renamed-from-ccmux'), new Date().toISOString());
  }
  return report;
}

/**
 * Rename window: a peer still on the previous release names the product `ccmux` in every principal
 * it sends. Read such a value as `stitchmux` at the two doors another machine's calls come through —
 * a letter (`_chat-receive-v2`) and a forwarded operation (`_peer-operation`). REMOVE with this module.
 */
export function adoptPreviousSource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adoptPreviousSource);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = key === 'source' && item === OLD ? NEW : adoptPreviousSource(item);
  return out;
}

/**
 * Rename window: a session started before the release carries the previous `CCMUX_*` variables, and
 * its hooks and status line run this CLI with them. Read each as its `STITCHMUX_*` counterpart when
 * that one is absent. REMOVE with this module.
 */
export function adoptPreviousEnv(env: NodeJS.ProcessEnv = process.env, home = HOME): void {
  // The previous boot unit sets its config path explicitly. Carried over, the default legacy path
  // would pin the new release to the old directory and keep it from moving; it is dropped instead,
  // and the new default applies. An operator's own override is carried over unchanged.
  const legacyDefaults = new Set(
    renameRoots({}, home).flatMap((r) => [r.legacy, join(r.legacy, 'machine.json')]),
  );
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('CCMUX_') || value === undefined) continue;
    if (legacyDefaults.has(value)) continue;
    const next = `STITCHMUX_${key.slice('CCMUX_'.length)}`;
    if (env[next] === undefined) env[next] = value;
  }
}

/**
 * The name this program reports with its version.
 *
 * The previous release's updater checks a candidate before it replaces itself: it runs
 * `<candidate> version`, strips only a leading `ccmux`, and compares the rest with the release's
 * number — so `stitchmux 0.96.0` failed it and no machine could take the release (0.96.0's canary).
 * It writes that candidate beside its own bundle as `.ccmux.js.candidate-<hex>.js` and runs the
 * installed one as `ccmux.js`; run from such a file this program answers under the old name.
 */
export function reportedName(main: string = Bun.main): string {
  return /(?:^|\.)ccmux\.js(?:\.|$)/.test(basename(main)) ? 'ccmux' : 'stitchmux';
}

/**
 * The command the previous release installed. Sessions started before the update run with prompts
 * that call it, and machines still on the previous release call it over the fleet; for this release
 * it runs this installation (`bridgePreviousCommand`).
 */
export const PREVIOUS_COMMAND = join(HOME, '.local', 'bin', 'ccmux');

/** The boot units the previous release installed, which the first install of this one retires. */
export const PREVIOUS_BOOT_UNITS = {
  launchdDaemon: 'com.ccmux.daemon',
  launchdTmux: 'com.ccmux.tmux',
  systemdDaemon: 'ccmux.service',
} as const;
