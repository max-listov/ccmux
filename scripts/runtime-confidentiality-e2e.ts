import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineConfig, Session } from "../src/types.ts";
import { readManagedRuntimeStatus } from "../src/runtime/status.ts";

/** Verify the installed executable and a real inherited secret-like fixture without printing it. */
export async function verifyRuntimeConfidentiality(m: MachineConfig, session: Session, publicFrame: unknown, root: string, cli: string): Promise<void> {
  const fixture = process.env.NATIVE_RUNTIME_PROBE_SECRET;
  if (!fixture || readFileSync(join(root, "workspace", "env-check.txt"), "utf8") !== "CHECKED")
    throw new Error("The isolated provider did not prove its fixture environment");
  const snapshot = readManagedRuntimeStatus(m, session).snapshot;
  if (!snapshot) throw new Error("No exact live provider for argv proof");
  const argv = Bun.spawnSync(["ps", "-p", String(snapshot.providerPid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
  if (argv.exitCode !== 0) throw new Error("Native process argv could not be inspected");
  const evidence = [JSON.stringify(publicFrame), JSON.stringify(session), argv.stdout.toString(),
    readFileSync(join(m.stateDir, "ccmux.log"), "utf8")];
  if (evidence.some(value => value.includes(fixture))) throw new Error("Secret-like fixture escaped its environment boundary");
  const version = Bun.spawnSync([process.execPath, "--no-env-file", cli, "version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0) throw new Error("Executed runtime version could not be verified");
  console.log(JSON.stringify({ phase: "installed-runtime-confidentiality", evidence: {
    version: version.stdout.toString().trim(), fixtureReachedProvider: true, metadataSafe: true, argvSafe: true, logsSafe: true } }));
}
