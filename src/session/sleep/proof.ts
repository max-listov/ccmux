import { createHash } from 'node:crypto';
import { inspectNativeCodexInput } from '../../agent/codex/pane.ts';
import { providerFor } from '../../agent/index.ts';
import { stableJson } from '../../agent/launch/launchInputs.ts';
import { loadAcks } from '../../chat/ackLog.ts';
import { loadCursors } from '../../chat/cursors.ts';
import { managedPeer, managedPeerKey, sameTarget } from '../../chat/identity.ts';
import { loadLedger } from '../../chat/ledger.ts';
import { recentPaneSubmission } from '../../chat/paneSubmission.ts';
import { isDue, letterState } from '../../chat/settlement.ts';
import { readTurnState } from '../../chat/turnProgress.ts';
import { SETTLE_MS } from '../../chat/turnState.ts';
import { contextMutationPending } from '../../context/store.ts';
import { refusals } from '../../control/schema/refusals.ts';
import { delegationStopped } from '../../delegation/cancel.ts';
import {
  isDescendantProcess,
  type ProcessSnapshot,
  processSnapshotAsync,
} from '../../external/processes.ts';
import { readRuntimeInput } from '../../runtime/input.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { readRuntimeOwnership } from '../../runtime/ownership.ts';
import { readManagedRuntimeStatus } from '../../runtime/status.ts';
import { tmuxArgv } from '../../tmux/argv.ts';
import { AGENT_PANE_OPTION } from '../../tmux/paneInventory.ts';
import { exactTarget } from '../../tmux/target.ts';
import { capturePaneStyled, clientTypingRecently } from '../../tmux/tmux.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { stripAnsi } from '../../util/ansi.ts';
import { run as spawnRun } from '../../util/spawn.ts';
import { loadSessions } from '../registry.ts';
import { readLifecycle, readWaiting, resolveLiveState } from '../status.ts';
import {
  classifyTuiProcessTree,
  isProviderExecutable,
  isShellExecutable,
  loadDeclaredMcpSpecs,
  matchesAnyMcpSpec,
} from './processTree.ts';
import { type IdleProof, IdleProofSchema } from './schema.ts';

/** Defense-in-depth footer detector for detached Claude background shells/agents. */
const CLAUDE_BG_FOOTER_RE = /·\s*\d+\s+(?:shells?|local agents?|background tasks?)\b/i;

const DEFAULT_SLEEP_TYPING_WINDOW_SEC = 60;

export interface SessionPaneRow {
  readonly paneId: string;
  readonly panePid: number;
  readonly agentPaneId: string | null;
}

/** List every tmux pane in one managed session (single targeted tmux call). */
export async function listSessionPanes(
  m: MachineConfig,
  name: string,
  signal?: AbortSignal,
): Promise<SessionPaneRow[] | null> {
  let code: number;
  let stdout: string;
  try {
    ({ code, stdout } = await spawnRun(
      tmuxArgv(
        m,
        'list-panes',
        '-s',
        '-t',
        exactTarget(name),
        '-F',
        `#{pane_id}|#{pane_pid}|#{${AGENT_PANE_OPTION}}`,
      ),
      { signal },
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  if (code !== 0) return null;
  const rows: SessionPaneRow[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [paneId, pidRaw, agentPaneRaw] = line.split('|');
    const panePid = Number(pidRaw);
    if (!paneId?.startsWith('%') || !Number.isSafeInteger(panePid) || panePid <= 1) continue;
    rows.push({
      paneId,
      panePid,
      agentPaneId: agentPaneRaw?.startsWith('%') ? agentPaneRaw : null,
    });
  }
  return rows;
}

export interface IdleProofOptions {
  readonly now?: number;
  readonly rows?: readonly ProcessSnapshot[] | null;
  readonly typingWindowSec?: number;
  readonly signal?: AbortSignal;
}

function isNonDelegatedNativeAllowedChild(
  row: ProcessSnapshot,
  ownerPid: number,
  providerPid: number,
  agent: 'claude' | 'codex',
  mcpSpecs: ReturnType<typeof loadDeclaredMcpSpecs>,
  providerBin?: string,
): boolean {
  if (isShellExecutable(row.command)) return false;
  if (row.ppid === providerPid && /(?:^|\/)caffeinate(?:\s|$)/.test(row.command.trim())) {
    return true;
  }
  if (agent === 'codex') {
    // Non-delegated Codex app-server attaches a terminal client (`codex resume --remote`) under the
    // owner and may keep Codex's built-in `node_repl` helper under the app-server provider.
    if (
      row.ppid === ownerPid &&
      isProviderExecutable(row, 'codex', providerBin) &&
      /\bresume\b/.test(row.command) &&
      /--remote\b/.test(row.command)
    ) {
      return true;
    }
    if (row.ppid === providerPid && /\bnode_repl\b/.test(row.command)) return true;
  }
  if (row.ppid === providerPid && matchesAnyMcpSpec(row.command, mcpSpecs)) return true;
  return false;
}

function finalizeProof(input: {
  target: ReturnType<typeof managedPeer>;
  registrationGeneration: string;
  generation: string | null;
  now: number;
  run: 'idle' | 'active' | 'unknown';
  reason: string | null;
  pending: readonly string[];
  runtimeInput: unknown;
  approvals: number | null;
  children: readonly Session[];
  background: number | null;
  processes: readonly { readonly pid: number; readonly startTime: string }[];
}): IdleProof {
  const facts = {
    target: input.target,
    registrationGeneration: input.registrationGeneration,
    generation: input.generation,
    run: input.run,
    pending: input.pending,
    input: input.runtimeInput,
    approvals: input.approvals,
    children: input.children.map((child) => [child.uuid, child.registrationGeneration]),
    background: input.background,
    processes: input.processes,
  };
  return IdleProofSchema.parse({
    target: input.target,
    registrationGeneration: input.registrationGeneration,
    revision: createHash('sha256').update(stableJson(facts)).digest('hex'),
    generation: input.generation,
    observedAt: new Date(input.now).toISOString(),
    eligible: input.reason === null,
    reason: input.reason,
    run: input.run,
    queue: input.pending.length,
    approvals: input.approvals,
    children: input.children.length,
    background: input.background,
    processes: [...input.processes],
  });
}

export async function idleProof(
  m: MachineConfig,
  s: Session,
  options: IdleProofOptions = {},
): Promise<IdleProof> {
  if (s.registrationGeneration === undefined) {
    throw refusals.errors.REGISTRATION_UNAVAILABLE({
      message: `Session '${s.name}' has no registrationGeneration; backfill before sleep`,
    });
  }
  const now = options.now ?? Date.now();
  const typingWindowSec = options.typingWindowSec ?? DEFAULT_SLEEP_TYPING_WINDOW_SEC;
  const target = managedPeer(m.rcPrefix, s);
  const cursors = loadCursors(m);
  const acks = loadAcks(m);
  const ledger = loadLedger(m);
  // Only DUE pending mail blocks sleep: future `notBefore` letters wake the session when due.
  const pending = ledger.flatMap((message, index) =>
    message !== null &&
    sameTarget(message.to, target) &&
    letterState(message, index, acks, cursors) === 'pending' &&
    isDue(message, now)
      ? [message.id]
      : [],
  );
  const pickupActive = cursors.pickups[managedPeerKey(target)] !== undefined;
  const children = loadSessions(m).filter(
    (child) =>
      !child.archived &&
      !delegationStopped(m, child) &&
      child.delegation !== undefined &&
      child.delegation.parent.target.kind === 'managed' &&
      sameTarget(child.delegation.parent.target, target) &&
      child.delegation.parent.registrationGeneration === s.registrationGeneration,
  );

  if (s.agent !== 'codex' && s.agent !== 'claude') {
    return finalizeProof({
      target,
      registrationGeneration: s.registrationGeneration,
      generation: null,
      now,
      run: 'unknown',
      reason: 'unsupported',
      pending,
      runtimeInput: null,
      approvals: null,
      children,
      background: null,
      processes: [],
    });
  }

  const rows =
    options.rows !== undefined ? options.rows : await processSnapshotAsync(options.signal);
  const waiting = readWaiting(s.name, now) !== null;

  if (hasNativeRuntime(s)) {
    const read = readManagedRuntimeStatus(m, s);
    const snapshot = read.snapshot;
    const owner = rows?.find((row) => row.pid === snapshot?.pid);
    const provider = rows?.find((row) => row.pid === snapshot?.providerPid);
    const ownership = readRuntimeOwnership(m, s);
    const owned =
      ownership !== null &&
      ownership.owner.pid === owner?.pid &&
      ownership.owner.startTime === owner?.startTime &&
      ownership.provider.pid === provider?.pid &&
      ownership.provider.startTime === provider?.startTime &&
      owner !== undefined &&
      provider !== undefined &&
      (provider.pid === owner.pid || isDescendantProcess(rows ?? [], provider.pid, owner.pid));
    const processes =
      rows?.filter(
        (row) =>
          row.pid === owner?.pid ||
          row.processGroup === ownership?.provider.processGroup ||
          (owner !== undefined && isDescendantProcess(rows, row.pid, owner.pid)),
      ) ?? [];

    let background: number | null = null;
    if (owned && rows !== null && owner !== undefined && provider !== undefined) {
      const mcpSpecs = s.delegation === undefined ? loadDeclaredMcpSpecs(s, m) : [];
      const providerBin = s.agent === 'claude' ? m.claudeBin : m.codexBin;
      // Baseline processes are matched strictly by (pid, startTime) below so PID reuse can never
      // hide a newly spawned background process. `allowedPids` tracks ONLY verified non-delegated
      // MCP / remote-client / caffeinate subtrees spawned after baseline.
      const allowedPids = new Set<number>();
      if (s.delegation === undefined) {
        for (const row of processes) {
          if (
            isNonDelegatedNativeAllowedChild(
              row,
              owner.pid,
              provider.pid,
              s.agent,
              mcpSpecs,
              providerBin,
            )
          ) {
            allowedPids.add(row.pid);
          }
        }
        // Allow shell-free children strictly under a verified non-delegated MCP/client root.
        let grew = true;
        while (grew) {
          grew = false;
          for (const row of processes) {
            if (allowedPids.has(row.pid) || isShellExecutable(row.command)) continue;
            if (allowedPids.has(row.ppid)) {
              allowedPids.add(row.pid);
              grew = true;
            }
          }
        }
      }
      background = processes.filter(
        (row) =>
          !ownership.baseline.some(
            (known) => known.pid === row.pid && known.startTime === row.startTime,
          ) && !allowedPids.has(row.pid),
      ).length;
    }

    // Non-delegated Codex app-server keeps an interactive terminal pane (`codex resume --remote`).
    // Fail-closed like the TUI branch: a terminal tmux cannot list or capture is not proven idle.
    let terminalIssue:
      | 'auxiliary-panes'
      | 'pane-busy'
      | 'client-typing'
      | 'terminal-unavailable'
      | null = null;
    if (s.delegation === undefined && s.agent === 'codex') {
      const panes = await listSessionPanes(m, s.name, options.signal);
      if (panes === null) {
        terminalIssue = 'terminal-unavailable';
      } else if (panes.length > 1) {
        terminalIssue = 'auxiliary-panes';
      } else if (panes.length === 1) {
        if (await clientTypingRecently(m, s.name, typingWindowSec)) {
          terminalIssue = 'client-typing';
        } else {
          const styled = await capturePaneStyled(m, s.name, 40);
          if (styled === '') terminalIssue = 'terminal-unavailable';
          else if (inspectNativeCodexInput(styled).state !== 'deliverable') {
            terminalIssue = 'pane-busy';
          }
        }
      }
    }

    const input = readRuntimeInput(m, s);
    const run =
      read.status !== 'live' || snapshot === null
        ? 'unknown'
        : snapshot.state === 'idle' && snapshot.turn?.status !== 'inProgress'
          ? 'idle'
          : 'active';
    const approvals = snapshot?.pendingRequests.length ?? null;
    const reason = delegationStopped(m, s)
      ? 'delegation-ended'
      : !owned
        ? 'owner-unavailable'
        : run !== 'idle'
          ? 'runtime-not-idle'
          : waiting
            ? 'waiting-on-peer'
            : terminalIssue !== null
              ? terminalIssue
              : pending.length > 0 || pickupActive
                ? 'queued-input'
                : input !== null && input.phase !== 'accepted'
                  ? 'dispatch-pending'
                  : approvals !== 0
                    ? 'pending-requests'
                    : children.length > 0
                      ? 'owned-children'
                      : background === null || background > 0
                        ? 'background-processes'
                        : contextMutationPending(m, s)
                          ? 'context-operation'
                          : null;

    return finalizeProof({
      target,
      registrationGeneration: s.registrationGeneration,
      generation: snapshot?.generation ?? null,
      now,
      run,
      reason,
      pending,
      runtimeInput: input,
      approvals,
      children,
      background,
      processes: processes.map(({ pid, startTime }) => ({ pid, startTime })),
    });
  }

  // Interactive TUI branch (`claude` or `codex` in tmux).
  const panes = await listSessionPanes(m, s.name, options.signal);
  if (panes === null || panes.length === 0) {
    return finalizeProof({
      target,
      registrationGeneration: s.registrationGeneration,
      generation: null,
      now,
      run: 'unknown',
      reason: 'owner-unavailable',
      pending,
      runtimeInput: null,
      approvals: null,
      children,
      background: null,
      processes: [],
    });
  }
  const hasAuxPanes = panes.length > 1;
  const agentPane =
    panes.find((pane) => pane.agentPaneId !== null && pane.paneId === pane.agentPaneId) ?? panes[0];
  if (agentPane === undefined) {
    return finalizeProof({
      target,
      registrationGeneration: s.registrationGeneration,
      generation: null,
      now,
      run: 'unknown',
      reason: 'owner-unavailable',
      pending,
      runtimeInput: null,
      approvals: null,
      children,
      background: null,
      processes: [],
    });
  }

  const provider = providerFor(s);
  const styled = await capturePaneStyled(m, s.name, 40);
  const plain = stripAnsi(styled);
  const scan = provider.scanPane(plain);
  const inspection = provider.inspectChatPane?.(styled);
  const lifecycle = readLifecycle(s.name);
  const turn = readTurnState(m, s, provider, styled, now);
  const liveState = resolveLiveState(scan.state, lifecycle, turn);
  const tailText = plain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-10)
    .join('\n');
  const claudeBackgroundFooter = s.agent === 'claude' && CLAUDE_BG_FOOTER_RE.test(tailText);
  const typing = await clientTypingRecently(m, s.name, typingWindowSec);
  const mcpSpecs = loadDeclaredMcpSpecs(s, m);
  const tree =
    rows === null
      ? null
      : classifyTuiProcessTree({
          rows,
          panePid: agentPane.panePid,
          providerId: s.agent,
          ...(s.agent === 'claude'
            ? { providerBin: m.claudeBin }
            : m.codexBin === undefined
              ? {}
              : { providerBin: m.codexBin }),
          tmuxBin: m.tmuxBin,
          mcpSpecs,
        });

  const paneDeliverable = inspection !== undefined && inspection.state === 'deliverable';
  const run: 'idle' | 'active' | 'unknown' =
    liveState === 'idle' && turn.settled && paneDeliverable && scan.atPrompt === null
      ? 'idle'
      : liveState === 'working' || !turn.settled
        ? 'active'
        : 'unknown';
  const background =
    tree === null ? null : tree.backgroundProcesses.length + (claudeBackgroundFooter ? 1 : 0);

  const reason = delegationStopped(m, s)
    ? 'delegation-ended'
    : hasAuxPanes
      ? 'auxiliary-panes'
      : tree !== null && tree.reason === 'owner-unavailable'
        ? 'owner-unavailable'
        : !paneDeliverable || scan.atPrompt !== null
          ? 'pane-busy'
          : !turn.settled || liveState !== 'idle'
            ? 'runtime-not-idle'
            : waiting
              ? 'waiting-on-peer'
              : typing
                ? 'client-typing'
                : pending.length > 0 ||
                    pickupActive ||
                    recentPaneSubmission(m, s, SETTLE_MS, now) !== null
                  ? 'queued-input'
                  : children.length > 0
                    ? 'owned-children'
                    : claudeBackgroundFooter || tree === null || !tree.ok
                      ? 'background-processes'
                      : null;

  return finalizeProof({
    target,
    registrationGeneration: s.registrationGeneration,
    generation: null,
    now,
    run,
    reason,
    pending,
    runtimeInput: null,
    approvals: scan.atPrompt !== null ? 1 : 0,
    children,
    background,
    processes: tree?.processes ?? [],
  });
}
