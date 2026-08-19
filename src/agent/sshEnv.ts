import { existsSync } from "node:fs";

/**
 * A supervised session outlives the login that created it. `SSH_AUTH_SOCK` does not: it names the
 * socket of that login's forwarded agent, and when the login ends the socket is gone while the
 * variable stays. ssh started from such a session then WAITS on it — a hang that ends in a timeout,
 * looking exactly like a permissions problem — instead of falling through to whatever the ssh config
 * points at. One box was found running five sessions carrying sockets from two long-closed logins.
 *
 * tmux is how it arrives: its default `update-environment` copies these from the client that creates
 * a session, so restarting a fleet over ssh with agent forwarding hands every session a socket that
 * dies with the caller.
 *
 * WHAT THIS DOES NOT CLAIM. It does not say a machine can reach its peers without an agent. Whether
 * it can is a property of that fleet's ssh configuration — a box may authenticate to siblings only
 * through a forwarded identity, and an on-disk key file proves nothing about being authorised on the
 * other end. So a LIVE socket is never removed: it may be the only credential there is. Only a socket
 * that is already dead is dropped, because a dead one cannot be anybody's credential, and leaving it
 * in place actively prevents ssh from trying the path the config maintains.
 */
const CONNECTION_SCOPED = ["SSH_AUTH_SOCK", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

/** Whether this environment's agent socket is already gone. */
export function staleAgentSocket(env: Record<string, string>): boolean {
  const sock = env.SSH_AUTH_SOCK;
  return sock !== undefined && sock !== "" && !existsSync(sock);
}

/**
 * Drop connection-scoped SSH variables when the agent socket they point at is already dead.
 * A live socket — forwarded or local — is left exactly as it is.
 */
export function withoutDeadAgentEnv(env: Record<string, string>): Record<string, string> {
  if (!staleAgentSocket(env)) return env;
  const out = { ...env };
  for (const key of CONNECTION_SCOPED) delete out[key];
  return out;
}

/** Which variables this environment would lose — for the log line, so the reason survives. */
export function droppedDeadAgentKeys(env: Record<string, string>): string[] {
  if (!staleAgentSocket(env)) return [];
  return CONNECTION_SCOPED.filter((k) => env[k] !== undefined);
}
