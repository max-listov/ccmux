import type { MachineConfig, Session } from "../../types.ts";
import { ownedCodexSocket } from "./ownedPaths.ts";
import { buildPrompt } from "../managePrompt.ts";
import { chatEnabledFor } from "../../config/chat.ts";
import { promptInvocation, UID } from "../../env.ts";
import { compareSemver } from "../../util/version.ts";
import { modelSelectionFlags } from "../../config/modelSelectionFlags.ts";

/** Only explicit native configuration flags; routing and identity cannot be overridden by flags. */
export function ownedCodexFlags(flags: readonly string[]): { server: string[]; client: string[] } {
  const server: string[] = [];
  const client: string[] = [];
  const configKeys: Record<string, string> = {
    "--model": "model", "-m": "model", "--sandbox": "sandbox_mode", "-s": "sandbox_mode",
    "--ask-for-approval": "approval_policy", "-a": "approval_policy",
  };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === undefined) break;
    if (flag === "--no-alt-screen") { client.push(flag); continue; }
    if (flag === "--dangerously-bypass-approvals-and-sandbox") {
      if (UID === 0) throw new Error("An owned root runtime cannot bypass approval and sandbox policy");
      server.push("-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"');
      continue;
    }
    if (flag === "--config" || flag === "-c" || flag === "--enable" || flag === "--disable" || configKeys[flag]) {
      const value = flags[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--config" || flag === "-c") {
        if (!value.includes("=")) throw new Error("Native config overrides require key=value");
        server.push("-c", value);
      } else if (flag === "--enable" || flag === "--disable") {
        server.push(flag, value);
      } else server.push("-c", `${configKeys[flag]}=${JSON.stringify(value)}`);
      continue;
    }
    throw new Error(`Unsupported App Server flag: ${flag}; use -c key=value for native configuration`);
  }
  return { server, client };
}

export function ownedCodexArgv(s: Session, m: MachineConfig, cli = promptInvocation()): string[] {
  if (!m.codexBin) throw new Error("codexBin is not configured");
  return [m.codexBin, "app-server", "--listen", `unix://${ownedCodexSocket(m, s.name)}`,
    ...ownedCodexFlags([...s.flags, ...m.extraFlags]).server, ...modelSelectionFlags(s.modelSelection),
    "-c", `developer_instructions=${JSON.stringify(buildPrompt(s.name, cli, "codex", "ccmux",
      chatEnabledFor(s, m), s.promptModules, m.ownerLang, m.rcPrefix))}`];
}

export function ownedCodexClientArgv(s: Session, m: MachineConfig): string[] {
  if (!m.codexBin) throw new Error("codexBin is not configured");
  return [m.codexBin, "resume", "--remote", `unix://${ownedCodexSocket(m, s.name)}`, s.uuid,
    "-c", "check_for_update_on_startup=false", ...ownedCodexFlags([...s.flags, ...m.extraFlags]).client];
}

export function ownedCodexThreadParams(s: Session, m: MachineConfig): Record<string, unknown> {
  return { cwd: s.dir, ...(s.modelSelection === undefined ? {} : {
    model: s.modelSelection.model, modelProvider: s.modelSelection.provider,
  }), developerInstructions: buildPrompt(s.name, promptInvocation(), "codex", "ccmux",
    chatEnabledFor(s, m), s.promptModules, m.ownerLang, m.rcPrefix) };
}

export function supportsOwnedCodexVersion(text: string): boolean {
  const version = text.trim().match(/^codex-cli (\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  return version?.[1] !== undefined && compareSemver(version[1], "0.147.0") >= 0
    && !(version[1] === "0.147.0" && version[2]);
}

/** No process, registry or provider configuration is changed by admission validation. */
export function preflightOwnedCodex(m: MachineConfig, flags: readonly string[]): void {
  ownedCodexFlags([...flags, ...m.extraFlags]);
  if (!m.codexBin) throw new Error("codexBin is not configured");
  const versionResult = Bun.spawnSync([m.codexBin, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  if (versionResult.exitCode !== 0 || !supportsOwnedCodexVersion(versionResult.stdout.toString())) {
    throw new Error("Native ownership requires Codex CLI 0.147.0 or newer");
  }
  for (const args of [["app-server", "--help"], ["resume", "--help"]]) {
    const result = Bun.spawnSync([m.codexBin, ...args], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    const help = result.stdout.toString();
    if (result.exitCode !== 0 || !help.includes("unix://PATH") || (args[0] === "resume" && !help.includes("--remote"))) {
      throw new Error("The configured Codex binary must support App Server Unix sockets and native resume --remote");
    }
  }
}
