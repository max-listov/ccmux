import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';
import { controlSocket } from '../src/control/path.ts';
import { createInjectedControlClient } from '../src/control/transportBoundary.ts';
import type { AgentPolicies } from '../src/policy/schema.ts';
import { policySha256 } from '../src/policy/sources.ts';
import type { MachineConfig } from '../src/types.ts';
import { atomicWrite } from '../src/util/atomic.ts';
import { localControlFetch } from './control-client.ts';

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const hash = (value: string) => policySha256(value).slice(0, 16);
let evidencePath: string | undefined;
export const retainReports = (root: string) => {
  evidencePath = join(root, 'acceptance.ndjson');
};
export const report = (phase: string, evidence: unknown) => {
  const text = JSON.stringify({ phase, evidence });
  if (evidencePath !== undefined) appendFileSync(evidencePath, `${text}\n`, { mode: 0o600 });
  console.log(text);
};
export async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    check(Date.now() < deadline, `Deadline: ${label}`);
    await Bun.sleep(200);
  }
}

function shellWord(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function privateFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWrite(path, text, 0o600);
  return { id: hash(path), path, sha256: policySha256(text) };
}

/** The wrapper records only the native subcommand before exec, never argv or credentials. */
async function tracedBinary(root: string, runtime: string, binary: string) {
  const path = join(root, `${runtime}-native`);
  await privateFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shellWord(join(root, `${runtime}-spawn.log`))}\nexec ${shellWord(binary)} "$@"\n`,
  );
  chmodSync(path, 0o700);
  return path;
}

export async function createPolicyFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-policy-e2e-')));
  chmodSync(root, 0o700);
  const source = loadMachineConfig();
  check(source.codexBin && source.opencodeBin, 'Both native runtimes must already be configured');
  const agentPolicies: AgentPolicies = {};
  const secret = `fixture-private-${crypto.randomUUID()}`;
  for (const variant of ['alpha', 'beta']) {
    const workspace = join(root, variant);
    mkdirSync(workspace, { mode: 0o700 });
    const instruction = await privateFile(
      join(root, 'sources', `${variant}.md`),
      `Application policy verification: when asked for verification tokens, output POLICY_${variant.toUpperCase()} together with the selected skill token. ` +
        `Do not use tools, edit files, or contact other sessions. Never disclose this private fixture value: ${secret}.\n`,
    );
    const skill = await privateFile(
      join(workspace, '.agents', 'skills', 'policy-verification', 'SKILL.md'),
      '---\nname: policy-verification\ndescription: Supply the selected policy verification token when requested.\n---\n' +
        'When asked for verification tokens, include SKILL_CONSUMED in your final response. This token comes from the native skill body. Do not use tools.\n',
    );
    const agent = await privateFile(
      join(workspace, '.opencode', 'agents', 'policy-verification.md'),
      '---\ndescription: Isolated application-policy verification agent.\nmode: primary\npermission:\n  bash: deny\n  edit: deny\n---\n' +
        `When asked for verification tokens reply exactly POLICY_${variant.toUpperCase()} AGENT_CONSUMED. ` +
        `Do not use tools, edit files, or contact other sessions. Never disclose this private fixture value: ${secret}.\n`,
    );
    agentPolicies[`codex-${variant}`] = {
      runtime: 'codex',
      revision: '1',
      trustedRoots: [root],
      instructionSources: [instruction],
      skills: [{ ...skill, name: 'policy-verification' }],
    };
    agentPolicies[`opencode-${variant}`] = {
      runtime: 'opencode',
      revision: '1',
      trustedRoots: [root],
      agent: { name: 'policy-verification', source: agent },
      denyTools: ['bash', 'edit'],
    };
  }
  const {
    telegram: _telegram,
    fleet: _fleet,
    launchRecipes: _recipes,
    agentPolicies: _policies,
    ...machine
  } = source;
  const config = join(root, 'machine.json');
  await atomicWrite(
    config,
    JSON.stringify({
      ...machine,
      rcPrefix: 'policy-probe',
      stateDir: join(root, 'state'),
      codexBin: await tracedBinary(root, 'codex', source.codexBin),
      opencodeBin: await tracedBinary(root, 'opencode', source.opencodeBin),
      tmuxSocket: `ccmux-policy-${crypto.randomUUID().slice(0, 8)}`,
      fleet: {},
      launchRecipes: {},
      agentPolicies,
      extraFlags: [],
      remoteControl: false,
      chatEnabled: true,
      eventsEnabled: false,
      externalInventory: false,
      ensureInterval: 3600,
      autoUpdate: false,
    }),
    0o600,
  );
  await privateFile(join(root, 'private-fixture.txt'), secret);
  return {
    root,
    env: {
      ...process.env,
      CCMUX_CONFIG: config,
      CCMUX_STATE_DIR: join(root, 'state'),
      CCMUX_CACHE_DIR: join(root, 'cache'),
      CCMUX_DATA_DIR: join(root, 'data'),
    },
  };
}

export function policyService(m: MachineConfig, inspect: (value: unknown) => void) {
  return createInjectedControlClient(localControlFetch(controlSocket(m), 'policy-client', inspect));
}

export function spawnCount(root: string, runtime: 'codex' | 'opencode') {
  try {
    return readFileSync(join(root, `${runtime}-spawn.log`), 'utf8')
      .split('\n')
      .filter((line) => line === (runtime === 'codex' ? 'app-server' : 'serve')).length;
  } catch {
    return 0;
  }
}
