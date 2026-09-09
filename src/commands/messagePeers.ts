import { z } from 'zod';
import { lastTranscriptMessage } from '../agent/index.ts';
import { CHAT_CREDENTIAL_ENV, hasChatCredential, type RemoteTransport } from '../chat/auth.ts';
import { currentCodexAppThreadId, resolveCodexAppPeer } from '../chat/codexApp.ts';
import { cliPrincipal, codexAppThreadId, managedPeer, principalLabel } from '../chat/identity.ts';
import { isRoleToken, type RoleCandidate, resolveRole } from '../chat/roleAddress.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { ListJsonSchema } from '../config/schema.ts';
import { findSession } from '../config/sessions.ts';
import { runPeer } from '../fleet/transport.ts';
import type {
  AgentKind,
  ChatPrincipal,
  CodexAppPeer,
  MachineConfig,
  ManagedPeer,
  Session,
} from '../types.ts';

const RemoteListSchema = ListJsonSchema.pick({ sessions: true });

export function anonymousRemoteWarning(
  from: ChatPrincipal,
  transport: RemoteTransport | null,
): string | null {
  if (from.kind !== 'cli' || transport === null) return null;
  const transportLabel = transport === 'ssh' ? 'ssh' : 'the remote adapter';
  return (
    `msg: warning — this command is running under ${transportLabel} without a managed sender; sent as ${principalLabel(from)}, ` +
    'so the recipient cannot reply to the originating agent. Run ccmux msg <machine>:<session> from the managed ' +
    `session instead of invoking remote ccmux msg through ${transportLabel}.`
  );
}

export function warnAboutAnonymousRemote(
  from: ChatPrincipal,
  transport: RemoteTransport | null,
): void {
  const warning = anonymousRemoteWarning(from, transport);
  if (warning !== null) console.error(warning);
}

export async function senderFor(
  machine: string,
  sessions: Session[],
  m: MachineConfig,
): Promise<ChatPrincipal | { error: string }> {
  const name = process.env.CCMUX_SESSION;
  if (name !== undefined && name !== '') {
    const session = findSession(sessions, name);
    if (!session || !chatEnabledFor(session, m)) {
      return {
        error: `msg: this session '${name}' has chat disabled — enable with: ccmux chat on ${name}`,
      };
    }
    if (!hasChatCredential(loadMachineConfig(), session, process.env[CHAT_CREDENTIAL_ENV])) {
      return {
        error: `msg: CCMUX_SESSION does not identify the calling process as managed session '${name}'`,
      };
    }
    return managedPeer(machine, session);
  }
  const appThreadId = currentCodexAppThreadId();
  if (appThreadId !== null) {
    try {
      return await resolveCodexAppPeer(m, appThreadId);
    } catch (error) {
      return {
        error: `msg: Codex App sender identity could not be verified (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  return cliPrincipal(machine);
}

export function assertExpected(
  target: ManagedPeer | CodexAppPeer,
  agent: AgentKind | null,
  threadId: string | null,
): string | null {
  if (agent !== null && target.agent !== agent)
    return `provider mismatch: expected ${agent}, found ${target.agent}`;
  if (threadId !== null && target.threadId !== threadId)
    return `thread mismatch: expected ${threadId}, found ${target.threadId}`;
  return null;
}

export async function resolveRemoteCodexAppPeer(
  cfg: MachineConfig,
  alias: string | null,
  machine: string,
  token: string,
): Promise<CodexAppPeer | { error: string }> {
  const parsed = z.uuid().safeParse(codexAppThreadId(token));
  if (!parsed.success) return { error: `msg ${machine}:${token}: app address needs a thread UUID` };
  const result = await runPeer(cfg, machine, alias, ['ccmux', '_codex-app-resolve', parsed.data], {
    timeoutMs: 20_000,
  });
  if (result.transportFailed)
    return {
      error: `msg ${machine}:${token}: transport failed while resolving exact App thread${result.failureDetail === undefined ? '' : ` (${result.failureDetail})`}`,
    };
  if (result.code !== 0)
    return { error: `msg ${machine}:${token}: App thread resolution failed (exit ${result.code})` };
  try {
    const peer = z
      .object({
        kind: z.literal('codex-app'),
        source: z.literal('codex-app'),
        machine: z.literal(machine),
        agent: z.literal('codex'),
        threadId: z.literal(parsed.data),
        name: z.string().nullable(),
      })
      .strict()
      .parse(JSON.parse(result.stdout));
    return peer;
  } catch {
    return {
      error: `msg ${machine}:${token}: remote App identity is missing or version-incompatible`,
    };
  }
}

export async function cmdResolveCodexApp(args: string[]): Promise<number> {
  const parsed = z.uuid().safeParse(args[0]);
  if (!parsed.success) {
    console.error('codex app resolve: thread UUID required');
    return 1;
  }
  try {
    console.log(JSON.stringify(await resolveCodexAppPeer(loadMachineConfig(), parsed.data)));
    return 0;
  } catch (error) {
    console.error(`codex app resolve: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function resolveRemotePeer(
  cfg: MachineConfig,
  alias: string | null,
  machine: string,
  token: string,
): Promise<ManagedPeer | { error: string }> {
  const name = token;
  const result = await runPeer(cfg, machine, alias, ['ccmux', 'list', '--json'], {
    timeoutMs: 20_000,
  });
  if (result.transportFailed)
    return {
      error: `msg ${machine}:${name}: transport failed while resolving exact peer${result.failureDetail === undefined ? '' : ` (${result.failureDetail})`}`,
    };
  if (result.code !== 0)
    return { error: `msg ${machine}:${name}: remote peer resolution failed (exit ${result.code})` };
  try {
    const parsed = RemoteListSchema.parse(JSON.parse(result.stdout));
    // A role is resolved on the SAME answer the peer identity comes from, so a session cannot be
    // selected by a role it held one call ago. A peer too old to report roles simply declares none,
    // and the refusal says so rather than guessing.
    let wanted = name;
    if (isRoleToken(name)) {
      const resolved = resolveRole(name, parsed.sessions.map(remoteCandidate), `${machine}:`);
      if ('error' in resolved) return { error: `msg ${machine}:${name}: ${resolved.error}` };
      wanted = resolved.name;
    }
    const matches = parsed.sessions.filter((session) => session.name === wanted);
    if (matches.length !== 1) {
      const candidates = matches
        .map((session) => `${session.agent ?? 'unknown'}#${session.uuid}`)
        .join(', ');
      const suffix = candidates === '' ? '' : `; candidates: ${candidates}`;
      return {
        error: `msg ${machine}:${name}: expected one exact peer, found ${matches.length}${suffix}`,
      };
    }
    const match = matches[0];
    if (match === undefined)
      return { error: `msg ${machine}:${name}: peer disappeared during resolution` };
    return {
      kind: 'managed',
      source: 'ccmux',
      machine,
      agent: match.agent,
      session: match.name,
      threadId: z.uuid().parse(match.uuid),
    };
  } catch {
    return { error: `msg ${machine}:${name}: remote identity is missing or version-incompatible` };
  }
}

/** One remote session, as a role lookup needs to see it. `lastMessage.text` is what tells two
 *  sessions of one project apart — the same thing a person reads before choosing by hand. */
export function remoteCandidate(
  s: z.infer<typeof RemoteListSchema>['sessions'][number],
): RoleCandidate {
  return { name: s.name, role: s.role, dir: s.dir, lastText: s.lastMessage?.text ?? null };
}

export function localCandidate(s: Session, m: MachineConfig): RoleCandidate {
  return {
    name: s.name,
    role: s.role ?? null,
    dir: s.dir,
    lastText: lastTranscriptMessage(s, m)?.text ?? null,
  };
}
