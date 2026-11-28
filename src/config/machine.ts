import { existsSync } from 'node:fs';
import { readJsonFileSync } from 'stitchkit/files';
import type { MachineConfig } from '../types.ts';
import { FileSnapshot } from '../util/fileSnapshot.ts';
import { HOME, PLATFORM } from '../util/home.ts';
import { producerMetrics } from '../util/producerMetrics.ts';
import { machineConfigPath, resolveMonitoringLocation } from './location.ts';
import { MachineConfigSchema } from './machineSchema.ts';
import { STATE_DIR } from './paths.ts';

const MachineFileSchema = MachineConfigSchema.partial();
const machineFile = new FileSnapshot<ReturnType<typeof MachineFileSchema.parse>>();
producerMetrics.register('machineFile', () => machineFile.metrics());

/** Per-platform defaults; everything here is overridable by machine.json. */
function resolveDefaults(platform: NodeJS.Platform): Record<string, unknown> {
  const mac = platform === 'darwin';
  return {
    tmuxBin: mac ? '/opt/homebrew/bin/tmux' : '/usr/bin/tmux',
    projectsDir: `${HOME}/.claude/projects`,
    codexHome: `${HOME}/.codex`,
    codexSessionsDir: `${HOME}/.codex/sessions`,
    stateDir: STATE_DIR,
    // Default so a fresh box (no machine.json yet) just runs — `install` pins the real
    // local|dev|prod into machine.json; until then every command works as "local".
    rcPrefix: 'local',
    ensureInterval: 30,
    oomScoreAdj: -300,
    permissionMode: 'auto',
    bootLabel: mac ? 'com.stitchmux.daemon' : 'stitchmux.service',
    extraFlags: [],
  };
}

function firstExisting(candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return undefined;
}

function detectClaudeBin(): string {
  const found = firstExisting([
    Bun.which('claude'),
    `${HOME}/.local/bin/claude`,
    '/root/.bun/bin/claude',
    '/root/.local/bin/claude',
  ]);
  if (!found) throw new Error('claude binary not found — set claudeBin in machine.json');
  return found;
}

/**
 * The caller's PATH is not configuration. Every command loads this config, and a caller started
 * with a minimal PATH — a launchd job, a hub's worker, a non-login shell — would otherwise build a
 * different machine than the daemon did: a runtime the daemon launched becomes "not configured" for
 * that one reader. The install locations come after PATH so that PATH still wins when it has one.
 */
function detectOptionalBin(name: 'codex' | 'opencode'): string | undefined {
  return firstExisting([
    Bun.which(name),
    `${HOME}/.bun/bin/${name}`,
    `${HOME}/.local/bin/${name}`,
    `${HOME}/.opencode/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ]);
}

/**
 * Antigravity's native self-updating installer places `agy` in `~/.local/bin/agy`, while Homebrew
 * casks lag behind and often sit ahead of `~/.local/bin` in launchd PATH. Check user-local native
 * installs before PATH so hosts with both binaries do not pin an older Homebrew wrapper.
 */
export function detectAntigravityBin(
  home = HOME,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string | undefined {
  return firstExisting([
    `${home}/.local/bin/agy`,
    `${home}/.gemini/bin/agy`,
    which('agy'),
    `${home}/.bun/bin/agy`,
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ]);
}

function detectTmuxBin(): string {
  const found = firstExisting([Bun.which('tmux'), '/opt/homebrew/bin/tmux', '/usr/bin/tmux']);
  if (!found) throw new Error('tmux binary not found — set tmuxBin in machine.json');
  return found;
}

/**
 * The ONE-artifact / many-configs loader. Reads machine.json (if present), layers
 * it over per-platform defaults + ordered-fallback bin detection, applies env
 * overrides, then validates through the strict schema. Disk revision is checked on every call;
 * only unchanged file parsing is reused. Binary detection and env overrides remain live.
 */
export function loadMachineConfig(): MachineConfig {
  const path = machineConfigPath();
  const file = machineFile.read(path, () => {
    try {
      return readJsonFileSync(path, MachineFileSchema);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return MachineFileSchema.parse({});
      throw error;
    }
  });
  const merged: Record<string, unknown> = {
    ...resolveDefaults(PLATFORM),
    ...file,
    ...resolveMonitoringLocation(file),
  };
  if (merged.claudeBin === undefined) merged.claudeBin = detectClaudeBin();
  if (merged.codexBin === undefined) {
    const codex = detectOptionalBin('codex');
    if (codex) merged.codexBin = codex;
  }
  if (merged.opencodeBin === undefined) {
    const opencode = detectOptionalBin('opencode');
    if (opencode) merged.opencodeBin = opencode;
  }
  if (merged.antigravityBin === undefined) {
    const agy = detectAntigravityBin();
    if (agy) merged.antigravityBin = agy;
  }
  if (merged.tmuxBin === undefined) merged.tmuxBin = detectTmuxBin();
  return MachineConfigSchema.parse(merged);
}

/** Remote-Control display name: `<prefix>-<name without cc->`. */
export function rcName(m: MachineConfig, name: string): string {
  return `${m.rcPrefix}-${name.replace(/^cc-/, '')}`;
}

/** Build a full, validated machine config from detection + defaults (for `install`).
 *  We pin the resolved paths into machine.json rather than re-detecting every load. */
export function scaffoldMachineConfig(rcPrefix: string): MachineConfig {
  const merged: Record<string, unknown> = { ...resolveDefaults(PLATFORM), rcPrefix };
  merged.claudeBin = detectClaudeBin();
  if (merged.tmuxBin === undefined) merged.tmuxBin = detectTmuxBin();
  return MachineConfigSchema.parse(merged);
}
