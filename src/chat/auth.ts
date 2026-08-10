import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chatAuthPath } from "../config/paths.ts";
import type { MachineConfig, Session } from "../types.ts";

export const CHAT_CREDENTIAL_ENV = "CCMUX_CHAT_CREDENTIAL";

/** Rotate the capability every time the managed runtime starts. Descendants inherit it; a shell
 * that merely self-sets CCMUX_SESSION does not become that runtime. This authenticates ccmux
 * process provenance, not a hostile process running as the same OS user (which can read state). */
export function rotateChatCredential(m: MachineConfig, session: Session): string {
  const credential = randomUUID();
  const path = chatAuthPath(m, session.name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${credential}\n`, { mode: 0o600 });
  return credential;
}

export function hasChatCredential(m: MachineConfig, session: Session, supplied: string | undefined): boolean {
  if (supplied === undefined || supplied === "") return false;
  try {
    const expected = readFileSync(chatAuthPath(m, session.name), "utf8").trim();
    const actualBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}

/** A remote receiver must actually descend from sshd. SSH_CONNECTION alone is caller-controlled
 * and therefore only metadata. Same-user hostile processes remain outside the trust model. */
export function hasSshdAncestor(startPid = process.ppid): boolean {
  let pid = startPid;
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const result = Bun.spawnSync(["ps", "-o", "ppid=", "-o", "comm=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return false;
    const line = result.stdout.toString().trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match === null) return false;
    const parent = Number.parseInt(match[1] ?? "", 10);
    const command = (match[2] ?? "").split("/").at(-1) ?? "";
    if (command === "sshd" || command.startsWith("sshd:")) return true;
    if (!Number.isInteger(parent) || parent <= 0 || parent === pid) return false;
    pid = parent;
  }
  return false;
}
