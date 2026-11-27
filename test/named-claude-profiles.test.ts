import { expect, onTestFinished, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { histFile } from '../src/agent/claude/resume.ts';
import { lifecycleBlockPath } from '../src/config/paths.ts';
import { prepareNativeFork } from '../src/context/fork.ts';
import { loadSessions } from '../src/session/registry.ts';
import { makeMachine, makePeer, shortTempDir } from './helpers.ts';

function fixture() {
  const dir = realpathSync(shortTempDir('ccmux-profiles-'));
  const local = join(dir, 'team');
  const imported = join(dir, 'second');
  const registry = join(dir, '.config', 'claude-multiprofile', 'profiles.json');
  for (const path of [local, imported, dirname(registry)]) mkdirSync(path, { recursive: true });
  const config = join(dir, 'machine.json');
  const log = join(dir, 'launches');
  const provider = join(dir, 'claude');
  writeFileSync(
    provider,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2), env = process.env;
if (argv[0] === 'auth') {
  if (argv.join(' ') !== 'auth status --json') process.exit(5);
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.test' }));
} else {
  const mode = argv.includes('--resume') ? '--resume' : '--session-id';
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({mode, uuid: argv[argv.indexOf(mode)+1], dir: env.CLAUDE_CONFIG_DIR, project: env.PROJECT_LABEL, override: Boolean(env.ANTHROPIC_AUTH_TOKEN)})+'\\n');
  console.log('❯\\n? for shortcuts');
  await Bun.sleep(60_000);
}`,
    { mode: 0o700 },
  );
  const tmuxBin = Bun.which('tmux');
  assert(tmuxBin);
  const socket = `profile-${crypto.randomUUID()}`;
  const m = makeMachine({
    tmuxBin,
    tmuxSocket: socket,
    claudeBin: provider,
    projectsDir: join(dir, '.claude', 'projects'),
    stateDir: join(dir, 'state'),
    claudeProfiles: { team: local },
  });
  writeFileSync(config, JSON.stringify(m));
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    CCMUX_CONFIG: config,
    CCMUX_STATE_DIR: m.stateDir,
    ANTHROPIC_AUTH_TOKEN: 'fixture-override',
  };
  onTestFinished(() =>
    Bun.spawnSync([tmuxBin, '-L', socket, 'kill-server'], {
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  );
  const run = async (argv: string[], extraEnv: Record<string, string> = {}) => {
    const child = Bun.spawn(argv, {
      cwd: dir,
      env: { ...env, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out, err };
  };
  const cli = (...args: string[]) =>
    run([process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), ...args]);
  const register = (name = '2', configDir = imported) =>
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        profiles: [
          { name, code: { configDir }, extra: true },
          { name: 'desktop', desktop: {}, code: null },
        ],
      }),
    );
  const launches = (): {
    mode: string;
    uuid: string;
    dir: string;
    project: string;
    override: boolean;
  }[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { dir, local, imported, registry, m, config, run, cli, register, launches };
}

async function until(check: () => boolean) {
  for (const end = Date.now() + 8_000; !check() && Date.now() < end; ) await Bun.sleep(30);
  expect(check()).toBe(true);
}

test('local profiles work without a manager; discovery ignores Desktop-only entries and diagnoses bad registries and ambiguous names', async () => {
  const w = fixture();
  const absent = await w.cli('profiles', 'list', '--json');
  expect(absent.code).toBe(0);
  expect(JSON.parse(absent.out).map((p: { name: string }) => p.name)).toEqual(['default', 'team']);
  const doctor = await w.cli('profiles', 'doctor', '--profile', 'team', '--json');
  expect(doctor.code).toBe(0);
  expect(JSON.parse(doctor.out)).toEqual({
    name: 'team',
    source: 'machine',
    loggedIn: true,
    authMethod: 'claude.ai',
    error: null,
  });
  w.register();
  const listed = await w.cli('profiles', 'list', '--json');
  expect(JSON.parse(listed.out).map((p: { name: string }) => p.name)).toEqual([
    'default',
    'team',
    '2',
  ]);
  w.register('team');
  expect((await w.cli('profiles', 'list')).err).toContain('Ambiguous Claude profile name: team');
  writeFileSync(w.registry, '{');
  expect((await w.cli('profiles', 'list')).err).toContain('Invalid JSON');
  const def = await w.cli('profiles', 'doctor', '--profile', 'default', '--json');
  expect(def.code).toBe(0);
  expect(w.launches()).toEqual([]);
});

test('operator creates and restarts the same conversation in its selected account; a changed login blocks before Claude runs', async () => {
  const w = fixture();
  w.register();
  const login = join(w.imported, '.claude.json');
  const account = (id: string) =>
    writeFileSync(login, JSON.stringify({ oauthAccount: { accountUuid: id } }));
  account('first-fixture-account');
  const projectEnv = join(w.dir, 'project.env');
  writeFileSync(projectEnv, 'PROJECT_LABEL=kept\n');
  const created = await w.cli(
    'new',
    'worker',
    w.dir,
    '--profile',
    '2',
    '--env-file',
    projectEnv,
    '--timeout',
    '6',
  );
  expect(created.code, created.out + created.err).toBe(0);
  const session = loadSessions(w.m)[0];
  assert(session);
  expect(session.profile).toMatchObject({
    name: '2',
    source: 'claude-multiprofile',
    configDir: w.imported,
  });
  expect(w.launches()).toEqual([
    { mode: '--session-id', uuid: session.uuid, dir: w.imported, project: 'kept', override: false },
  ]);
  expect((await w.cli('stop', 'worker')).code).toBe(0);
  const history = histFile(w.dir, session.uuid, join(w.imported, 'projects'));
  mkdirSync(dirname(history), { recursive: true });
  appendFileSync(
    history,
    '{"type":"user","message":{"role":"user","content":"fixture history"}}\n',
  );
  w.register('renamed');
  expect((await w.cli('start', 'worker')).code).toBe(0);
  await until(() => w.launches().length === 2);
  expect(w.launches()[1]).toEqual({
    mode: '--resume',
    uuid: session.uuid,
    dir: w.imported,
    project: 'kept',
    override: false,
  });
  expect((await w.cli('stop', 'worker')).code).toBe(0);
  account('second-fixture-account');
  expect((await w.cli('start', 'worker')).code).toBe(0);
  const block = lifecycleBlockPath(w.m, 'worker');
  await until(() => existsSync(block));
  expect(readFileSync(block, 'utf8')).toContain('no longer identifies the pinned account');
  expect(w.launches()).toHaveLength(2);
  expect(loadSessions(w.m)[0]?.uuid).toBe(session.uuid);
}, 25_000);

test('new refuses unknown names, unsupported agents and env declarations for a different account before registration', async () => {
  const w = fixture();
  w.register();
  const create = (...flags: string[]) => w.cli('new', 'worker', w.dir, ...flags);
  const unknown = await create('--profile', 'absent');
  expect(unknown.code).toBe(1);
  expect(unknown.out).toContain('Unknown Claude profile');
  const wrongAgent = await create('--profile', '2', '--agent', 'antigravity');
  expect(wrongAgent.out).toContain('available for Claude only');
  const env = join(w.dir, 'other.env');
  writeFileSync(env, `CLAUDE_CONFIG_DIR=${w.local}\n`);
  expect((await create('--profile', '2', '--env-file', env)).out).toContain(
    'conflicts with CLAUDE_CONFIG_DIR',
  );
  writeFileSync(env, 'CLAUDE_CODE_OAUTH_TOKEN=fixture-value\n');
  const credential = await create('--profile', '2', '--env-file', env);
  expect(credential.out).toContain('conflicts with CLAUDE_CODE_OAUTH_TOKEN');
  expect(credential.out).not.toContain('fixture-value');
  expect(loadSessions(w.m)).toEqual([]);
  expect(w.launches()).toEqual([]);
});

test('native fork copies the selected account’s transcript when tmux inherited a different profile', async () => {
  const w = fixture();
  const sdk = join(w.dir, 'sdk');
  mkdirSync(sdk);
  // Exercise the vendor's real on-disk fork. The query never opens a provider connection.
  writeFileSync(
    join(sdk, 'sdk.mjs'),
    `
export { forkSession } from ${JSON.stringify(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))};
export function query() {
  let stop;
  const closed = new Promise(resolve=>{stop=resolve;});
  return { async *[Symbol.asyncIterator]() { await closed; }, close:stop, interrupt:async()=>{},
    initializationResult:async()=>({}),supportedModels:async()=>[],supportedCommands:async()=>[],
    accountInfo:async()=>({}),mcpServerStatus:async()=>[] };
}`,
  );
  writeFileSync(
    w.config,
    JSON.stringify({
      ...w.m,
      claudeNativeRuntime: true,
      claudeNativeSdk: sdk,
      codexCorrelationTimeoutMs: 10_000,
    }),
  );
  const script = join(w.dir, 'fork.ts');
  writeFileSync(
    script,
    `
import {createNativeBootstrap} from ${JSON.stringify(import.meta.resolve('../src/session/create.ts'))};
import {loadMachineConfig} from ${JSON.stringify(import.meta.resolve('../src/config/machine.ts'))};
import {selectClaudeProfile} from ${JSON.stringify(import.meta.resolve('../src/agent/claude/namedProfiles.ts'))};
const [name,registrationGeneration,sourceThreadId]=Bun.argv.slice(2), m=loadMachineConfig();
const row=await createNativeBootstrap(m,{name:'fork-'+name,dir:process.cwd(),agent:'claude',runtime:'native',
  flags:[],router:false,profile:selectClaudeProfile(m,'claude',name),registrationGeneration},{kind:'fork',sourceThreadId});
console.log(JSON.stringify({id:row.nativeSession.id,profile:row.profile.name}));`,
  );
  for (const [name, selected] of [
    ['team', w.local],
    ['default', join(w.dir, '.claude')],
  ] as const) {
    const id = crypto.randomUUID(),
      generation = crypto.randomUUID();
    for (const [root, label] of [
      [selected, 'selected'],
      [w.imported, 'other'],
    ] as const) {
      const file = histFile(w.dir, id, join(root, 'projects'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          type: 'user',
          uuid: crypto.randomUUID(),
          parentUuid: null,
          isSidechain: false,
          sessionId: id,
          cwd: w.dir,
          version: '2.0.0',
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'fixture ' + label },
        }) + '\n',
      );
    }
    await prepareNativeFork(w.m, generation, {
      target: makePeer({ threadId: id }),
      registration: id,
      generation: id,
      nativeId: id,
      turnId: null,
    });
    const result = await w.run([process.execPath, '--no-env-file', script, name, generation, id], {
      CLAUDE_CONFIG_DIR: w.imported,
    });
    expect(result.code, result.out + result.err).toBe(0);
    const fork = JSON.parse(result.out);
    expect(fork.profile).toBe(name);
    expect(fork.id).not.toBe(id);
    expect(readFileSync(histFile(w.dir, fork.id, join(selected, 'projects')), 'utf8')).toContain(
      'fixture selected',
    );
    expect(existsSync(histFile(w.dir, fork.id, join(w.imported, 'projects')))).toBe(false);
  }
}, 30_000);
