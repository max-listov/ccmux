import { existsSync } from "node:fs";
import type { MachineConfig } from "../types.ts";
import { RuntimeCatalogSchema, runtimeCapabilities } from "./capabilities.ts";

/** Configuration availability is not native readiness. Version evidence arrives from the admitted driver. */
export function readRuntimeCatalog(m: MachineConfig) {
  return RuntimeCatalogSchema.parse({ runtimes: [
    { runtime: "claude", availability: existsSync(m.claudeBin) ? "configured" : "unavailable",
      reason: existsSync(m.claudeBin) ? null : "runtime-not-configured", capabilities: runtimeCapabilities({ agent: "claude", runtime: "tui" }) },
    { runtime: "codex", availability: m.codexBin && existsSync(m.codexBin) ? "configured" : "unavailable",
      reason: m.codexBin && existsSync(m.codexBin) ? null : "runtime-not-configured", capabilities: runtimeCapabilities({ agent: "codex", runtime: "app-server" }) },
    { runtime: "opencode", availability: m.opencodeBin && existsSync(m.opencodeBin) ? "configured" : "unavailable",
      reason: m.opencodeBin && existsSync(m.opencodeBin) ? null : "runtime-not-configured", capabilities: runtimeCapabilities({ agent: "opencode", runtime: "native" }) },
    { runtime: "custom", availability: "unavailable", reason: "published-harness-unavailable",
      capabilities: runtimeCapabilities({ agent: "custom", runtime: "native" }) },
  ] });
}
