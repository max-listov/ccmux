import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectClaudeProfile, verifyClaudeProfile } from '../src/agent/claude/namedProfiles.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import type { CreateManagedInput } from '../src/session/create.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { makeMachine, makeSession, shortTempDir } from './helpers.ts';

test('a control retry keeps the admitted account after registry drift and rejects a different requested profile', async () => {
  const workspace = realpathSync(shortTempDir('ccmux-profile-control-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workspace;
  onTestFinished(() => {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
  });
  const m = makeMachine({ stateDir: join(workspace, 'state') });
  const registryDir = join(workspace, 'claude-multiprofile');
  const dir = join(workspace, 'work');
  const other = join(workspace, 'other');
  for (const path of [registryDir, dir, other]) mkdirSync(path);
  const registry = join(registryDir, 'profiles.json');
  const declare = (configDir: string) =>
    writeFileSync(
      registry,
      JSON.stringify({ version: 1, profiles: [{ name: 'work', code: { configDir } }] }),
    );
  declare(dir);
  const pinned = selectClaudeProfile(m, 'claude', 'work');
  let called = 0;
  const create = async (_host: typeof m, input: CreateManagedInput) => {
    called++;
    const session = makeSession({ ...input, uuid: crypto.randomUUID() });
    await writeSessionsUnlocked(m, [session]);
    return session;
  };
  const input = {
    runtime: 'claude' as const,
    name: 'worker',
    workspace,
    profile: 'work',
    requestId: crypto.randomUUID(),
  };
  const call = (profile: string) =>
    createControlSession(m, { ...input, profile }, new AbortController().signal, create);
  const receipt = await call('work');
  expect(receipt.profile).toBe('work');
  expect(JSON.stringify(receipt)).not.toContain(registryDir);
  process.env.XDG_CONFIG_HOME = other;
  expect(() => verifyClaudeProfile(m, pinned)).not.toThrow();
  const alias = join(workspace, 'renamed-dir');
  symlinkSync(dir, alias, 'dir');
  writeFileSync(
    registry,
    JSON.stringify({ version: 1, profiles: [{ name: 'renamed', code: { configDir: alias } }] }),
  );
  expect(() => verifyClaudeProfile(m, pinned)).not.toThrow();
  declare(other);
  expect(() => verifyClaudeProfile(m, pinned)).toThrow('different directory');
  unlinkSync(registry);
  expect(() => verifyClaudeProfile(m, pinned)).toThrow('no longer registered');
  expect((await call('work')).target).toEqual(receipt.target);
  await expect(call('default')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(called).toBe(1);
});
