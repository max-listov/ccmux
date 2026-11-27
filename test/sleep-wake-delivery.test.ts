import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildEnvelope } from '../src/chat/compose.ts';
import { loadCursors } from '../src/chat/cursors.ts';
import {
  deliverPending,
  resetWakeCoordinator,
  selectSleepingWakeMessage,
} from '../src/chat/deliver.ts';
import { holdReason } from '../src/chat/holdReason.ts';
import { cliPrincipal, managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/ledger.ts';
import { sendLetter } from '../src/chat/sendLetter.ts';
import { chatPaths } from '../src/chat/store.ts';
import { restartAllOnce } from '../src/commands/restartAll.ts';
import { cmdPin } from '../src/commands/sleep.ts';
import { cmdWait } from '../src/commands/wait.ts';
import { acceptControlMessage } from '../src/control/message.ts';
import { withNativeAdmission } from '../src/runtime/admission.ts';
import { ensureOnce } from '../src/session/heal.ts';
import { readLifecycleBlockForSession } from '../src/session/lifecycleBlocks.ts';
import { loadSessions, setSessionPinned, writeSessionsUnlocked } from '../src/session/registry.ts';
import { runAutoSleepPass } from '../src/session/sleep/autoSleep.ts';
import {
  reconcileSleepRecord,
  sleepSessionByName,
  wakeSessionByName,
} from '../src/session/sleep/operations.ts';
import { idleProof } from '../src/session/sleep/proof.ts';
import { type SleepRecord, SleepRecordSchema } from '../src/session/sleep/schema.ts';
import { readSleep, sleepBlocksStart, writeSleep } from '../src/session/sleep/store.ts';
import { startSession } from '../src/session/start.ts';
import {
  clearWaiting,
  readChatHold,
  readLifecycle,
  writeLifecycle,
  writeWaiting,
} from '../src/session/status.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { capturePane, hasSession } from '../src/tmux/tmux.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { communicationAuthorization } from './communication-fixture.ts';
import { makeMachine, makeSession } from './helpers.ts';

const tempDirs: string[] = [];
const socketsToKill: Array<{ tmuxBin: string; socket: string }> = [];

function mkRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const { tmuxBin, socket } of socketsToKill.splice(0)) {
    Bun.spawnSync([tmuxBin, '-L', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSleepRecord(
  m: MachineConfig,
  s: Session,
  phase: SleepRecord['phase'],
  updatedAt = new Date().toISOString(),
): SleepRecord {
  const gen = s.registrationGeneration ?? crypto.randomUUID();
  return SleepRecordSchema.parse({
    target: managedPeer(m.rcPrefix, s),
    registrationGeneration: gen,
    operationId: crypto.randomUUID(),
    phase,
    updatedAt,
    proof: {
      target: managedPeer(m.rcPrefix, s),
      registrationGeneration: gen,
      revision: 'a'.repeat(64),
      generation: null,
      eligible: true,
      run: 'idle',
      queue: 0,
      approvals: 0,
      children: 0,
      background: 0,
      reason: null,
      observedAt: updatedAt,
      processes: [{ pid: 999_999, startTime: 'Thu Nov 26 10:00:00 2026' }],
    },
  });
}

describe('wake-on-demand selection, control/message, heal, restart --all, inbox holdReason', () => {
  test('selectSleepingWakeMessage wakes only on due mail and blocks every negative control', () => {
    const root = mkRoot('stitchmux-wake-select-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const s = makeSession({
      name: 'agent-a',
      agent: 'claude',
      dir: root,
      chatEnabled: true,
      registrationGeneration: crypto.randomUUID(),
    });
    const msg = buildEnvelope(cliPrincipal('host-a'), managedPeer('host-a', s), 'wake up', {
      defer: true,
      notBefore: null,
      task: null,
    });
    const sleep = fakeSleepRecord(m, s, 'sleeping');

    // Positive control: due mail for healthy sleeping Claude TUI triggers wake.
    expect(
      selectSleepingWakeMessage({
        session: s,
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: { msg },
      }),
    ).toEqual({ action: 'wake', msg });

    // Negative controls: NONE of these may trigger wake!
    expect(
      selectSleepingWakeMessage({
        session: s,
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: null, // future notBefore or acked
      }),
    ).toEqual({ action: 'skip' });

    expect(
      selectSleepingWakeMessage({
        session: { ...s, archived: true },
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: { msg },
      }),
    ).toEqual({ action: 'skip' });

    expect(
      selectSleepingWakeMessage({
        session: s,
        chatEnabled: false,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: { msg },
      }),
    ).toEqual({ action: 'skip' });

    expect(
      selectSleepingWakeMessage({
        session: s,
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: true,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: { msg },
      }),
    ).toEqual({ action: 'skip' });

    expect(
      selectSleepingWakeMessage({
        session: s,
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: true,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: { msg },
      }),
    ).toEqual({ action: 'skip' });

    expect(
      selectSleepingWakeMessage({
        session: s,
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: true,
        duePick: { msg },
      }),
    ).toEqual({ action: 'hold-rate-limit', msg });

    expect(
      selectSleepingWakeMessage({
        session: { ...s, agent: 'opencode', runtime: 'native' },
        chatEnabled: true,
        supportsManagedInput: true,
        blocked: false,
        delegationEnded: false,
        sleepPhase: sleep.phase,
        rateLimited: false,
        duePick: { msg },
      }),
    ).toEqual({ action: 'skip' });
  });

  test('acceptControlMessage and sendLetter accept mail for a sleeping TUI session without 409', async () => {
    const root = mkRoot('stitchmux-sleep-msg-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const s = makeSession({
      name: 'agent-a',
      agent: 'claude',
      dir: root,
      chatEnabled: true,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [s]);
    await writeSleep(m, s, fakeSleepRecord(m, s, 'sleeping'));
    expect(sleepBlocksStart(m, s)).toBe(true);

    const accepted = await acceptControlMessage(
      m,
      cliPrincipal(m.rcPrefix),
      {
        target: managedPeer(m.rcPrefix, s),
        registrationGeneration: s.registrationGeneration,
        messageId: crypto.randomUUID(),
        body: 'hello sleeping agent',
        defer: true,
        task: null,
        notBefore: null,
        images: [],
        communicationAuthorization,
      },
      new AbortController().signal,
    );
    expect(accepted.accepted).toBe(true);
    expect(loadLedger(m).some((row) => row !== null && row.body === 'hello sleeping agent')).toBe(
      true,
    );

    const letterOutcome = await sendLetter(m, cliPrincipal('host-a'), {
      to: s.name,
      body: 'scheduled ping',
      task: null,
      interrupt: false,
      onBehalfOf: null,
      afterSeconds: 300,
      toAgent: null,
      toThread: null,
      communicationAuthorization,
    });
    expect(letterOutcome.status).toBe('sent');
    if (letterOutcome.status === 'sent') {
      expect(letterOutcome.receipt.note).toContain('sleeping');
    }
  });

  test('ensureOnce and restartAllOnce skip sleeping sessions without followFork or start', async () => {
    const awake = makeSession({ name: 'agent-awake', agent: 'claude' });
    const asleep = makeSession({ name: 'agent-sleep', agent: 'claude' });
    const started: string[] = [];
    const forked: string[] = [];

    await ensureOnce({
      sessions: () => [awake, asleep],
      observe: async () => ({ live: new Set(), agentGone: new Set() }),
      shouldSkip: (s) => s.name === 'agent-sleep',
      retire: async () => {},
      followFork: async (s) => {
        forked.push(s.name);
        return s;
      },
      start: async (name) => {
        started.push(name);
      },
    });
    expect(forked).toEqual(['agent-awake']);
    expect(started).toEqual(['agent-awake']);

    const restarted = await restartAllOnce({
      sessions: () => [awake, asleep],
      isSleeping: (s) => s.name === 'agent-sleep',
      self: undefined,
      followFork: async (s) => s,
      kill: async () => {},
      writersGone: async () => {},
      start: async () => {},
    });
    expect(restarted).toEqual(['agent-awake']);
  });

  test('holdReason explains sleeping and scheduled sleeping mail honestly', () => {
    const s = makeSession({ name: 'agent-a', agent: 'claude', chatEnabled: true });
    const now = Date.UTC(2026, 10, 27, 10, 0, 0);
    const dueMsg = buildEnvelope(cliPrincipal('host-a'), managedPeer('host-a', s), 'now', {
      defer: true,
      notBefore: null,
      task: null,
    });
    const futureMsg = buildEnvelope(cliPrincipal('host-a'), managedPeer('host-a', s), 'later', {
      defer: true,
      notBefore: new Date(now + 120_000).toISOString(),
      task: null,
    });

    expect(
      holdReason(dueMsg, {
        recipient: s,
        chatEnabled: true,
        running: false,
        sleeping: true,
        nowMs: now,
      }),
    ).toMatchObject({ kind: 'recipient-sleeping' });

    const futureReason = holdReason(futureMsg, {
      recipient: s,
      chatEnabled: true,
      running: false,
      sleeping: true,
      nowMs: now,
    });
    expect(futureReason.kind).toBe('not-due');
    expect(futureReason.text).toContain('sleeping');
  });

  test('reconcileSleepRecord recovers crash-stuck requested and waking phases', async () => {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) return;
    const root = mkRoot('stitchmux-reconcile-');
    const socket = `stitchmux-reconcile-${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
    });
    const s = makeSession({
      name: 'agent-a',
      agent: 'claude',
      dir: root,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [s]);

    // Crash after writing phase='requested' when processes and tmux are already gone -> settles to sleeping.
    await writeSleep(m, s, fakeSleepRecord(m, s, 'requested'));
    const settled = await reconcileSleepRecord(m, s);
    expect(settled?.phase).toBe('sleeping');
    expect(readSleep(m, s)?.phase).toBe('sleeping');

    // Crash in stale phase='waking' with no tmux -> rolls back to sleeping.
    await writeSleep(
      m,
      s,
      fakeSleepRecord(m, s, 'waking', new Date(Date.now() - 60_000).toISOString()),
    );
    const rolledBack = await reconcileSleepRecord(m, s);
    expect(rolledBack?.phase).toBe('sleeping');
    expect(readSleep(m, s)?.phase).toBe('sleeping');
  });
});

describe('real tmux TUI sleep, negative controls, wake-on-demand, auto-sleep, and Codex fast-fail', () => {
  function writeFakeClaude(
    binDir: string,
    options: { stdinLog?: string; extraFooter?: string; promptText?: string } = {},
  ) {
    mkdirSync(binDir, { recursive: true });
    const fakeClaude = join(binDir, 'claude');
    const logLine =
      options.stdinLog === undefined
        ? ''
        : `import { appendFileSync } from 'node:fs';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { appendFileSync(${JSON.stringify(options.stdinLog)}, chunk); });`;
    const footer = options.extraFooter ?? '  ? for shortcuts';
    const prompt = options.promptText ?? '';
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env bun
${logLine}
process.on('SIGTERM', () => process.exit(0));
// ANSI SGR colored prompt pushed to the bottom of the pane just like real Claude Code.
process.stdout.write('\\n'.repeat(20) + '\\x1b[90m────────────────────────────────────────\\x1b[0m\\n\\x1b[1m❯ \\x1b[0m${prompt}\\n\\x1b[90m────────────────────────────────────────\\x1b[0m\\n\\x1b[2m${footer}\\x1b[0m\\n');
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeClaude, 0o755);
    return fakeClaude;
  }

  async function waitForPane(m: MachineConfig, name: string, needle: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = await capturePane(m, name, 20);
      if (pane.includes(needle)) return true;
      await Bun.sleep(150);
    }
    return false;
  }

  test('sleeps ANSI-styled TUI Claude cleanly, enforces live negative controls & policy guards, and wakes same uuid', async () => {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required for TUI sleep/wake e2e test');

    const root = mkRoot('stitchmux-tui-sleep-e2e-');
    const socket = `stitchmux-sleep-e2e-${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const fakeClaude = writeFakeClaude(join(root, 'bin'));

    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
      claudeBin: fakeClaude,
    });
    const configPath = join(root, 'machine.json');
    writeFileSync(configPath, `${JSON.stringify(m)}\n`);
    const prevConfig = process.env.STITCHMUX_CONFIG;
    const prevState = process.env.STITCHMUX_STATE_DIR;
    process.env.STITCHMUX_CONFIG = configPath;
    process.env.STITCHMUX_STATE_DIR = m.stateDir;
    try {
      const session = makeSession({
        name: 'agent-e2e',
        agent: 'claude',
        dir: root,
        chatEnabled: true,
      });
      await writeSessionsUnlocked(m, [session]);
      await startSession(m, session.name, session.dir);
      expect(await waitForPane(m, session.name, '? for shortcuts')).toBe(true);

      writeLifecycle(session.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });
      const currentBefore = loadSessions(m)[0];
      if (currentBefore === undefined) throw new Error('expected registered session');
      // Direct idleProof refuses legacy sessions before registrationGeneration backfill.
      await expect(idleProof(m, currentBefore)).rejects.toMatchObject({
        code: 'REGISTRATION_UNAVAILABLE',
      });

      // Without forcePolicy, sleeping the sole awake session in claude:default refuses MIN_AWAKE_PER_PROFILE.
      await expect(
        sleepSessionByName(m, session.name, { forcePolicy: false }),
      ).rejects.toMatchObject({
        code: 'MIN_AWAKE_PER_PROFILE',
      });
      const backfilled = loadSessions(m)[0];
      if (backfilled === undefined) throw new Error('expected backfilled session');
      expect(backfilled.registrationGeneration).toBeDefined();

      // Pin via cmdPin -> refuses with PINNED_SESSION without --force, then unpin.
      expect(await cmdPin([session.name], true)).toBe(0);
      await expect(
        sleepSessionByName(m, session.name, { forcePolicy: false }),
      ).rejects.toMatchObject({
        code: 'PINNED_SESSION',
      });
      expect(await cmdPin([session.name], false)).toBe(0);

      // Live negative control: waiting-on-peer blocks idleProof.
      await writeWaiting(session.name, {
        target: 'agent-b',
        since: Date.now(),
        pid: process.pid,
        expiresAt: Date.now() + 60_000,
      });
      expect((await idleProof(m, backfilled)).reason).toBe('waiting-on-peer');
      clearWaiting(session.name);

      // Live negative control: auxiliary tmux window blocks idleProof.
      Bun.spawnSync(tmuxArgv(m, 'new-window', '-d', '-t', `=${session.name}`, 'sleep 30'), {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect((await idleProof(m, backfilled)).reason).toBe('auxiliary-panes');
      Bun.spawnSync(tmuxArgv(m, 'kill-window', '-t', `=${session.name}:1`), {
        stdout: 'ignore',
        stderr: 'ignore',
      });

      // Live negative control: future notBefore mail does NOT block sleep, while due mail DOES.
      const futureMsg = buildEnvelope(
        cliPrincipal('host-a'),
        managedPeer('host-a', backfilled),
        'later',
        {
          defer: true,
          notBefore: new Date(Date.now() + 300_000).toISOString(),
          task: null,
        },
      );
      appendMessage(m, futureMsg);
      expect((await idleProof(m, backfilled)).eligible).toBe(true);

      const dueMsg = buildEnvelope(
        cliPrincipal('host-a'),
        managedPeer('host-a', backfilled),
        'now',
        {
          defer: true,
          notBefore: null,
          task: null,
        },
      );
      appendMessage(m, dueMsg);
      expect((await idleProof(m, backfilled)).reason).toBe('queued-input');

      // Live negative control: stale requested (> 30s) while TUI is still alive rolls back to awake.
      await writeSleep(
        m,
        backfilled,
        fakeSleepRecord(m, backfilled, 'requested', new Date(Date.now() - 60_000).toISOString()),
      );
      const rolled = await reconcileSleepRecord(m, backfilled);
      expect(rolled?.phase).toBe('awake');
      expect(readSleep(m, backfilled)?.phase).toBe('awake');

      // Clear ledger so sleep proceeds cleanly under forcePolicy.
      rmSync(chatPaths(m).ledger, { force: true });

      const receipt = await sleepSessionByName(m, session.name, { forcePolicy: true });
      expect(receipt.state).toBe('sleeping');
      expect(receipt.release).toBe('processReleased');

      // Verify tmux is gone, status cleared, NO LifecycleBlock, uuid preserved.
      expect(await hasSession(m, session.name)).toBe(false);
      expect(readLifecycle(session.name)).toBeNull();
      const afterSleep = loadSessions(m)[0];
      if (afterSleep === undefined) throw new Error('expected session after sleep');
      expect(afterSleep.uuid).toBe(session.uuid);
      expect(afterSleep.registrationGeneration).toBeDefined();
      expect(readLifecycleBlockForSession(m, afterSleep)).toBeNull();
      expect(sleepBlocksStart(m, afterSleep)).toBe(true);

      // cmdWait on a sleeping session with no pending mail exits 1 immediately.
      expect(await cmdWait([session.name, '--timeout', '2', '--quiet'])).toBe(1);

      // Wake reversibly via wakeSessionByName.
      const woken = await wakeSessionByName(m, session.name);
      expect(woken.woke).toBe(true);
      expect(await hasSession(m, session.name)).toBe(true);
      expect(readSleep(m, afterSleep)?.phase).toBe('awake');
      expect(sleepBlocksStart(m, afterSleep)).toBe(false);
      expect(loadSessions(m)[0]?.uuid).toBe(session.uuid);

      Bun.spawnSync(tmuxArgv(m, 'kill-session', '-t', `=${session.name}`), {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } finally {
      if (prevConfig === undefined) delete process.env.STITCHMUX_CONFIG;
      else process.env.STITCHMUX_CONFIG = prevConfig;
      if (prevState === undefined) delete process.env.STITCHMUX_STATE_DIR;
      else process.env.STITCHMUX_STATE_DIR = prevState;
    }
  });

  test('idleProof rejects Claude background-shells footer (CLAUDE_BG_FOOTER_RE)', async () => {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required');

    const root = mkRoot('stitchmux-tui-bgfooter-');
    const socket = `stitchmux-bgfooter-${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const fakeClaude = writeFakeClaude(join(root, 'bin'), {
      extraFooter: '  ? for shortcuts · 2 shells',
    });
    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
      claudeBin: fakeClaude,
    });
    const configPath = join(root, 'machine.json');
    writeFileSync(configPath, `${JSON.stringify(m)}\n`);
    const prevConfig = process.env.STITCHMUX_CONFIG;
    const prevState = process.env.STITCHMUX_STATE_DIR;
    process.env.STITCHMUX_CONFIG = configPath;
    process.env.STITCHMUX_STATE_DIR = m.stateDir;
    try {
      const session = makeSession({
        name: 'agent-bg',
        agent: 'claude',
        dir: root,
        registrationGeneration: crypto.randomUUID(),
      });
      await writeSessionsUnlocked(m, [session]);
      await startSession(m, session.name, session.dir);
      expect(await waitForPane(m, session.name, '2 shells')).toBe(true);
      writeLifecycle(session.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });
      const proof = await idleProof(m, session);
      expect(proof.eligible).toBe(false);
      expect(proof.reason).toBe('background-processes');
      expect(proof.background).toBeGreaterThanOrEqual(1);

      // Typed draft in composer -> rejected as pane-busy (not deliverable).
      const draftBin = writeFakeClaude(join(root, 'bin-draft'), {
        promptText: 'half typed draft message',
      });
      const draftMachine: MachineConfig = { ...m, claudeBin: draftBin };
      writeFileSync(configPath, `${JSON.stringify(draftMachine)}\n`);
      const draftSession = makeSession({
        name: 'agent-draft',
        agent: 'claude',
        dir: root,
        registrationGeneration: crypto.randomUUID(),
      });
      await writeSessionsUnlocked(draftMachine, [session, draftSession]);
      await startSession(draftMachine, draftSession.name, draftSession.dir);
      expect(await waitForPane(draftMachine, draftSession.name, 'half typed draft')).toBe(true);
      writeLifecycle(draftSession.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });
      const draftProof = await idleProof(draftMachine, draftSession);
      expect(draftProof.eligible).toBe(false);
      expect(draftProof.reason).toBe('pane-busy');
    } finally {
      if (prevConfig === undefined) delete process.env.STITCHMUX_CONFIG;
      else process.env.STITCHMUX_CONFIG = prevConfig;
      if (prevState === undefined) delete process.env.STITCHMUX_STATE_DIR;
      else process.env.STITCHMUX_STATE_DIR = prevState;
    }
  });

  test('deliverPending wakes sleeping TUI only for due mail, delivers once without duplicates, and ignores shutdown aborts', async () => {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required');

    resetWakeCoordinator();
    const root = mkRoot('stitchmux-deliver-wake-');
    const socket = `stitchmux-deliver-wake-${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const stdinLog = join(root, 'received.log');
    const fakeClaude = writeFakeClaude(join(root, 'bin'), { stdinLog });
    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
      claudeBin: fakeClaude,
    });
    const configPath = join(root, 'machine.json');
    writeFileSync(configPath, `${JSON.stringify(m)}\n`);
    const prevConfig = process.env.STITCHMUX_CONFIG;
    const prevState = process.env.STITCHMUX_STATE_DIR;
    process.env.STITCHMUX_CONFIG = configPath;
    process.env.STITCHMUX_STATE_DIR = m.stateDir;
    try {
      const session = makeSession({
        name: 'agent-wake',
        agent: 'claude',
        dir: root,
        chatEnabled: true,
        registrationGeneration: crypto.randomUUID(),
      });
      await writeSessionsUnlocked(m, [session]);
      await startSession(m, session.name, session.dir);
      expect(await waitForPane(m, session.name, '? for shortcuts')).toBe(true);
      writeLifecycle(session.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });

      // Put session to sleep cleanly.
      const slept = await sleepSessionByName(m, session.name, { forcePolicy: true });
      expect(slept.state).toBe('sleeping');
      expect(await hasSession(m, session.name)).toBe(false);

      const recipient = managedPeer(m.rcPrefix, session);
      const recipientKey = managedPeerKey(recipient);

      // Negative control 1: future notBefore letter must NOT wake session or advance cursor.
      const futureMsg = buildEnvelope(cliPrincipal('host-a'), recipient, 'DO_NOT_WAKE_YET', {
        defer: false,
        notBefore: new Date(Date.now() + 300_000).toISOString(),
        task: null,
      });
      appendMessage(m, futureMsg);
      await deliverPending(m);
      await Bun.sleep(200);
      expect(await hasSession(m, session.name)).toBe(false);
      expect(readSleep(m, session)?.phase).toBe('sleeping');
      expect(loadCursors(m).delivered[recipientKey] ?? 0).toBe(0);

      // Enqueue an immediate due letter.
      const dueMsg = buildEnvelope(cliPrincipal('host-a'), recipient, 'WAKE_AND_DELIVER_ONCE', {
        defer: false,
        notBefore: null,
        task: null,
      });
      appendMessage(m, dueMsg);

      // Negative control 2: aborted shutdown signal must NOT write 'wake failed' to chatHold.
      const aborted = new AbortController();
      aborted.abort();
      await deliverPending(m, aborted.signal);
      expect(readChatHold(session.name)?.reason ?? '').not.toContain('wake failed');
      expect(await hasSession(m, session.name)).toBe(false);

      // Positive control: real deliverPending triggers wake-on-demand; repeated ticks stay single-flight.
      await deliverPending(m);
      await deliverPending(m);
      const wakeDeadline = Date.now() + 12_000;
      while (Date.now() < wakeDeadline && readSleep(m, session)?.phase !== 'awake') {
        await Bun.sleep(150);
      }
      expect(readSleep(m, session)?.phase).toBe('awake');
      expect(await hasSession(m, session.name)).toBe(true);

      // Run deliverPending twice after wake: due letter is injected ONCE, never duplicated.
      await deliverPending(m);
      await deliverPending(m);
      const logDeadline = Date.now() + 5_000;
      while (Date.now() < logDeadline && !existsSync(stdinLog)) {
        await Bun.sleep(100);
      }
      expect(existsSync(stdinLog)).toBe(true);
      const deliveredText = readFileSync(stdinLog, 'utf8');
      const matches = deliveredText.match(/WAKE_AND_DELIVER_ONCE/g) ?? [];
      expect(matches.length).toBe(1);
      expect(deliveredText).not.toContain('DO_NOT_WAKE_YET');
      expect(loadCursors(m).delivered[recipientKey]).toBe(2);
    } finally {
      resetWakeCoordinator();
      if (prevConfig === undefined) delete process.env.STITCHMUX_CONFIG;
      else process.env.STITCHMUX_CONFIG = prevConfig;
      if (prevState === undefined) delete process.env.STITCHMUX_STATE_DIR;
      else process.env.STITCHMUX_STATE_DIR = prevState;
    }
  });

  /** A running fake Claude TUI with chat on, at its idle prompt, plus an env override for the CLI. */
  async function runningTuiClaude(prefix: string) {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required');
    resetWakeCoordinator();
    const root = mkRoot(prefix);
    const socket = `${prefix}${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const stdinLog = join(root, 'received.log');
    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
      claudeBin: writeFakeClaude(join(root, 'bin'), { stdinLog }),
    });
    const configPath = join(root, 'machine.json');
    writeFileSync(configPath, `${JSON.stringify(m)}\n`);
    const previous = {
      config: process.env.STITCHMUX_CONFIG,
      state: process.env.STITCHMUX_STATE_DIR,
    };
    process.env.STITCHMUX_CONFIG = configPath;
    process.env.STITCHMUX_STATE_DIR = m.stateDir;
    const restore = () => {
      resetWakeCoordinator();
      if (previous.config === undefined) delete process.env.STITCHMUX_CONFIG;
      else process.env.STITCHMUX_CONFIG = previous.config;
      if (previous.state === undefined) delete process.env.STITCHMUX_STATE_DIR;
      else process.env.STITCHMUX_STATE_DIR = previous.state;
    };
    const session = makeSession({
      name: 'agent-mail',
      agent: 'claude',
      dir: root,
      chatEnabled: true,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [session]);
    await startSession(m, session.name, session.dir);
    expect(await waitForPane(m, session.name, '? for shortcuts')).toBe(true);
    writeLifecycle(session.name, { state: 'idle', ts: Date.now() - 10_000, event: 'Stop' });
    const recipient = managedPeer(m.rcPrefix, session);
    const send = (body: string) =>
      appendMessage(
        m,
        buildEnvelope(cliPrincipal('host-a'), recipient, body, {
          defer: false,
          notBefore: null,
          task: null,
        }),
      );
    const received = () => (existsSync(stdinLog) ? readFileSync(stdinLog, 'utf8') : '');
    return { m, session, recipientKey: managedPeerKey(recipient), send, received, restore };
  }

  test('a letter that arrives while the TUI session is being put to sleep is held, then delivered once after wake', async () => {
    const t = await runningTuiClaude('stitchmux-mail-sleep-');
    try {
      // A sleep decision has recorded its intent; the release has not happened yet.
      await writeSleep(t.m, t.session, fakeSleepRecord(t.m, t.session, 'requested'));
      t.send('HELD_DURING_SLEEP');
      await deliverPending(t.m);
      await Bun.sleep(500);
      expect(t.received()).not.toContain('HELD_DURING_SLEEP');
      expect(loadCursors(t.m).delivered[t.recipientKey] ?? 0).toBe(0);
      expect(readChatHold(t.session.name)?.reason ?? '').toContain('sleep');

      for (const phase of ['sleeping', 'waking'] as const) {
        await writeSleep(t.m, t.session, fakeSleepRecord(t.m, t.session, phase));
        await deliverPending(t.m);
        await Bun.sleep(300);
        expect(t.received()).not.toContain('HELD_DURING_SLEEP');
      }

      await writeSleep(t.m, t.session, fakeSleepRecord(t.m, t.session, 'awake'));
      await deliverPending(t.m);
      await deliverPending(t.m);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !t.received().includes('HELD_DURING_SLEEP')) {
        await Bun.sleep(100);
      }
      expect(t.received().match(/HELD_DURING_SLEEP/g) ?? []).toHaveLength(1);
      expect(loadCursors(t.m).delivered[t.recipientKey]).toBe(1);
    } finally {
      t.restore();
    }
  });

  test('TUI delivery waits for the admission lock a sleep decision holds', async () => {
    const t = await runningTuiClaude('stitchmux-mail-lock-');
    try {
      t.send('AFTER_THE_DECISION');
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = () => {};
      const holding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // A sleep decision in flight holds the session's admission lock while it proves idleness.
      const decision = withNativeAdmission(t.m, t.session, async () => {
        entered();
        await held;
      });
      await holding;
      const pass = deliverPending(t.m);
      await Bun.sleep(1_000);
      expect(t.received()).not.toContain('AFTER_THE_DECISION');
      release();
      await decision;
      await pass;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !t.received().includes('AFTER_THE_DECISION')) {
        await Bun.sleep(100);
      }
      expect(t.received().match(/AFTER_THE_DECISION/g) ?? []).toHaveLength(1);
    } finally {
      t.restore();
    }
  });

  test('a TUI session that was just handed a letter is not proven idle before its turn shows', async () => {
    const t = await runningTuiClaude('stitchmux-mail-proof-');
    try {
      expect((await idleProof(t.m, t.session)).eligible).toBe(true);
      t.send('JUST_DELIVERED');
      await deliverPending(t.m);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !t.received().includes('JUST_DELIVERED')) {
        await Bun.sleep(100);
      }
      expect(t.received()).toContain('JUST_DELIVERED');
      // The fake agent never paints a working turn or writes a transcript, which is exactly the
      // window between Enter and the first sign of the turn.
      expect(await idleProof(t.m, t.session)).toMatchObject({
        eligible: false,
        reason: 'queued-input',
      });
      await expect(
        sleepSessionByName(t.m, t.session.name, { forcePolicy: true }),
      ).rejects.toMatchObject({ code: 'NOT_IDLE' });
      expect(readSleep(t.m, t.session)).toBeNull();
    } finally {
      t.restore();
    }
  });

  test('sleeping a Codex TUI session within <5s does NOT trigger FAST_FAIL_MS LifecycleBlock', async () => {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required');

    const root = mkRoot('stitchmux-codex-fastfail-');
    const socket = `stitchmux-codex-ff-${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const binDir = join(root, 'bin');
    const codexHome = join(root, 'codex-home');
    const codexSessions = join(codexHome, 'sessions');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });

    const fakeCodex = join(binDir, 'codex');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(0));
process.stdout.write('\\n› \\ngpt-5.4 · 100% context left\\n');
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeCodex, 0o755);

    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
      codexBin: fakeCodex,
      codexHome,
      codexSessionsDir: codexSessions,
    });
    const configPath = join(root, 'machine.json');
    writeFileSync(configPath, `${JSON.stringify(m)}\n`);
    const prevConfig = process.env.STITCHMUX_CONFIG;
    const prevState = process.env.STITCHMUX_STATE_DIR;
    process.env.STITCHMUX_CONFIG = configPath;
    process.env.STITCHMUX_STATE_DIR = m.stateDir;
    try {
      const session = makeSession({
        name: 'codex-tui',
        agent: 'codex',
        runtime: 'tui',
        dir: root,
        registrationGeneration: crypto.randomUUID(),
      });
      // Ready Codex TUI sessions require an existing rollout file in codexSessionsDir; backdate
      // mtime so turnProgress sees a settled idle conversation while elapsed uptime stays < 5s.
      const rolloutPath = join(codexSessions, `rollout-2026-11-27T00-00-00-${session.uuid}.jsonl`);
      writeFileSync(
        rolloutPath,
        `${JSON.stringify({ type: 'session_meta', payload: { id: session.uuid, cwd: root } })}\n`,
      );
      const settledAt = new Date(Date.now() - 120_000);
      utimesSync(rolloutPath, settledAt, settledAt);
      await writeSessionsUnlocked(m, [session]);
      await startSession(m, session.name, session.dir);
      expect(await waitForPane(m, session.name, '100% context left')).toBe(true);
      writeLifecycle(session.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });

      const receipt = await sleepSessionByName(m, session.name, { forcePolicy: true });
      expect(receipt.state).toBe('sleeping');
      expect(await hasSession(m, session.name)).toBe(false);
      // Must NOT record a Codex fast-fail LifecycleBlock even though elapsed < 5s!
      expect(readLifecycleBlockForSession(m, session)).toBeNull();
    } finally {
      if (prevConfig === undefined) delete process.env.STITCHMUX_CONFIG;
      else process.env.STITCHMUX_CONFIG = prevConfig;
      if (prevState === undefined) delete process.env.STITCHMUX_STATE_DIR;
      else process.env.STITCHMUX_STATE_DIR = prevState;
    }
  });

  test('runAutoSleepPass is a no-op when disabled and respects minAwakePerProfile + pinned when enabled', async () => {
    const tmuxBin = Bun.which('tmux');
    if (!tmuxBin) throw new Error('tmux is required');

    const root = mkRoot('stitchmux-autosleep-');
    const socket = `stitchmux-autosleep-${process.pid}-${Date.now()}`;
    socketsToKill.push({ tmuxBin, socket });
    const fakeClaude = writeFakeClaude(join(root, 'bin'));
    const disabledMachine = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: socket,
      claudeBin: fakeClaude,
      idleSleep: {
        enabled: false,
        idleAfterMinutes: 1,
        minAwakePerProfile: 1,
        checkIntervalSeconds: 60,
      },
    });
    const configPath = join(root, 'machine.json');
    writeFileSync(configPath, `${JSON.stringify(disabledMachine)}\n`);
    const prevConfig = process.env.STITCHMUX_CONFIG;
    const prevState = process.env.STITCHMUX_STATE_DIR;
    process.env.STITCHMUX_CONFIG = configPath;
    process.env.STITCHMUX_STATE_DIR = disabledMachine.stateDir;
    try {
      const s1 = makeSession({
        name: 'agent-old',
        agent: 'claude',
        dir: root,
        registrationGeneration: crypto.randomUUID(),
      });
      const s2 = makeSession({
        name: 'agent-keep',
        agent: 'claude',
        dir: root,
        registrationGeneration: crypto.randomUUID(),
      });
      await writeSessionsUnlocked(disabledMachine, [s1, s2]);
      await startSession(disabledMachine, s1.name, s1.dir);
      await startSession(disabledMachine, s2.name, s2.dir);
      expect(await waitForPane(disabledMachine, s1.name, '? for shortcuts')).toBe(true);
      expect(await waitForPane(disabledMachine, s2.name, '? for shortcuts')).toBe(true);
      writeLifecycle(s1.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });
      writeLifecycle(s2.name, { state: 'idle', ts: Date.now() - 5_000, event: 'Stop' });

      // Disabled -> no-op even far in the future.
      const futureNow = Date.now() + 2 * 60 * 60_000;
      expect(await runAutoSleepPass(disabledMachine, { now: futureNow })).toEqual({ slept: [] });

      // Enabled with minAwakePerProfile=1 -> sleeps exactly ONE session and preserves one healthy peer.
      const enabledMachine: MachineConfig = {
        ...disabledMachine,
        idleSleep: { ...disabledMachine.idleSleep, enabled: true },
      };
      // Pin agent-keep so agent-old is unambiguously the sole candidate while agent-keep stays awake.
      await setSessionPinned(enabledMachine, s2.name, true);
      const pass = await runAutoSleepPass(enabledMachine, { now: futureNow });
      expect(pass.slept).toEqual(['agent-old']);
      expect(await hasSession(enabledMachine, 'agent-old')).toBe(false);
      expect(await hasSession(enabledMachine, 'agent-keep')).toBe(true);

      // Unpin agent-keep: auto-sleep STILL refuses because minAwakePerProfile=1 requires 1 awake peer.
      await setSessionPinned(enabledMachine, s2.name, false);
      expect(await runAutoSleepPass(enabledMachine, { now: futureNow })).toEqual({ slept: [] });
      expect(await hasSession(enabledMachine, 'agent-keep')).toBe(true);
    } finally {
      if (prevConfig === undefined) delete process.env.STITCHMUX_CONFIG;
      else process.env.STITCHMUX_CONFIG = prevConfig;
      if (prevState === undefined) delete process.env.STITCHMUX_STATE_DIR;
      else process.env.STITCHMUX_STATE_DIR = prevState;
    }
  });
});
