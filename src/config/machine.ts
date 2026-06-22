import { existsSync, readFileSync } from "node:fs";
import { MachineConfigSchema } from "./schema.ts";
import type { MachineConfig } from "../types.ts";
import { HOME, PLATFORM } from "../env.ts";

function configPath(): string {
  return process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`;
}

/** Per-platform defaults; everything here is overridable by machine.json. */
function resolveDefaults(platform: NodeJS.Platform): Record<string, unknown> {
  const mac = platform === "darwin";
  return {
    tmuxBin: mac ? "/opt/homebrew/bin/tmux" : "/usr/bin/tmux",
    projectsDir: `${HOME}/.claude/projects`,
    codexSessionsDir: `${HOME}/.codex/sessions`,
    sessionsFile: process.env.CCMUX_SESSIONS ?? `${HOME}/.ccmux-sessions`,
    // Default so a fresh box (no machine.json yet) just runs — `install` pins the real
    // local|dev|prod into machine.json; until then every command works as "local".
    rcPrefix: "local",
    ensureInterval: 30,
    permissionMode: "auto",
    bootLabel: mac ? "com.ccmux.daemon" : "ccmux.service",
    extraFlags: [],
  };
}

function firstExisting(candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return undefined;
}

function detectClaudeBin(): string {
  const found = firstExisting([
    Bun.which("claude"),
    `${HOME}/.local/bin/claude`,
    "/root/.bun/bin/claude",
    "/root/.local/bin/claude",
  ]);
  if (!found) throw new Error("claude binary not found — set claudeBin in machine.json");
  return found;
}

function detectTmuxBin(): string {
  const found = firstExisting([Bun.which("tmux"), "/opt/homebrew/bin/tmux", "/usr/bin/tmux"]);
  if (!found) throw new Error("tmux binary not found — set tmuxBin in machine.json");
  return found;
}

/**
 * The ONE-artifact / many-configs loader. Reads machine.json (if present), layers
 * it over per-platform defaults + ordered-fallback bin detection, applies env
 * overrides, then validates through the strict schema. Re-read on every call — no
 * module-level cache (the structural fix for the bash mapfile-once staleness bug).
 */
export function loadMachineConfig(): MachineConfig {
  const path = configPath();
  const fileRaw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const file = MachineConfigSchema.partial().parse(fileRaw); // validates file, all-optional
  const merged: Record<string, unknown> = { ...resolveDefaults(PLATFORM), ...file };
  if (merged.claudeBin === undefined) merged.claudeBin = detectClaudeBin();
  if (merged.codexBin === undefined) {
    const codex = Bun.which("codex");
    if (codex) merged.codexBin = codex;
  }
  if (merged.tmuxBin === undefined) merged.tmuxBin = detectTmuxBin();
  const envSessions = process.env.CCMUX_SESSIONS;
  if (envSessions) merged.sessionsFile = envSessions;
  const envRc = process.env.CCMUX_RC_PREFIX;
  if (envRc) merged.rcPrefix = envRc;
  return MachineConfigSchema.parse(merged);
}

/** Remote-Control display name: `<prefix>-<name without cc->`. */
export function rcName(m: MachineConfig, name: string): string {
  return `${m.rcPrefix}-${name.replace(/^cc-/, "")}`;
}

/** Build a full, validated machine config from detection + defaults (for `install`).
 *  We pin the resolved paths into machine.json rather than re-detecting every load. */
export function scaffoldMachineConfig(rcPrefix: "local" | "dev" | "prod"): MachineConfig {
  const merged: Record<string, unknown> = { ...resolveDefaults(PLATFORM), rcPrefix };
  merged.claudeBin = detectClaudeBin();
  if (merged.tmuxBin === undefined) merged.tmuxBin = detectTmuxBin();
  return MachineConfigSchema.parse(merged);
}
