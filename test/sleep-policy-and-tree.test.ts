import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeStamp, launchStaleReasons } from '../src/agent/launch/launchStamp.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import type { ProcessSnapshot } from '../src/external/processes.ts';
import { managedRuntimeRoot } from '../src/runtime/status.ts';
import { privateRuntimeDirectory } from '../src/runtime/store.ts';
import {
  readLifecycleBlockForSession,
  writeLifecycleBlock,
} from '../src/session/lifecycleBlocks.ts';
import {
  backfillRegistrationGenerations,
  loadSessions,
  setSessionPinned,
  writeSessionsUnlocked,
} from '../src/session/registry.ts';
import { computeIdleAnchorMs } from '../src/session/sleep/autoSleep.ts';
import { sleepSession } from '../src/session/sleep/operations.ts';
import {
  classifyTuiProcessTree,
  type DeclaredMcpSpec,
  loadDeclaredMcpSpecs,
  matchesAnyMcpSpec,
} from '../src/session/sleep/processTree.ts';
import {
  evaluateSleepPolicy,
  type SessionHealthState,
  sessionProfileKey,
  withProfilePolicyLock,
} from '../src/session/sleep/profilePolicy.ts';
import { idleProof } from '../src/session/sleep/proof.ts';
import { SleepReceiptSchema, SleepRecordSchema } from '../src/session/sleep/schema.ts';
import { readSleep, readSleepSafe, writeSleep } from '../src/session/sleep/store.ts';
import {
  appendWakeOperation,
  WAKE_JOURNAL_CAPACITY,
  type WakeOperation,
} from '../src/session/sleep/wakeStore.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import codexFrames from './fixtures/codex-pane/v0.159.1.json';
import { makeMachine, makeSession } from './helpers.ts';

const dirs: string[] = [];
function tempDir(prefix = 'stitchmux-sleep-policy-'): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
}

const afterEachKill: Array<() => void> = [];
afterEach(() => {
  for (const kill of afterEachKill.splice(0)) kill();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('MachineConfigSchema idleSleep defaults and backward compatibility', () => {
  const baseRaw = {
    claudeBin: '/usr/local/bin/claude',
    tmuxBin: '/usr/local/bin/tmux',
    projectsDir: '/tmp/projects',
    stateDir: '/tmp/state',
    bootLabel: 'com.stitchmux.test',
    rcPrefix: 'host-a',
  };

  test('existing machine.json without idleSleep parses cleanly with auto-sleep disabled', () => {
    const parsed = MachineConfigSchema.parse(baseRaw);
    expect(parsed.idleSleep).toEqual({
      enabled: false,
      idleAfterMinutes: 60,
      minAwakePerProfile: 1,
      checkIntervalSeconds: 60,
    });
  });

  test('idleSleep rejects unknown keys strictly and validates bounds', () => {
    expect(() =>
      MachineConfigSchema.parse({
        ...baseRaw,
        idleSleep: { enabled: true, unknownField: 1 },
      }),
    ).toThrow();
    expect(() =>
      MachineConfigSchema.parse({
        ...baseRaw,
        idleSleep: { enabled: true, idleAfterMinutes: 0 },
      }),
    ).toThrow();
  });
});

describe('sessionProfileKey canonicalization and fail-closed envFile', () => {
  test('Claude default profile stays distinct from explicit ~/.claude and canonicalizes symlinks', () => {
    const home = tempDir('stitchmux-home-');
    const workdir = join(home, 'work');
    mkdirSync(workdir, { recursive: true });
    const realProfile = join(home, 'real-profile');
    const linkProfile = join(home, 'link-profile');
    mkdirSync(realProfile, { recursive: true });
    symlinkSync(realProfile, linkProfile);

    const envExplicitDefault = join(workdir, 'default.env');
    writeFileSync(envExplicitDefault, `CLAUDE_CONFIG_DIR=${join(home, '.claude')}\n`);
    const envReal = join(workdir, 'real.env');
    writeFileSync(envReal, `CLAUDE_CONFIG_DIR=${realProfile}\n`);
    const envLink = join(workdir, 'link.env');
    writeFileSync(envLink, `CLAUDE_CONFIG_DIR=~/link-profile\n`);

    const m = makeMachine({ stateDir: join(home, 'state') });
    const unset = sessionProfileKey(
      makeSession({ name: 'a', agent: 'claude', dir: workdir }),
      m,
      home,
    );
    const explicitDot = sessionProfileKey(
      makeSession({ name: 'b', agent: 'claude', dir: workdir, envFile: envExplicitDefault }),
      m,
      home,
    );
    const realKey = sessionProfileKey(
      makeSession({ name: 'c', agent: 'claude', dir: workdir, envFile: envReal }),
      m,
      home,
    );
    const linkKey = sessionProfileKey(
      makeSession({ name: 'd', agent: 'claude', dir: workdir, envFile: envLink }),
      m,
      home,
    );

    expect(unset).toEqual({ key: 'claude:default' });
    expect(explicitDot).not.toEqual(unset);
    expect(realKey).toEqual(linkKey);
    expect(realKey).toEqual({ key: `claude:${realProfile}` });
  });

  test('ownCredentials (API key / Bedrock) isolates from OAuth profile and missing envFile fails closed', () => {
    const home = tempDir('stitchmux-creds-');
    const workdir = join(home, 'work');
    mkdirSync(workdir, { recursive: true });
    const customAuthEnv = join(workdir, 'bedrock.env');
    writeFileSync(customAuthEnv, 'CLAUDE_CODE_USE_BEDROCK=1\n');
    const missingEnv = join(workdir, 'missing.env');

    const m = makeMachine({ stateDir: join(home, 'state') });
    const oauth = sessionProfileKey(
      makeSession({ name: 'oauth', agent: 'claude', dir: workdir }),
      m,
      home,
    );
    const customAuth = sessionProfileKey(
      makeSession({ name: 'bedrock', agent: 'claude', dir: workdir, envFile: customAuthEnv }),
      m,
      home,
    );
    const missing = sessionProfileKey(
      makeSession({ name: 'broken', agent: 'claude', dir: workdir, envFile: missingEnv }),
      m,
      home,
    );

    expect(oauth).toEqual({ key: 'claude:default' });
    expect('key' in customAuth && customAuth.key.startsWith('claude:custom-auth:')).toBe(true);
    expect(customAuth).not.toEqual(oauth);
    expect('unavailable' in missing).toBe(true);

    // Directory path as envFile fails closed (never crashes with EISDIR or silently falls back).
    const dirEnv = join(workdir, 'dir-as-env');
    mkdirSync(dirEnv, { recursive: true });
    const dirSession = makeSession({
      name: 'dir-env',
      agent: 'claude',
      dir: workdir,
      envFile: dirEnv,
    });
    expect('unavailable' in sessionProfileKey(dirSession, m, home)).toBe(true);
    // Even with minAwakePerProfile === 0, PROFILE_UNAVAILABLE is still refused unless forcePolicy.
    const zeroMinMachine = makeMachine({
      stateDir: join(home, 'state'),
      idleSleep: {
        enabled: true,
        idleAfterMinutes: 60,
        minAwakePerProfile: 0,
        checkIntervalSeconds: 60,
      },
    });
    expect(
      evaluateSleepPolicy({
        m: zeroMinMachine,
        session: dirSession,
        sessions: [dirSession],
        running: new Set([dirSession.name]),
        sleeping: new Set(),
        blocked: new Set(),
        home,
      }),
    ).toMatchObject({ allowed: false, code: 'PROFILE_UNAVAILABLE' });
  });

  test('Codex unset CODEX_HOME and explicit ~/.codex share one canonical profile key', () => {
    const home = tempDir('stitchmux-codex-prof-');
    const workdir = join(home, 'work');
    const codexDir = join(home, '.codex');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    const envExplicit = join(workdir, 'codex.env');
    writeFileSync(envExplicit, 'CODEX_HOME=~/.codex\n');

    const m = makeMachine({ stateDir: join(home, 'state'), codexHome: codexDir });
    const unset = sessionProfileKey(
      makeSession({ name: 'a', agent: 'codex', dir: workdir }),
      m,
      home,
    );
    const explicit = sessionProfileKey(
      makeSession({ name: 'b', agent: 'codex', dir: workdir, envFile: envExplicit }),
      m,
      home,
    );
    expect(unset).toEqual(explicit);
    expect(unset).toEqual({ key: `codex:${codexDir}` });
  });
});

describe('evaluateSleepPolicy (pinned, minAwakePerProfile, healthy-only, forcePolicy)', () => {
  test('enforces pinned and minAwakePerProfile strictly over healthy awake peers of the same profile', () => {
    const root = tempDir('stitchmux-policy-eval-');
    const m = makeMachine({
      stateDir: join(root, 'state'),
      idleSleep: {
        enabled: true,
        idleAfterMinutes: 60,
        minAwakePerProfile: 1,
        checkIntervalSeconds: 60,
      },
    });
    const pinned = makeSession({ name: 'agent-pin', agent: 'claude', dir: root, pinned: true });
    const a = makeSession({ name: 'agent-a', agent: 'claude', dir: root });
    const b = makeSession({ name: 'agent-b', agent: 'claude', dir: root });
    const promptPeer = makeSession({ name: 'agent-prompt', agent: 'claude', dir: root });
    const sleepingPeer = makeSession({ name: 'agent-sleep', agent: 'claude', dir: root });

    // Pinned refuses without force, succeeds with forcePolicy.
    expect(
      evaluateSleepPolicy({
        m,
        session: pinned,
        sessions: [pinned, a],
        running: new Set(['agent-pin', 'agent-a']),
        sleeping: new Set(),
        blocked: new Set(),
        states: new Map<string, SessionHealthState>([
          ['agent-pin', 'idle'],
          ['agent-a', 'idle'],
        ]),
      }),
    ).toMatchObject({ allowed: false, code: 'PINNED_SESSION' });

    expect(
      evaluateSleepPolicy({
        m,
        session: pinned,
        sessions: [pinned],
        running: new Set(['agent-pin']),
        sleeping: new Set(),
        blocked: new Set(),
        forcePolicy: true,
      }),
    ).toMatchObject({ allowed: true });

    // Unhealthy peer (at prompt) or sleeping peer must NOT satisfy minAwakePerProfile.
    expect(
      evaluateSleepPolicy({
        m,
        session: a,
        sessions: [a, promptPeer, sleepingPeer],
        running: new Set(['agent-a', 'agent-prompt']),
        sleeping: new Set(['agent-sleep']),
        blocked: new Set(),
        states: new Map<string, SessionHealthState>([
          ['agent-a', 'idle'],
          ['agent-prompt', 'prompt'],
          ['agent-sleep', 'stopped'],
        ]),
      }),
    ).toMatchObject({ allowed: false, code: 'MIN_AWAKE_PER_PROFILE' });

    // Healthy peer in same profile allows sleeping `a`.
    expect(
      evaluateSleepPolicy({
        m,
        session: a,
        sessions: [a, b],
        running: new Set(['agent-a', 'agent-b']),
        sleeping: new Set(),
        blocked: new Set(),
        states: new Map<string, SessionHealthState>([
          ['agent-a', 'idle'],
          ['agent-b', 'working'],
        ]),
      }),
    ).toMatchObject({ allowed: true, profileKey: 'claude:default' });
  });

  test('withProfilePolicyLock serializes concurrent policy decisions so last awake session is preserved', async () => {
    const root = tempDir('stitchmux-policy-lock-');
    const m = makeMachine({
      stateDir: join(root, 'state'),
      idleSleep: {
        enabled: true,
        idleAfterMinutes: 60,
        minAwakePerProfile: 1,
        checkIntervalSeconds: 60,
      },
    });
    const a = makeSession({ name: 'agent-a', agent: 'claude', dir: root });
    const b = makeSession({ name: 'agent-b', agent: 'claude', dir: root });
    const sessions = [a, b];
    const running = new Set(['agent-a', 'agent-b']);
    const sleeping = new Set<string>();

    const attempt = (target: typeof a) =>
      withProfilePolicyLock(m, async () => {
        const verdict = evaluateSleepPolicy({
          m,
          session: target,
          sessions,
          running,
          sleeping,
          blocked: new Set(),
        });
        if (!verdict.allowed) return verdict.code;
        await Bun.sleep(25);
        sleeping.add(target.name);
        return 'ALLOWED';
      });

    const results = await Promise.all([attempt(a), attempt(b)]);
    expect(results.sort()).toEqual(['ALLOWED', 'MIN_AWAKE_PER_PROFILE']);
    expect(sleeping.size).toBe(1);
  });
});

describe('classifyTuiProcessTree and loadDeclaredMcpSpecs', () => {
  const snap = (
    pid: number,
    ppid: number,
    processGroup: number,
    command: string,
  ): ProcessSnapshot => ({
    pid,
    ppid,
    processGroup,
    startTime: 'Thu Nov 26 10:00:00 2026',
    command,
  });

  test('loads declared stdio MCP specs for Claude (.mcp.json + global) and Codex (config.toml)', () => {
    const home = tempDir('stitchmux-mcp-specs-');
    const workdir = join(home, 'repo');
    const codexHome = join(home, '.codex');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(workdir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          localTool: { command: 'bunx', args: ['-y', '@acme/mcp-helper@1.2.3'] },
          httpOnly: { type: 'http', url: 'https://example.invalid' },
        },
      }),
    );
    writeFileSync(
      join(codexHome, 'config.toml'),
      '[mcp_servers.docs]\ncommand = "uvx"\nargs = ["mcp-docs-server"]\n',
    );
    const m = makeMachine({ stateDir: join(home, 'state'), codexHome });
    const claudeSpecs = loadDeclaredMcpSpecs(
      makeSession({ name: 'a', agent: 'claude', dir: workdir }),
      m,
      home,
    );
    expect(claudeSpecs).toContainEqual({
      name: 'localTool',
      command: 'bunx',
      args: ['-y', '@acme/mcp-helper@1.2.3'],
    });
    expect(claudeSpecs.some((s) => s.name === 'httpOnly')).toBe(false);

    const codexSpecs = loadDeclaredMcpSpecs(
      makeSession({ name: 'b', agent: 'codex', dir: workdir }),
      m,
      home,
    );
    expect(codexSpecs).toContainEqual({
      name: 'docs',
      command: 'uvx',
      args: ['mcp-docs-server'],
    });
  });

  test('allows declared direct/launcher MCP subtrees and caffeinate; rejects shells, unknown workers and pgid orphans', () => {
    const specs: DeclaredMcpSpec[] = [
      { name: 'direct', command: '/usr/local/bin/my-mcp', args: ['--stdio'] },
      { name: 'launcher', command: 'bunx', args: ['-y', '@acme/mcp-helper@latest'] },
    ];
    const cleanRows: ProcessSnapshot[] = [
      snap(100, 1, 100, '/usr/local/bin/stitchmux _run agent-a'),
      snap(101, 100, 100, '/usr/local/bin/claude --resume 123'),
      snap(102, 101, 100, '/usr/local/bin/my-mcp --stdio'),
      snap(103, 101, 100, 'bunx -y @acme/mcp-helper@latest'),
      snap(104, 103, 100, 'node /tmp/.bunx-123/node_modules/@acme/mcp-helper/dist/index.js'),
      snap(105, 101, 100, 'caffeinate -i'),
    ];
    const clean = classifyTuiProcessTree({
      rows: cleanRows,
      panePid: 100,
      providerId: 'claude',
      mcpSpecs: specs,
    });
    expect(clean.ok).toBe(true);
    expect(clean.agentPid).toBe(101);
    expect(clean.backgroundProcesses).toEqual([]);

    // Negative controls: undeclared node server, bun test, shell child, shell under MCP, pgid-orphan.
    const negatives: Array<[string, ProcessSnapshot]> = [
      ['undeclared node server', snap(201, 101, 100, 'node /tmp/work/server.js')],
      ['bun test runner', snap(202, 101, 100, 'bun test')],
      ['shell child', snap(203, 101, 100, '/bin/zsh -c sleep 60')],
      ['shell under MCP', snap(204, 104, 100, '/bin/sh -c curl example.invalid')],
      ['pgid orphan', snap(205, 1, 100, 'sleep 999')],
      ['extra direct pane child', snap(206, 100, 100, 'vite --port 3000')],
    ];
    for (const [label, extra] of negatives) {
      const verdict = classifyTuiProcessTree({
        rows: [...cleanRows, extra],
        panePid: 100,
        providerId: 'claude',
        mcpSpecs: specs,
      });
      expect(verdict.ok, `expected rejection for ${label}`).toBe(false);
      expect(verdict.reason, `expected background-processes for ${label}`).toBe(
        'background-processes',
      );
    }

    // Missing provider child fails closed with owner-unavailable.
    const noAgent = classifyTuiProcessTree({
      rows: [snap(100, 1, 100, '/usr/local/bin/stitchmux _run agent-a')],
      panePid: 100,
      providerId: 'claude',
      mcpSpecs: specs,
    });
    expect(noAgent.ok).toBe(false);
    expect(noAgent.reason).toBe('owner-unavailable');

    // Transient supervisor tmux probe child (`settlePrompts`) is excluded from tree & processes.
    const withProbe = classifyTuiProcessTree({
      rows: [
        ...cleanRows,
        snap(199, 100, 100, '/usr/local/bin/tmux -L sock capture-pane -p -t =agent-a'),
      ],
      panePid: 100,
      providerId: 'claude',
      tmuxBin: '/usr/local/bin/tmux',
      mcpSpecs: specs,
    });
    expect(withProbe.ok).toBe(true);
    expect(withProbe.processes.some((p) => p.pid === 199)).toBe(false);
  });

  test('loadDeclaredMcpSpecs expands ~/ CLAUDE_CONFIG_DIR and respects enabledPlugins vs disabled/marketplaces', () => {
    const home = tempDir('stitchmux-mcp-plugins-');
    const workdir = join(home, 'repo');
    const altCfg = join(home, '.claude-alt');
    const enabledPluginDir = join(altCfg, 'plugins', 'cache', 'mp', 'good-mcp', '1.0');
    const disabledPluginDir = join(altCfg, 'plugins', 'cache', 'mp', 'off-mcp', '1.0');
    const marketplaceDir = join(altCfg, 'plugins', 'marketplaces', 'mp', 'uninstalled');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(enabledPluginDir, { recursive: true });
    mkdirSync(disabledPluginDir, { recursive: true });
    mkdirSync(marketplaceDir, { recursive: true });

    writeFileSync(
      join(altCfg, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'good-mcp@mp': true, 'off-mcp@mp': false } }),
    );
    writeFileSync(
      join(altCfg, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'good-mcp@mp': [{ installPath: enabledPluginDir }],
          'off-mcp@mp': [{ installPath: disabledPluginDir }],
        },
      }),
    );
    writeFileSync(
      join(enabledPluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { goodTool: { command: '/usr/local/bin/good-mcp', args: ['--stdio'] } },
      }),
    );
    writeFileSync(
      join(disabledPluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { offTool: { command: '/usr/local/bin/off-mcp', args: ['--stdio'] } },
      }),
    );
    writeFileSync(
      join(marketplaceDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { mpTool: { command: '/usr/local/bin/mp-mcp', args: ['--stdio'] } },
      }),
    );

    const envFile = join(workdir, 'alt.env');
    writeFileSync(envFile, 'CLAUDE_CONFIG_DIR=~/.claude-alt\n');
    const m = makeMachine({ stateDir: join(home, 'state') });
    const specs = loadDeclaredMcpSpecs(
      makeSession({ name: 'a', agent: 'claude', dir: workdir, envFile }),
      m,
      home,
    );
    expect(specs.map((s) => s.name)).toEqual(['goodTool']);
  });

  test('matchesAnyMcpSpec enforces strict flag/runtime/cache-marker boundaries', () => {
    const flagOnlyBun: DeclaredMcpSpec[] = [{ name: 'bunFlag', command: 'bun', args: ['--stdio'] }];
    expect(matchesAnyMcpSpec('bun test', flagOnlyBun)).toBe(false);
    expect(matchesAnyMcpSpec('bun --stdio', flagOnlyBun)).toBe(true);

    const bareNode: DeclaredMcpSpec[] = [{ name: 'bare', command: 'node', args: [] }];
    expect(matchesAnyMcpSpec('node /tmp/work/server.js', bareNode)).toBe(false);

    const bunxSpec: DeclaredMcpSpec[] = [
      { name: 'helper', command: 'bunx', args: ['-y', '@acme/mcp-helper@1.0.0'] },
    ];
    // Generic workspace node_modules without launcher cache marker must NOT match.
    expect(
      matchesAnyMcpSpec('node /tmp/project/node_modules/@acme/mcp-helper/index.js', bunxSpec),
    ).toBe(false);
    expect(
      matchesAnyMcpSpec('node /tmp/.bunx-99/node_modules/@acme/mcp-helper/index.js', bunxSpec),
    ).toBe(true);

    // uvx --python <ver> must extract package name, not python version.
    const uvxSpec: DeclaredMcpSpec[] = [
      { name: 'docs', command: 'uvx', args: ['--python', '3.12', 'mcp-docs-server'] },
    ];
    expect(matchesAnyMcpSpec('python3 /tmp/.cache/uv/mcp-docs-server/run.py', uvxSpec)).toBe(true);
    expect(matchesAnyMcpSpec('python3 /tmp/.cache/uv/other/3.12.py', uvxSpec)).toBe(false);
  });
});

describe('computeIdleAnchorMs, wakeStore LRU eviction, backfill, lifecycle block, and readSleepSafe', () => {
  test('computeIdleAnchorMs protects freshly woken and brand-new sessions and fails closed on all-null', () => {
    const now = Date.UTC(2026, 10, 27, 10, 0, 0);
    const threeDaysAgo = now - 3 * 24 * 60 * 60_000;
    const fiveMinAgo = now - 5 * 60_000;

    // Freshly woken session with 3-day-old transcript gets awakeAtMs as its anchor.
    expect(
      computeIdleAnchorMs({
        lastActivityMs: threeDaysAgo,
        transcriptMtimeMs: threeDaysAgo,
        startedAtMs: fiveMinAgo,
        awakeAtMs: fiveMinAgo + 1000,
        paneWorkingMs: null,
        lifecycleTs: null,
        clientActivityMs: null,
      }),
    ).toBe(fiveMinAgo + 1000);

    // Brand-new empty session with no transcript uses startedAtMs.
    expect(
      computeIdleAnchorMs({
        lastActivityMs: null,
        transcriptMtimeMs: null,
        startedAtMs: fiveMinAgo,
        awakeAtMs: null,
        paneWorkingMs: null,
        lifecycleTs: null,
        clientActivityMs: null,
      }),
    ).toBe(fiveMinAgo);

    // Attached client activity protects a viewed pane.
    expect(
      computeIdleAnchorMs({
        lastActivityMs: threeDaysAgo,
        transcriptMtimeMs: threeDaysAgo,
        startedAtMs: threeDaysAgo,
        awakeAtMs: null,
        paneWorkingMs: null,
        lifecycleTs: null,
        clientActivityMs: now - 30_000,
      }),
    ).toBe(now - 30_000);

    // All-null fails closed (returns null so auto-sleep never guesses 0).
    expect(
      computeIdleAnchorMs({
        lastActivityMs: null,
        transcriptMtimeMs: null,
        startedAtMs: null,
        awakeAtMs: null,
        paneWorkingMs: null,
        lifecycleTs: null,
        clientActivityMs: null,
      }),
    ).toBeNull();
  });

  test('appendWakeOperation evicts oldest completed prior-cycle entries past 256 without bricking', () => {
    const target = {
      kind: 'managed' as const,
      source: 'stitchmux' as const,
      machine: 'host-a',
      agent: 'claude' as const,
      session: 'agent-a',
      threadId: '11111111-1111-4111-8111-111111111111',
    };
    const gen = crypto.randomUUID();
    let journal: WakeOperation[] = [];
    for (let i = 0; i < WAKE_JOURNAL_CAPACITY + 10; i++) {
      const sleepOp = crypto.randomUUID();
      const wakeOp = crypto.randomUUID();
      const result = SleepReceiptSchema.parse({
        target,
        registrationGeneration: gen,
        operationId: wakeOp,
        state: 'awake',
        release: 'processReleased',
        nativeId: target.threadId,
        duplicate: false,
      });
      const next = appendWakeOperation(
        journal,
        { operationId: wakeOp, sleepOperationId: sleepOp, result },
        sleepOp,
      );
      expect(next).not.toBeNull();
      journal = next ?? [];
    }
    expect(journal.length).toBe(WAKE_JOURNAL_CAPACITY);
  });

  test('registrationGeneration backfill and pinned toggling do not dirty LaunchStamp and preserve legacy LifecycleBlock', async () => {
    const root = tempDir('stitchmux-backfill-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const legacy = makeSession({ name: 'agent-a', agent: 'claude', dir: root });
    await writeSessionsUnlocked(m, [legacy]);

    const stampBefore = { ...computeStamp(legacy, m, '/usr/local/bin/stitchmux'), ts: Date.now() };
    await writeLifecycleBlock(m, {
      name: legacy.name,
      agent: legacy.agent,
      uuid: legacy.uuid,
      error: 'legacy crash',
      at: new Date().toISOString(),
    });

    const changed = await backfillRegistrationGenerations(m);
    expect(changed).toBe(1);
    expect(await backfillRegistrationGenerations(m)).toBe(0); // idempotent

    await setSessionPinned(m, legacy.name, true);
    const updated = loadSessions(m)[0];
    if (updated === undefined) throw new Error('expected updated session');
    expect(updated.registrationGeneration).toBeDefined();
    expect(updated.pinned).toBe(true);

    // Neither registrationGeneration nor pinned invalidates LaunchStamp.
    expect(launchStaleReasons(stampBefore, updated, m, '/usr/local/bin/stitchmux').reasons).toEqual(
      [],
    );

    // Legacy LifecycleBlock with generation === undefined still matches after backfill!
    expect(readLifecycleBlockForSession(m, updated)?.error).toBe('legacy crash');
  });

  test('readSleepSafe isolates corrupt sleep.json while strict readSleep still throws', () => {
    const root = tempDir('stitchmux-corrupt-sleep-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const s = makeSession({
      name: 'agent-a',
      agent: 'claude',
      dir: root,
      registrationGeneration: crypto.randomUUID(),
    });
    const runtimeRoot = managedRuntimeRoot(m, s);
    privateRuntimeDirectory(runtimeRoot);
    writeFileSync(join(runtimeRoot, 'sleep.json'), '{not-valid-json', { mode: 0o600 });

    expect(() => readSleep(m, s)).toThrow();
    expect(readSleepSafe(m, s)).toBeNull();
  });

  test('appendWakeOperation evicts stale null-result prior-cycle entries before completed ones', () => {
    const target = {
      kind: 'managed' as const,
      source: 'stitchmux' as const,
      machine: 'host-a',
      agent: 'claude' as const,
      session: 'agent-a',
      threadId: '11111111-1111-4111-8111-111111111111',
    };
    const gen = crypto.randomUUID();
    const staleNullOp = crypto.randomUUID();
    const journal: WakeOperation[] = [];
    for (let i = 0; i < WAKE_JOURNAL_CAPACITY; i++) {
      const sleepOp = crypto.randomUUID();
      if (i === 100) {
        journal.push({ operationId: staleNullOp, sleepOperationId: sleepOp, result: null });
      } else {
        const wakeOp = crypto.randomUUID();
        journal.push({
          operationId: wakeOp,
          sleepOperationId: sleepOp,
          result: SleepReceiptSchema.parse({
            target,
            registrationGeneration: gen,
            operationId: wakeOp,
            state: 'awake',
            release: 'processReleased',
            nativeId: target.threadId,
            duplicate: false,
          }),
        });
      }
    }
    const activeSleep = crypto.randomUUID();
    const freshWake = crypto.randomUUID();
    const next = appendWakeOperation(
      journal,
      { operationId: freshWake, sleepOperationId: activeSleep, result: null },
      activeSleep,
    );
    expect(next).not.toBeNull();
    expect(next?.length).toBe(WAKE_JOURNAL_CAPACITY);
    // Stale null-result prior-cycle entry at index 100 was evicted first, keeping index 0 intact.
    expect(next?.some((item) => item.operationId === staleNullOp)).toBe(false);
    expect(next?.[0]?.operationId).toBe(journal[0]?.operationId);
  });

  test('native idleProof rejects PID-reused background process whose startTime differs from ownership.baseline', async () => {
    const { OwnedCodexProjection } = await import('../src/agent/codex/owned/projection.ts');
    const { OwnedCodexStatusWriter } = await import('../src/agent/codex/owned/status.ts');
    const root = tempDir('stitchmux-pid-reuse-');
    const tmuxBin = Bun.which('tmux');
    if (tmuxBin === null) throw Error('tmux is required');
    const m = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      tmuxBin,
      tmuxSocket: `stitchmux-pid-reuse-${process.pid}-${crypto.randomUUID()}`,
    });
    // The non-delegated Codex terminal at its idle composer, so only the process tree decides.
    const frame = join(root, 'frame');
    writeFileSync(frame, codexFrames.idle);
    Bun.spawnSync(
      tmuxArgv(
        m,
        'new-session',
        '-d',
        '-x',
        '120',
        '-y',
        '40',
        '-s',
        'native-codex',
        `cat ${frame}; exec sleep 600`,
      ),
    );
    afterEachKill.push(() => Bun.spawnSync(tmuxArgv(m, 'kill-server')));
    await Bun.sleep(300);
    const s = makeSession({
      name: 'native-codex',
      agent: 'codex',
      runtime: 'app-server',
      dir: root,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [s]);
    const now = Date.now();
    const ownerPid = process.pid;
    const reusedPid = ownerPid + 100_001;
    const projection = new OwnedCodexProjection(m, s, ownerPid);
    const writer = new OwnedCodexStatusWriter(m, s.name);
    await writer.write({
      ...projection.snapshot(),
      pid: ownerPid,
      providerPid: ownerPid,
      connected: true,
      state: 'idle',
      reason: null,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5_000).toISOString(),
    });

    const runtimeRoot = managedRuntimeRoot(m, s);
    privateRuntimeDirectory(runtimeRoot);
    writeFileSync(
      join(runtimeRoot, 'owned-process.json'),
      JSON.stringify({
        registrationGeneration: s.registrationGeneration,
        owner: { pid: ownerPid, startTime: 'T0', processGroup: ownerPid },
        provider: { pid: ownerPid, startTime: 'T0', processGroup: ownerPid },
        baseline: [
          { pid: ownerPid, startTime: 'T0', processGroup: ownerPid },
          { pid: reusedPid, startTime: 'T0', processGroup: ownerPid },
        ],
      }),
      { mode: 0o600 },
    );

    // Same PID as baseline, but NEW startTime 'T1' (PID reuse) -> MUST be rejected!
    const rows: ProcessSnapshot[] = [
      {
        pid: ownerPid,
        ppid: 1,
        processGroup: ownerPid,
        startTime: 'T0',
        command: 'stitchmux _run',
      },
      {
        pid: reusedPid,
        ppid: ownerPid,
        processGroup: ownerPid,
        startTime: 'T1',
        command: 'bun test',
      },
    ];
    const proof = await idleProof(m, s, { rows, now });
    expect(proof.eligible).toBe(false);
    expect(proof.reason).toBe('background-processes');
    expect(proof.background).toBe(1);
  });

  test('sleepSession refuses IDEMPOTENCY_CONFLICT when forcePolicy changes on same operationId replay', async () => {
    const root = tempDir('stitchmux-idemp-force-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const s = makeSession({
      name: 'agent-a',
      agent: 'claude',
      dir: root,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [s]);
    const opId = crypto.randomUUID();
    const rev = 'b'.repeat(64);
    const nowIso = new Date().toISOString();
    await writeSleep(
      m,
      s,
      SleepRecordSchema.parse({
        target: managedPeer(m.rcPrefix, s),
        registrationGeneration: s.registrationGeneration,
        operationId: opId,
        phase: 'sleeping',
        forcePolicy: false,
        updatedAt: nowIso,
        proof: {
          target: managedPeer(m.rcPrefix, s),
          registrationGeneration: s.registrationGeneration,
          revision: rev,
          generation: null,
          eligible: true,
          run: 'idle',
          queue: 0,
          approvals: 0,
          children: 0,
          background: 0,
          reason: null,
          observedAt: nowIso,
          processes: [],
        },
      }),
    );
    await expect(
      sleepSession(
        m,
        {
          target: managedPeer(m.rcPrefix, s),
          registrationGeneration: s.registrationGeneration as string,
          operationId: opId,
          revision: rev,
          forcePolicy: true,
        },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
