import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { claudeProfile } from '../../agent/claude/profileRoot.ts';
import { codexProfile } from '../../agent/codex/profileRoot.ts';
import { expandHome } from '../../agent/launch/launchInputs.ts';
import { isDescendantProcess, type ProcessSnapshot } from '../../external/processes.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { HOME } from '../../util/home.ts';

/**
 * Fail-closed TUI process-tree classifier for idle sleep.
 *
 * Interactive Claude/Codex panes routinely hold stdio MCP server children (often launched through
 * `bunx`/`npx`/`uvx` into a `node`/`bun`/`python` child process). Rejecting every descendant would
 * block 100% of sessions with MCP servers, while allowing every `node`/`bun` child would kill real
 * user builds and dev servers. We therefore match descendants against the session's DECLARED stdio
 * MCP specs (command + args only, never secrets) and reject shells, pgid-orphans, and all unknown
 * processes.
 */

export interface DeclaredMcpSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash']);
const GENERIC_RUNTIMES = new Set(['node', 'bun', 'python', 'python3', 'deno', 'uv']);
const LAUNCHER_NAMES = new Set(['bunx', 'npx', 'pnpx', 'uvx']);
const LAUNCHER_RUNTIMES = new Set([
  'node',
  'bun',
  'python',
  'python3',
  'uv',
  'deno',
  'bunx',
  'npx',
  'pnpx',
  'uvx',
]);
const LAUNCHER_CACHE_MARKERS = ['.bunx-', '_npx', 'uv/cache', '.cache/uv', 'pnpm/dlx'];
const LAUNCHER_VALUE_FLAGS = new Set([
  '--python',
  '-C',
  '--cwd',
  '--directory',
  '--registry',
  '--index-url',
  '--extra-index-url',
  '--with',
]);
const SUPERVISOR_TMUX_SUBCOMMANDS = new Set([
  'capture-pane',
  'display-message',
  'list-panes',
  'set-option',
  'show-option',
  'show-options',
]);

function expandPath(raw: string, home = HOME): string {
  if (home === HOME) return expandHome(raw);
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

function tryReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectStdioServerMap(raw: unknown, out: DeclaredMcpSpec[]): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const type = obj.type;
    if (type !== undefined && type !== 'stdio') continue;
    if (obj.enabled === false) continue;
    const command = obj.command;
    if (typeof command !== 'string' || command.trim() === '') continue;
    const args = Array.isArray(obj.args)
      ? obj.args.filter((item): item is string => typeof item === 'string')
      : [];
    out.push({ name, command: command.trim(), args });
  }
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function scanMcpJsonDir(dir: string, out: DeclaredMcpSpec[], depth: number): void {
  if (depth > 3 || !existsSync(dir)) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === '.mcp.json') {
      const json = tryReadJson(full);
      if (json !== null) collectStdioServerMap(json.mcpServers ?? json, out);
      continue;
    }
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      scanMcpJsonDir(full, out, depth + 1);
    }
  }
}

function enabledPluginKeys(userDir: string): Set<string> | null {
  const settings = tryReadJson(join(userDir, 'settings.json'));
  const enabledMap = settings?.enabledPlugins;
  if (enabledMap === null || typeof enabledMap !== 'object' || Array.isArray(enabledMap)) {
    return null;
  }
  const enabled = new Set<string>();
  for (const [pluginKey, active] of Object.entries(enabledMap as Record<string, unknown>)) {
    if (active === true) enabled.add(pluginKey);
  }
  return enabled;
}

function collectClaudePluginMcpSpecs(userDir: string, out: DeclaredMcpSpec[]): void {
  const pluginsRoot = join(userDir, 'plugins');
  if (!existsSync(pluginsRoot)) return;
  const enabled = enabledPluginKeys(userDir);
  if (enabled === null || enabled.size === 0) return;

  // Prefer Claude's installed_plugins.json manifest (exact installPath per enabled plugin).
  const installed = tryReadJson(join(pluginsRoot, 'installed_plugins.json'));
  const pluginsMap =
    installed?.plugins !== null &&
    typeof installed?.plugins === 'object' &&
    !Array.isArray(installed?.plugins)
      ? (installed.plugins as Record<string, unknown>)
      : null;

  const scannedPaths = new Set<string>();
  if (pluginsMap !== null) {
    for (const key of enabled) {
      const records = pluginsMap[key];
      const list = Array.isArray(records) ? records : records ? [records] : [];
      for (const rec of list) {
        if (rec === null || typeof rec !== 'object') continue;
        const installPath = (rec as Record<string, unknown>).installPath;
        if (typeof installPath !== 'string' || installPath.trim() === '') continue;
        const resolved = tryRealpath(installPath);
        if (scannedPaths.has(resolved)) continue;
        scannedPaths.add(resolved);
        scanMcpJsonDir(resolved, out, 0);
      }
    }
    return;
  }

  // Fallback when installed_plugins.json is absent: match enabled `<plugin>@<marketplace>` dirs in cache/.
  const cacheRoot = join(pluginsRoot, 'cache');
  for (const key of enabled) {
    const [pluginName, marketplace] = key.split('@');
    if (!pluginName) continue;
    const candidate = marketplace
      ? join(cacheRoot, marketplace, pluginName)
      : join(cacheRoot, pluginName);
    if (existsSync(candidate)) scanMcpJsonDir(candidate, out, 0);
  }
}

/** Load declared stdio MCP specs (command + args only; never reads env/secrets). */
export function loadDeclaredMcpSpecs(
  session: Pick<Session, 'agent' | 'dir' | 'envFile'>,
  m: Pick<MachineConfig, 'projectsDir' | 'codexHome' | 'codexSessionsDir'>,
  home = HOME,
): DeclaredMcpSpec[] {
  const specs: DeclaredMcpSpec[] = [];
  if (session.agent === 'claude') {
    const profile = claudeProfile(session, m);
    const globalConfigFile = expandPath(profile.globalConfigFile, home);
    const userDir = expandPath(profile.userDir, home);
    const globalCfg = tryReadJson(globalConfigFile);
    if (globalCfg !== null) {
      collectStdioServerMap(globalCfg.mcpServers, specs);
      const projects = globalCfg.projects;
      if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
        const projectMap = projects as Record<string, unknown>;
        const candidates = new Set([session.dir, tryRealpath(session.dir)]);
        for (const dirKey of candidates) {
          const proj = projectMap[dirKey];
          if (proj !== null && typeof proj === 'object' && !Array.isArray(proj)) {
            collectStdioServerMap((proj as Record<string, unknown>).mcpServers, specs);
          }
        }
      }
    }
    const workspaceMcp = tryReadJson(join(session.dir, '.mcp.json'));
    if (workspaceMcp !== null) {
      collectStdioServerMap(workspaceMcp.mcpServers ?? workspaceMcp, specs);
    }
    collectClaudePluginMcpSpecs(userDir, specs);
    return specs;
  }
  if (session.agent === 'codex') {
    const profile = codexProfile(session, m, home);
    const codexHome = expandPath(profile.codexHome ?? join(home, '.codex'), home);
    const configFile = join(codexHome, 'config.toml');
    if (!existsSync(configFile)) return specs;
    try {
      const parsed = Bun.TOML.parse(readFileSync(configFile, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        collectStdioServerMap((parsed as Record<string, unknown>).mcp_servers, specs);
      }
    } catch {
      /* fail-closed: unreadable config adds zero allowlist entries */
    }
  }
  return specs;
}

function commandArgv0(command: string): string {
  const trimmed = command.trim();
  const space = trimmed.search(/\s/);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

function executableBase(token: string): string {
  return basename(token).replace(/^-/, '').toLowerCase();
}

function stripPackageVersion(raw: string): string {
  // Preserve scoped package prefix (@scope/name@version -> @scope/name).
  if (raw.startsWith('@')) {
    const slash = raw.indexOf('/');
    if (slash === -1) return raw;
    const at = raw.indexOf('@', slash + 1);
    return at === -1 ? raw : raw.slice(0, at);
  }
  const at = raw.indexOf('@');
  return at === -1 ? raw : raw.slice(0, at);
}

function extractLauncherPackage(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--') return args[i + 1] ? stripPackageVersion(args[i + 1] as string) : null;
    if (arg.startsWith('--package=') || arg.startsWith('--from=')) {
      const value = arg.slice(arg.indexOf('=') + 1).trim();
      return value !== '' ? stripPackageVersion(value) : null;
    }
    if (arg === '-p' || arg === '--package' || arg === '--from') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) return stripPackageVersion(next);
      i++;
      continue;
    }
    if (LAUNCHER_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return stripPackageVersion(arg);
  }
  return null;
}

function findArgToken(command: string, token: string, fromIndex: number): number {
  let pos = command.indexOf(token, fromIndex);
  while (pos !== -1) {
    const before = pos === 0 ? ' ' : (command[pos - 1] ?? ' ');
    const after = command[pos + token.length] ?? ' ';
    const leftOk = /\s|["'=]/.test(before);
    const rightOk = /\s|["']/.test(after);
    if (leftOk && rightOk) return pos;
    pos = command.indexOf(token, pos + 1);
  }
  return -1;
}

function matchesDirectSpec(command: string, spec: DeclaredMcpSpec): boolean {
  const argv0 = commandArgv0(command);
  const procBase = executableBase(argv0);
  const specBase = executableBase(spec.command);
  if (SHELL_NAMES.has(procBase) || SHELL_NAMES.has(specBase)) return false;
  if (procBase !== specBase && tryRealpath(argv0) !== tryRealpath(spec.command)) return false;
  const nonEmptyArgs = spec.args.map((arg) => arg.trim()).filter((arg) => arg !== '');
  // Never allow a bare generic runtime (`node`, `bun`, `python`) without explicit script/args.
  if (nonEmptyArgs.length === 0 && GENERIC_RUNTIMES.has(specBase)) return false;
  const positionalArgs = nonEmptyArgs.filter((arg) => !arg.startsWith('-'));
  const requiredArgs = positionalArgs.length > 0 ? positionalArgs : nonEmptyArgs;
  let cursor = argv0.length;
  for (const arg of requiredArgs) {
    const found = findArgToken(command, arg, cursor);
    if (found === -1) return false;
    cursor = found + arg.length;
  }
  return true;
}

function matchesLauncherSpec(command: string, spec: DeclaredMcpSpec): boolean {
  const specBase = executableBase(spec.command);
  if (!LAUNCHER_NAMES.has(specBase)) return false;
  const pkg = extractLauncherPackage(spec.args);
  if (pkg === null || pkg.length < 2) return false;
  const procBase = executableBase(commandArgv0(command));
  if (!LAUNCHER_RUNTIMES.has(procBase)) return false;
  const hasCacheMarker = LAUNCHER_CACHE_MARKERS.some((marker) => command.includes(marker));
  if (!hasCacheMarker && procBase !== specBase) return false;
  if (command.includes(pkg)) return true;
  const unscoped = pkg.includes('/') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
  return (
    unscoped.length >= 4 && (command.includes(`/${unscoped}`) || command.includes(` ${unscoped}`))
  );
}

export function matchesAnyMcpSpec(command: string, specs: readonly DeclaredMcpSpec[]): boolean {
  return specs.some(
    (spec) => matchesDirectSpec(command, spec) || matchesLauncherSpec(command, spec),
  );
}

export function isShellExecutable(command: string): boolean {
  return SHELL_NAMES.has(executableBase(commandArgv0(command)));
}

function isSupervisorTmuxProbe(command: string, tmuxBin?: string): boolean {
  const trimmed = command.trim();
  // Short-lived `tmux` children of `_run` (`settlePrompts`) can appear briefly as zombies before
  // waitpid reaps them (`(tmux)` on macOS, `[tmux] <defunct>` on Linux).
  if (trimmed === '(tmux)' || /^\[tmux\](?:\s+<defunct>)?$/.test(trimmed)) return true;
  const argv0 = commandArgv0(trimmed);
  const base = executableBase(argv0);
  if (base !== 'tmux' && (tmuxBin === undefined || tryRealpath(argv0) !== tryRealpath(tmuxBin))) {
    return false;
  }
  const tokens = trimmed.split(/\s+/).slice(1);
  return tokens.some((tok) => SUPERVISOR_TMUX_SUBCOMMANDS.has(tok));
}

export function isProviderExecutable(
  row: ProcessSnapshot,
  providerId: 'claude' | 'codex',
  providerBin?: string,
): boolean {
  const argv0 = commandArgv0(row.command);
  const base = executableBase(argv0);
  if (base === providerId) return true;
  const resolvedBin = providerBin === undefined ? null : tryRealpath(providerBin);
  if (providerBin !== undefined) {
    if (base === executableBase(providerBin)) return true;
    if (resolvedBin !== null && tryRealpath(argv0) === resolvedBin) return true;
  }
  // Claude/Codex sometimes run via node/bun wrapper pointing directly at their package/binary.
  if (base === 'node' || base === 'bun') {
    const rest = row.command.slice(argv0.length);
    if (providerBin !== undefined && rest.includes(providerBin)) return true;
    if (resolvedBin !== null && rest.includes(resolvedBin)) return true;
    if (providerId === 'claude' && rest.includes('@anthropic-ai/claude-code')) return true;
    if (providerId === 'codex' && /(?:^|[\s/])codex(?:\.js)?(?:\s|$)/.test(rest)) return true;
    if (new RegExp(`(?:^|[\\s/])${providerId}(?:\\s|$)`).test(rest)) return true;
  }
  return false;
}

export interface TuiProcessClassification {
  readonly ok: boolean;
  readonly reason: null | 'owner-unavailable' | 'background-processes';
  readonly agentPid: number | null;
  readonly processes: readonly { readonly pid: number; readonly startTime: string }[];
  readonly backgroundProcesses: readonly ProcessSnapshot[];
}

/**
 * Classify every process belonging to one interactive tmux pane.
 *
 * Allowed:
 * - `paneRow` (the tmux pane root, e.g. `stitchmux _run`)
 * - transient non-interactive `tmux` probe children of `paneRow` (e.g. `_run` `settlePrompts`)
 * - exactly one direct child `agentRow` matching the session's provider (`claude` or `codex`)
 * - direct children of `agentRow` matching a declared stdio MCP spec (and their shell-free subtrees)
 * - direct `caffeinate` child of `agentRow` (macOS keep-awake helper)
 *
 * Everything else — shells, user builds/servers/tests, unknown `node`/`bun`/`python`, extra direct
 * children of `panePid`, or orphaned `ppid=1` processes in the same process group — is classified
 * as a blocking background process.
 */
export function classifyTuiProcessTree(input: {
  readonly rows: readonly ProcessSnapshot[];
  readonly panePid: number;
  readonly providerId: 'claude' | 'codex';
  readonly providerBin?: string;
  readonly tmuxBin?: string;
  readonly mcpSpecs: readonly DeclaredMcpSpec[];
}): TuiProcessClassification {
  const { rows, panePid, providerId, providerBin, tmuxBin, mcpSpecs } = input;
  const paneRow = rows.find((row) => row.pid === panePid);
  if (paneRow === undefined) {
    return {
      ok: false,
      reason: 'owner-unavailable',
      agentPid: null,
      processes: [],
      backgroundProcesses: [],
    };
  }
  const tree = rows.filter(
    (row) =>
      row.pid === panePid ||
      row.processGroup === paneRow.processGroup ||
      isDescendantProcess(rows, row.pid, panePid),
  );
  // Exclude transient supervisor tmux probes from the identity list so `settlePrompts` polling
  // cannot cause spurious `REVISION_CONFLICT` between idleProof reads.
  const supervisorProbes = new Set<number>(
    tree
      .filter((row) => row.ppid === panePid && isSupervisorTmuxProbe(row.command, tmuxBin))
      .map((row) => row.pid),
  );
  const effectiveTree = tree.filter((row) => !supervisorProbes.has(row.pid));
  const processIdentities = effectiveTree.map(({ pid, startTime }) => ({ pid, startTime }));
  const directPaneChildren = effectiveTree.filter(
    (row) => row.ppid === panePid && row.pid !== panePid,
  );
  const matchingAgents = directPaneChildren.filter((row) =>
    isProviderExecutable(row, providerId, providerBin),
  );
  if (matchingAgents.length !== 1 || directPaneChildren.length !== 1) {
    return {
      ok: false,
      reason: matchingAgents.length === 0 ? 'owner-unavailable' : 'background-processes',
      agentPid: matchingAgents[0]?.pid ?? null,
      processes: processIdentities,
      backgroundProcesses: directPaneChildren.filter((row) => row !== matchingAgents[0]),
    };
  }
  const agentRow = matchingAgents[0] as ProcessSnapshot;
  const allowedPids = new Set<number>([paneRow.pid, agentRow.pid]);
  const mcpRootPids = new Set<number>();

  for (const row of effectiveTree) {
    if (row.ppid !== agentRow.pid) continue;
    const base = executableBase(commandArgv0(row.command));
    if (SHELL_NAMES.has(base)) continue;
    if (base === 'caffeinate') {
      allowedPids.add(row.pid);
      continue;
    }
    if (matchesAnyMcpSpec(row.command, mcpSpecs)) {
      allowedPids.add(row.pid);
      mcpRootPids.add(row.pid);
    }
  }

  // Allow shell-free descendants strictly inside verified MCP subtrees (e.g. bunx -> node worker).
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of effectiveTree) {
      if (allowedPids.has(row.pid)) continue;
      if (!mcpRootPids.has(row.ppid)) continue;
      const base = executableBase(commandArgv0(row.command));
      if (SHELL_NAMES.has(base)) continue;
      allowedPids.add(row.pid);
      mcpRootPids.add(row.pid);
      grew = true;
    }
  }

  const backgroundProcesses = effectiveTree.filter((row) => !allowedPids.has(row.pid));
  return {
    ok: backgroundProcesses.length === 0,
    reason: backgroundProcesses.length === 0 ? null : 'background-processes',
    agentPid: agentRow.pid,
    processes: processIdentities,
    backgroundProcesses,
  };
}
