import { existsSync } from "node:fs";
import { z } from "zod";
import type { MachineConfig } from "../types.ts";
import type { RemoteResult } from "./transport.ts";

/**
 * The second transport: a call handed to the local stitchwire agent instead of to ssh.
 *
 * Why it exists. ssh needs the RECEIVER to be reachable, and the laptop never is — no stable
 * address, no open port, and adding one would mean giving a server standing shell access to the
 * trust hub. stitchwire inverts the connection without inverting the trust: every machine dials OUT
 * to a broker and keeps that link, so "who can reach whom" stops depending on who has an address.
 * ccmux gains a direction it never had (server → laptop) and gives up nothing.
 *
 * Deliberately dependency-free. We speak to an agent that already runs on this machine, over a Unix
 * socket, with `fetch` — no client library, no second credential, and nothing new in the bundle.
 * The socket file IS the permission: anything that can open it speaks with this machine's identity.
 *
 * The invariant that ties the two systems together: a stitchwire **node id equals a ccmux
 * `rcPrefix`**. One label, one machine, both systems. Breaking that would silently route mail to
 * the wrong box — the exact failure fleet addressing exists to remove.
 */

/**
 * The local door's answer.
 *
 * Two rules the door's own contract asks of every reader, and both are load-bearing:
 *
 *  - **`v` is COMPARED, not pattern-matched.** A door speaking a contract this build does not know
 *    must be told apart from a malformed record; without the comparison an incompatible version
 *    reads as "unparseable answer" and sends the reader looking for a broken agent.
 *  - **Unknown keys pass.** Strict parsing here means "break on the door's next release" — which is
 *    a fleet-wide outage produced by an upgrade nobody would think to correlate.
 */
const DOOR_API_VERSION = 2;

const WireResultSchema = z.object({
  // Absent on a door older than the versioned contract; treated as compatible rather than refused,
  // because that door's shape is the one this schema was written against.
  v: z.number().int().optional(),
  code: z.number(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  failure: z.string().default("none"),
  /** WHAT KIND of no: `policy` and `request` are permanent, `capacity` is temporary. Absent on an
   *  older door, in which case the kind is simply unknown and nothing is inferred. */
  refusal: z.string().optional(),
  retryAfterMs: z.number().nullable().optional(),
  detail: z.string().default(""),
  truncated: z.boolean().default(false),
});

/** A refusal that will refuse identically forever, or `undefined` when this door cannot say.
 *  `capacity` is deliberately NOT permanent: it is the one the retry window exists for. */
export function refusalIsPermanent(refusal: string | undefined): boolean | undefined {
  if (refusal === undefined || refusal === "none") return undefined;
  return refusal === "policy" || refusal === "request";
}

export function wireSocketPath(m: MachineConfig): string | null {
  const socket = m.wire?.socket;
  if (socket !== undefined) return socket;
  const home = process.env.HOME;
  return home === undefined ? null : `${home}/.local/state/stitchwire/agent.sock`;
}

/** Machines this box is configured to reach over the wire rather than over ssh. Listing a machine
 *  here is the whole switch — which is what makes a single direction testable without moving the
 *  rest of the fleet onto a new transport. */
export function wirePeers(m: MachineConfig): string[] {
  return (m.wire?.peers ?? []).filter((p) => p !== m.rcPrefix);
}

export function isWirePeer(m: MachineConfig, machine: string): boolean {
  return wirePeers(m).includes(machine);
}

export async function runWire(
  m: MachineConfig,
  machine: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<RemoteResult> {
  const socket = wireSocketPath(m);
  if (socket === null || !existsSync(socket)) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      transportFailed: true,
      failureDetail: `no stitchwire agent socket at ${socket ?? "(unknown path)"} — is 'stitchwire agent' running here?`,
    };
  }

  const timeoutMs = opts?.timeoutMs ?? 30_000;
  let res: Response;
  try {
    res = await fetch("http://localhost/wire/call", {
      unix: socket,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: machine, argv, stdin: opts?.stdin ?? null, timeoutMs }),
      // The agent runs the caller's own deadline; this one only guards against a wedged agent, so it
      // must be the LATER of the two or it would report a healthy slow call as a dead socket.
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
  } catch (e) {
    return { code: 1, stdout: "", stderr: "", transportFailed: true, failureDetail: `stitchwire agent did not answer: ${String(e)}` };
  }

  const body = await res.text();
  if (!res.ok) {
    return { code: 1, stdout: "", stderr: "", transportFailed: true, failureDetail: `stitchwire agent returned HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  let parsed: z.infer<typeof WireResultSchema> | undefined;
  try {
    parsed = WireResultSchema.safeParse(JSON.parse(body)).data;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { code: 1, stdout: "", stderr: "", transportFailed: true, failureDetail: "stitchwire agent returned an unreadable result" };
  }

  if (parsed.v !== undefined && parsed.v !== DOOR_API_VERSION) {
    // Named, not guessed: "the agent on this machine speaks a contract this ccmux does not" is a
    // fixable statement, while a parse error about a healthy agent is a wild goose chase.
    return {
      code: 1,
      stdout: "",
      stderr: "",
      transportFailed: true,
      failureDetail: `the local stitchwire agent speaks door API v${parsed.v}, this ccmux understands v${DOOR_API_VERSION} — upgrade whichever is older`,
      permanent: true,
    };
  }
  // A refusal is NOT the command's verdict, and must never be reported as one. `denied` in
  // particular is a policy answer: the command was never run, so an exit code from it would be
  // fiction — the same distinction ssh's exit 255 draws, made explicit instead of inferred.
  if (parsed.failure !== "none") {
    const permanent = refusalIsPermanent(parsed.refusal);
    return {
      code: 1,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      transportFailed: true,
      // The kind is named beside the reason: "denied" alone reads as a network fault to anyone who
      // has not memorised the classification.
      failureDetail: `${parsed.failure}${parsed.refusal === undefined || parsed.refusal === "none" ? "" : `/${parsed.refusal}`}: ${parsed.detail}`,
      ...(permanent === undefined ? {} : { permanent }),
      ...(parsed.retryAfterMs === undefined || parsed.retryAfterMs === null ? {} : { retryAfterMs: parsed.retryAfterMs }),
    };
  }
  if (parsed.truncated) {
    return { code: parsed.code, stdout: parsed.stdout, stderr: `${parsed.stderr}\n[wire] output truncated at the stream cap\n`, transportFailed: false };
  }
  return { code: parsed.code, stdout: parsed.stdout, stderr: parsed.stderr, transportFailed: false };
}
