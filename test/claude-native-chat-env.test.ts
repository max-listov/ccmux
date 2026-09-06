import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeOwner } from '../src/agent/claude/native/owner.ts';
import { hasChatCredential } from '../src/chat/auth.ts';
import { chatAuthPath } from '../src/config/paths.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('native Claude SDK and its child receive the pinned identity and a fresh chat capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-native-chat-env-'));
  try {
    const sdk = join(root, 'sdk');
    mkdirSync(sdk);
    const m = makeMachine({ stateDir: root, claudeNativeRuntime: true, claudeNativeSdk: sdk });
    const generation = '33333333-3333-4333-8333-333333333333';
    const s = makeSession({
      name: 'agent-a',
      dir: root,
      agent: 'claude',
      runtime: 'native',
      registrationGeneration: generation,
      nativeSession: { runtime: 'claude', id: generation, version: 'fixture' },
    });
    // The stand-in SDK checks the options it actually receives, then checks inheritance in a child.
    // A missing env option must fail even if a credential file happens to exist on disk.
    const child = `
      import { readFileSync } from 'node:fs';
      if (process.env.CCMUX_SESSION !== 'agent-a') process.exit(2);
      if (!process.env.CCMUX_CHAT_CREDENTIAL) process.exit(3);
      if (process.env.CCMUX_CHAT_CREDENTIAL !== readFileSync(${JSON.stringify(chatAuthPath(m, s.name))}, 'utf8').trim()) process.exit(4);
    `;
    writeFileSync(
      join(sdk, 'sdk.mjs'),
      `
      export function query({ options }) {
        if (!options.env) throw new Error('SDK_ENV_MISSING');
        const child = Bun.spawnSync([process.execPath, '-e', ${JSON.stringify(child)}], {env: options.env, stdout: 'pipe', stderr: 'pipe'});
        if (child.exitCode !== 0) throw new Error('CHILD_AUTH_FAILED:' + child.exitCode);
        throw new Error('SDK_ENV_VERIFIED');
      }
    `,
    );
    const open = () => new ClaudeNativeOwner(m, s, async () => {}).open();
    await expect(open()).rejects.toThrow('SDK_ENV_VERIFIED');
    const first = readFileSync(chatAuthPath(m, s.name), 'utf8').trim();
    expect(hasChatCredential(m, s, first)).toBe(true);
    await expect(open()).rejects.toThrow('SDK_ENV_VERIFIED');
    const second = readFileSync(chatAuthPath(m, s.name), 'utf8').trim();
    expect(second).not.toBe(first);
    expect(hasChatCredential(m, s, first)).toBe(false);
    expect(hasChatCredential(m, s, second)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
