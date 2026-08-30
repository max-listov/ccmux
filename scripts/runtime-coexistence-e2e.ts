import { join } from "node:path";
import { createCcmuxControlServiceClient } from "../src/control/serviceDescriptor.ts";
import type { MachineConfig, ManagedPeer } from "../src/types.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { loadLedger } from "../src/chat/store.ts";
import { samePrincipal, sameTarget } from "../src/chat/identity.ts";
import { shellJoin } from "../src/util/shellQuote.ts";

type Client = ReturnType<typeof createCcmuxControlServiceClient>;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Two real writers share only the control/chat plane, never native continuation or agent loop. */
export async function verifyRuntimeCoexistence(m: MachineConfig, client: Client, a: ManagedPeer, workspace: string) {
  const request = { requestId: crypto.randomUUID(), runtime: "codex", name: "codex-peer", workspace,
    flags: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"] } satisfies Parameters<Client["create"]>[0];
  const b = (await client.create(request)).target;
  check((await client.create(request)).target.threadId === b.threadId, "Codex retry changed identity");
  check(a.threadId !== b.threadId && a.agent !== b.agent, "Runtime identities collided");
  const token = `runtime-${crypto.randomUUID()}`;
  const invocation = shellJoin([process.execPath, "--no-env-file", process.env.CCMUX_E2E_CLI ?? join(process.cwd(), "src/cli.ts")]);
  await client.message({ target: a, messageId: crypto.randomUUID(), body:
    `Authorized isolated communication test. Run exactly ${invocation} msg ${b.machine}:${b.session} --to-agent codex --to-thread ${b.threadId} with body "${token} A_TO_B. Reply once with ${token} B_TO_A using the pinned reply command from CCMux. Do not contact anyone else or edit files." When the reply arrives answer RECEIVED without sending another message.` });
  const deadline = Date.now() + 180_000;
  let proved = false;
  while (!proved) {
    check(Date.now() < deadline, "Cross-runtime round trip timed out");
    for (const target of [a, b]) {
      const frame = await client.native({ target });
      const pending = frame.pending[0];
      if (pending?.kind === "approval") await client.respond({ target, operationId: crypto.randomUUID(), generation: frame.generation,
        requestId: pending.requestId, kind: "approval", decision: "accept" });
    }
    const messages = loadLedger(m).filter(row => row?.body.includes(token));
    proved = messages.some(row => row && samePrincipal(row.from, a) && sameTarget(row.to, b)) &&
      messages.some(row => row && samePrincipal(row.from, b) && sameTarget(row.to, a));
    await Bun.sleep(200);
  }
  for (const target of [a, b]) {
    let result = await client.wait({ target, timeoutMs: 25_000 });
    if (result.outcome === "timeout") result = await client.wait({ target, timeoutMs: 25_000 });
    check(result.outcome === "completed", "Cross-runtime pickup did not complete");
  }
  console.log(JSON.stringify({ phase: "cross-runtime-round-trip", evidence: { identities: [a, b], exactProviderMachineSession: true } }));
  const session = loadSessions(m).find(row => row.uuid === b.threadId);
  check(session, "Codex registration is missing");
  return session;
}
