import { afterEach, expect, test } from 'bun:test';
import { launchEnv as claudeEnv, launchEnvKeys as claudeKeys } from '../src/agent/claude/launch.ts';
import { launchEnv as codexEnv, launchEnvKeys as codexKeys } from '../src/agent/codex/launch.ts';
import {
  ADDRESS_ENV,
  clearIdentity,
  grantIdentity,
  IDENTITY_ENV_KEYS,
  pinIdentity,
  SESSION_ENV,
} from '../src/agent/launch/identityEnv.ts';
import { CHAT_CREDENTIAL_ENV, hasChatCredential } from '../src/chat/auth.ts';
import { nativeProvider } from '../src/runtime/provider.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * A process inside a session learns who it is from its environment. The address there has to be the
 * one the rest of ccmux uses for that session, and it has to be this session's — the supervisor's
 * own environment may carry another session's identity, and that must not travel into the next.
 */
const POISON = {
  [SESSION_ENV]: 'someone-else',
  [ADDRESS_ENV]: 'host-z:someone-else',
  [CHAT_CREDENTIAL_ENV]: 'inherited-capability',
};
const saved = Object.fromEntries(IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('every provider launches a session under its name and its fleet address', () => {
  const m = makeMachine({ rcPrefix: 'host-a' });
  Object.assign(process.env, POISON);
  const envs = {
    claude: claudeEnv(m, makeSession({ name: 'agent-a' })),
    codex: codexEnv(m, makeSession({ name: 'agent-a', agent: 'codex' })),
    native: nativeProvider('opencode').launchEnv(
      m,
      makeSession({ name: 'agent-a', agent: 'opencode' }),
    ),
  };
  for (const env of Object.values(envs)) {
    expect([env[SESSION_ENV], env[ADDRESS_ENV]]).toEqual(['agent-a', 'host-a:agent-a']);
    // The recipe describes the session; the capability is granted when the runtime starts.
    expect(env[CHAT_CREDENTIAL_ENV]).toBeUndefined();
  }
  // Named here, not read from the module: a key that left the list would leave this check too.
  for (const keys of [claudeKeys(m), codexKeys(m), nativeProvider('opencode').launchEnvKeys(m)])
    for (const key of ['CCMUX_SESSION', 'CCMUX_ADDRESS', 'CCMUX_CHAT_CREDENTIAL'])
      expect(keys).toContain(key);
});

test('granting an identity rotates the capability, and clearing leaves none', () => {
  const m = makeMachine({ rcPrefix: 'host-a' });
  const session = makeSession({ name: 'agent-a' });
  const env = grantIdentity({ ...POISON, PATH: '/bin' }, m, session);
  expect([env[SESSION_ENV], env[ADDRESS_ENV], env.PATH]).toEqual([
    'agent-a',
    'host-a:agent-a',
    '/bin',
  ]);
  expect(hasChatCredential(m, session, env[CHAT_CREDENTIAL_ENV])).toBe(true);
  expect(hasChatCredential(m, session, POISON[CHAT_CREDENTIAL_ENV])).toBe(false);
  expect(pinIdentity({ ...env }, m, session)[CHAT_CREDENTIAL_ENV]).toBeUndefined();
  expect(clearIdentity<Record<string, string>>({ ...env })).toEqual({ PATH: '/bin' });
});
