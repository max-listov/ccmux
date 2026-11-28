import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedAntigravityTier,
  freshHostCatalog,
  readAntigravityModels,
} from '../src/agent/antigravity/catalog.ts';
import {
  antigravityLaunchOptions,
  antigravityProfileId,
  namedAntigravityProfiles,
  selectAntigravityProfile,
  verifyAntigravityProfile,
} from '../src/agent/antigravity/namedProfiles.ts';
import { AntigravityOwner } from '../src/agent/antigravity/owner.ts';
import {
  ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
  preflightAntigravity,
} from '../src/agent/antigravity/preflight.ts';
import { antigravityTranscriptPath } from '../src/agent/antigravity/transcript.ts';
import {
  isAntigravityProfileBinding,
  isClaudeProfileBinding,
} from '../src/config/antigravityProfileSchema.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { discoverTargets } from '../src/quota/discover.ts';
import { probeAntigravity } from '../src/quota/probe.ts';
import { appendSession } from '../src/session/registry.ts';
import { SessionSchema } from '../src/session/schema.ts';
import { sessionProfileKey } from '../src/session/sleep/profilePolicy.ts';
import { makeMachine, makeSession } from './helpers.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

test('SessionSchema preserves existing Claude profile bindings alongside new Antigravity bindings', () => {
  const claudeRow = SessionSchema.parse({
    name: 'claude-a',
    dir: '/tmp/work',
    uuid: crypto.randomUUID(),
    agent: 'claude',
    profile: {
      source: 'machine',
      name: '2',
      configDir: '/tmp/.claude-2',
    },
  });
  expect(isClaudeProfileBinding(claudeRow.profile)).toBe(true);
  expect(isAntigravityProfileBinding(claudeRow.profile)).toBe(false);

  const agRow = SessionSchema.parse({
    name: 'ag-a',
    dir: '/tmp/work',
    uuid: crypto.randomUUID(),
    agent: 'antigravity',
    runtime: 'native',
    profile: {
      agent: 'antigravity',
      source: 'machine',
      name: '2',
      dataDir: '/tmp/.gemini/antigravity-cli-2',
      storage: 'file',
      accountDigest: 'a'.repeat(64),
    },
  });
  expect(isAntigravityProfileBinding(agRow.profile)).toBe(true);
  expect(isClaudeProfileBinding(agRow.profile)).toBe(false);
});

test('named Antigravity profiles pin directory + accountDigest, enforce >= 1.5.18, and isolate transcripts/sleep keys', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stitchmux-ag-prof-')));
  const defaultDir = join(root, '.gemini', 'antigravity-cli');
  const secondDir = join(root, '.gemini', 'antigravity-cli-2');
  const otherDir = join(root, 'custom', 'ag-3');
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(secondDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(
    join(secondDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: { access_token: 'stub' },
      auth_method: 'consumer',
      id_token_email: 'second@example.test',
    }),
  );
  const bin1514 = join(root, 'agy-1514');
  writeFileSync(bin1514, '#!/bin/sh\necho "1.5.14"\n', { mode: 0o700 });
  const bin1518 = join(root, 'agy-1518');
  writeFileSync(bin1518, '#!/bin/sh\necho "1.5.18"\n', { mode: 0o700 });

  const m = makeMachine({
    antigravityBin: bin1518,
    antigravityDataDir: defaultDir,
    antigravityProfiles: {
      '2': { dataDir: secondDir },
      custom: { dataDir: otherDir },
    },
  });

  try {
    expect(namedAntigravityProfiles(m).map((p) => p.name)).toEqual(['default', '2', 'custom']);
    expect(() =>
      namedAntigravityProfiles({ antigravityProfiles: { default: { dataDir: secondDir } } }),
    ).toThrow(/Ambiguous/);

    const binding = selectAntigravityProfile(m, '2', { home: root });
    expect(binding.storage).toBe('file');
    expect(binding.dataDir).toBe(secondDir);
    expect(binding.accountDigest).toMatch(/^[a-f0-9]{64}$/);

    // Launch options keep relative --app_data_dir under ~/.gemini and force file token storage.
    const launch2 = antigravityLaunchOptions(m, binding, root);
    expect(launch2.forceFileStorage).toBe(true);
    expect(launch2.dirFlags).toEqual(['--app_data_dir', 'antigravity-cli-2']);
    expect(launch2.extraEnv).toEqual({ AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1' });

    const bindingCustom = selectAntigravityProfile(m, 'custom', { home: root });
    const launchCustom = antigravityLaunchOptions(m, bindingCustom, root);
    expect(launchCustom.dirFlags).toEqual([
      '--gemini_dir',
      join(root, 'custom'),
      '--app_data_dir',
      'ag-3',
    ]);
    expect(antigravityProfileId(binding)).not.toBe(antigravityProfileId(bindingCustom));

    // Named profiles require agy >= 1.5.18; 1.5.14 is rejected with executable path.
    await expect(
      preflightAntigravity({ ...m, antigravityBin: bin1514 }, [], {
        minVersion: ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
        dataDir: secondDir,
      }),
    ).rejects.toThrow(/1\.5\.18/);
    expect(
      await preflightAntigravity(m, [], {
        minVersion: ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
        dataDir: secondDir,
      }),
    ).toBe(bin1518);

    // Rename keeping the same physical directory passes verification.
    verifyAntigravityProfile(
      { ...m, antigravityProfiles: { renamed: { dataDir: secondDir } } },
      binding,
      root,
    );
    // Reassigning the same label to a different directory fails.
    expect(() =>
      verifyAntigravityProfile(
        { ...m, antigravityProfiles: { '2': { dataDir: otherDir } } },
        binding,
        root,
      ),
    ).toThrow(/different directory/);

    // Swapping the signed-in Google account inside the profile stops restarts with a clear error.
    writeFileSync(
      join(secondDir, 'antigravity-oauth-token'),
      JSON.stringify({
        token: { access_token: 'stub2' },
        auth_method: 'consumer',
        id_token_email: 'other@example.test',
      }),
    );
    expect(() => verifyAntigravityProfile(m, binding, root)).toThrow(/pinned account/);

    // Transcripts and sleep policy keys are isolated per profile.
    const nativeId = crypto.randomUUID();
    const sDefault = makeSession({
      name: 'ag-def',
      agent: 'antigravity',
      runtime: 'native',
      nativeSession: { runtime: 'antigravity', id: nativeId, version: '1.5.18' },
    });
    const sSecond = makeSession({
      name: 'ag-2',
      agent: 'antigravity',
      runtime: 'native',
      profile: binding,
      nativeSession: { runtime: 'antigravity', id: nativeId, version: '1.5.18' },
    });
    expect(antigravityTranscriptPath(sDefault, m)).toBe(
      join(defaultDir, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl'),
    );
    expect(antigravityTranscriptPath(sSecond, m)).toBe(
      join(secondDir, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl'),
    );
    expect(sessionProfileKey(sDefault, m, root)).toEqual({ key: `antigravity:${defaultDir}` });
    expect(sessionProfileKey(sSecond, m, root)).toEqual({ key: `antigravity:${secondDir}` });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverTargets, probeAntigravity, and CLI profiles list/doctor/login isolate two Antigravity profiles', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stitchmux-ag-cli-prof-')));
  const home = join(root, 'home');
  const defaultDir = join(home, '.gemini', 'antigravity-cli');
  const secondDir = join(home, '.gemini', 'antigravity-cli-2');
  const thirdDir = join(home, '.gemini', 'antigravity-cli-3');
  const invocations = join(root, 'invocations.jsonl');
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(secondDir, { recursive: true });
  writeFileSync(
    join(defaultDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: { access_token: 'tok-1' },
      auth_method: 'consumer',
      id_token_email: 'one@example.test',
    }),
  );
  writeFileSync(
    join(secondDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: { access_token: 'tok-2' },
      auth_method: 'consumer',
      id_token_email: 'two@example.test',
    }),
  );

  const agy = join(root, 'agy');
  writeFileSync(
    agy,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('1.5.18');
  process.exit(0);
}
appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({
  args,
  forceFile: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE ?? null,
  home: process.env.HOME ?? null,
}) + '\\n');
if (args[0] === 'acp' && args.includes('--login')) {
  console.log('Logged in as three@example.test.');
  process.exit(0);
}
const isSecond = args.includes('antigravity-cli-2');
console.log(JSON.stringify({
  status: 'SUCCESS',
  num_turns: 0,
  conversation_id: '',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: isSecond ? 1 : 0.1, reset_time: '2026-12-01T00:00:00Z' },
          ],
        },
      ],
    },
  },
}));
`,
  );
  chmodSync(agy, 0o755);
  const tmux = join(root, 'tmux');
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const claude = join(root, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const state = join(root, 'state');
  const m = MachineConfigSchema.parse({
    claudeBin: claude,
    antigravityBin: agy,
    antigravityDataDir: defaultDir,
    antigravityProfiles: {
      '2': { dataDir: secondDir },
      '3': { dataDir: thirdDir },
    },
    tmuxBin: tmux,
    projectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    rcPrefix: 'host-a',
    stateDir: state,
    bootLabel: 'stitchmux-test.service',
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(m));

  try {
    // 1. Quota discovery finds default and signed-in profile 2 (not unsigned 3).
    const targets = discoverTargets(m, [], { scan: true, home });
    expect(targets.map((t) => t.key)).toEqual(['antigravity:default', `antigravity:${secondDir}`]);

    const [t1, t2] = targets;
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    if (!t1 || !t2) throw new Error('expected two targets');
    const res1 = await probeAntigravity(m, t1);
    const res2 = await probeAntigravity(m, t2);
    expect(res1.ok && res1.label).toBe('one@example.test');
    expect(res1.ok && res1.limits.windows[0]?.percent).toBe(90);
    expect(res2.ok && res2.label).toBe('two@example.test');
    expect(res2.ok && res2.limits.windows[0]?.percent).toBe(0);

    // 2. CLI profiles list, doctor, and login.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.HOME = home;
    env.STITCHMUX_CONFIG = config;
    env.STITCHMUX_STATE_DIR = state;

    const runCli = async (...args: string[]) => {
      const p = Bun.spawn(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stdout, stderr, code };
    };

    const listRes = await runCli('profiles', 'list', '--agent', 'antigravity', '--json');
    expect(listRes.code).toBe(0);
    const listed = JSON.parse(listRes.stdout) as { name: string; email: string | null }[];
    expect(listed.map((p) => [p.name, p.email])).toEqual([
      ['default', 'one@example.test'],
      ['2', 'two@example.test'],
      ['3', null],
    ]);

    const doc2 = await runCli(
      'profiles',
      'doctor',
      '--agent',
      'antigravity',
      '--profile',
      '2',
      '--json',
    );
    expect(doc2.code).toBe(0);
    expect(JSON.parse(doc2.stdout)).toMatchObject({
      name: '2',
      loggedIn: true,
      email: 'two@example.test',
      version: '1.5.18',
    });

    const doc3 = await runCli(
      'profiles',
      'doctor',
      '--agent',
      'antigravity',
      '--profile',
      '3',
      '--json',
    );
    expect(doc3.code).toBe(1);
    expect(JSON.parse(doc3.stdout)).toMatchObject({ name: '3', loggedIn: false });

    // Login creates missing thirdDir and runs `agy acp --app_data_dir antigravity-cli-3 --login`
    // with AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 and real HOME preserved.
    expect(existsSync(thirdDir)).toBe(false);
    const login3 = await runCli('profiles', 'login', '--agent', 'antigravity', '--profile', '3');
    expect(login3.code).toBe(0);
    expect(existsSync(thirdDir)).toBe(true);
    expect(login3.stdout).toContain('Logged in as three@example.test.');

    const calls = readFileSync(invocations, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { args: string[]; forceFile: string | null; home: string },
      );
    const loginCall = calls.at(-1);
    expect(loginCall?.forceFile).toBe('1');
    expect(loginCall?.home).toBe(home);
    expect(loginCall?.args).toEqual(['acp', '--app_data_dir', 'antigravity-cli-3', '--login']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Antigravity catalog and owner isolate host model caches and pass --app_data_dir + AGY_CLI_FORCE_FILE_TOKEN_STORAGE', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stitchmux-ag-cat-prof-')));
  const defaultDir = join(root, 'ag-default');
  const secondDir = join(root, 'ag-second');
  const stateDir = join(root, 'state');
  const workspace = join(root, 'work');
  const spawnLog = join(root, 'acp-spawns.jsonl');
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(secondDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(defaultDir, 'installation_id'), 'def-id\n');
  writeFileSync(
    join(secondDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: { access_token: 'tok' },
      auth_method: 'consumer',
      id_token_email: 'second@example.test',
    }),
  );

  const agy = join(root, 'agy');
  writeFileSync(
    agy,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.5.18');
  process.exit(0);
}
appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({
  args,
  forceFile: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE ?? null,
}) + '\\n');
const isSecond = args.includes('ag-second');
const modelId = isSecond ? 'gemini-second-tier' : 'gemini-default-tier';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl < 0) break;
    const raw = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'antigravity-cli', version: '1.5.18' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            sessionCapabilities: { load: {}, resume: {}, close: {} },
          },
        },
      });
    } else if (msg.method === 'session/new') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: '22222222-2222-4222-8222-222222222222',
          _meta: {
            antigravity: {
              tier: {
                name: isSecond ? 'Google AI Pro' : 'Google AI Ultra',
                id: isSecond ? 'g1-pro-tier' : 'g1-ultra-lite-tier',
              },
            },
          },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: modelId,
              options: [{ value: modelId, name: modelId }],
            },
          ],
        },
      });
    } else if (msg.method === 'session/set_config_option') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: modelId,
              options: [{ value: modelId, name: modelId }],
            },
          ],
        },
      });
    } else if (msg.method === 'session/close') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  chmodSync(agy, 0o755);

  const m = makeMachine({
    antigravityBin: agy,
    antigravityDataDir: defaultDir,
    antigravityProfiles: { '2': { dataDir: secondDir } },
    stateDir,
    rcPrefix: 'host-a',
  });

  try {
    const controller = new AbortController();
    const defCat = await readAntigravityModels(
      m,
      { runtime: 'antigravity' },
      undefined,
      controller.signal,
    );
    const secCat = await readAntigravityModels(
      m,
      { runtime: 'antigravity', profile: '2' },
      undefined,
      controller.signal,
    );

    expect(defCat.data.map((row) => row.id)).toEqual(['gemini-default-tier']);
    expect(secCat.data.map((row) => row.id)).toEqual(['gemini-second-tier']);

    const binding = selectAntigravityProfile(m, '2');
    const secProfileId = antigravityProfileId(binding);
    expect(secProfileId).not.toBe('default');
    expect(existsSync(join(stateDir, 'native-runtime', 'antigravity-host-models.json'))).toBe(true);
    expect(
      existsSync(join(stateDir, 'native-runtime', `antigravity-host-models-${secProfileId}.json`)),
    ).toBe(true);
    expect(freshHostCatalog(m, Date.now(), 'default')?.models[0]?.id).toBe('gemini-default-tier');
    expect(freshHostCatalog(m, Date.now(), secProfileId)?.models[0]?.id).toBe('gemini-second-tier');
    expect(cachedAntigravityTier(m, 'default')).toBe('Google AI Ultra');
    expect(cachedAntigravityTier(m, secProfileId)).toBe('Google AI Pro');

    // Remove the host cache file to verify cachedAntigravityTier also reads from a live session's models.json.
    rmSync(join(stateDir, 'native-runtime', `antigravity-host-models-${secProfileId}.json`));
    expect(cachedAntigravityTier(m, secProfileId)).toBeNull();

    const session = makeSession({
      name: 'ag-sec',
      dir: workspace,
      agent: 'antigravity',
      runtime: 'native',
      registrationGeneration: crypto.randomUUID(),
      profile: binding,
    });
    const owner = new AntigravityOwner(m, session, async () => {});
    await owner.open();
    await appendSession(m, owner.identity);
    expect(cachedAntigravityTier(m, secProfileId)).toBe('Google AI Pro');
    await owner.close();

    const spawns = readFileSync(spawnLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; forceFile: string | null });
    expect(spawns).toHaveLength(3);
    expect(spawns[0]?.forceFile).toBeNull();
    expect(spawns[0]?.args).toContain('ag-default');
    expect(spawns[1]?.forceFile).toBe('1');
    expect(spawns[1]?.args).toContain('ag-second');
    expect(spawns[2]?.forceFile).toBe('1');
    expect(spawns[2]?.args).toContain('--gemini_dir');
    expect(spawns[2]?.args).toContain('ag-second');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
