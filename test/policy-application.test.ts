import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePolicyDeveloperInstructions, policySkillInputs } from '../src/policy/codex.ts';
import { selectOpenCodePolicyAgent } from '../src/policy/opencode.ts';
import {
  applicationPolicyEvidence,
  resolveApplicationPolicy,
  verifyApplicationPolicy,
} from '../src/policy/resolve.ts';
import {
  AgentPoliciesSchema,
  ApplicationPolicyReferenceSchema,
  MaterializedPolicySchema,
} from '../src/policy/schema.ts';
import { MAX_POLICY_SOURCE_BYTES, policySha256 } from '../src/policy/sources.ts';
import { log } from '../src/util/log.ts';

const roots: string[] = [];
const logged = spyOn(log, 'error').mockImplementation(() => {});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  logged.mockClear();
});
afterAll(() => logged.mockRestore());

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-policy-')));
  roots.push(root);
  const source = (id: string, body: string, filename = `${id}.md`) => {
    const path = join(root, filename);
    writeFileSync(path, body, { mode: 0o600 });
    return { id, path, sha256: policySha256(body) };
  };
  const instructions = source('instructions-a', 'Use the canonical application vocabulary.');
  const skill = {
    ...source(
      'skill-a',
      '---\nname: skill-a\ndescription: A canonical fixture\n---\nUse the skill vocabulary.',
      'SKILL.md',
    ),
    name: 'skill-a',
  };
  const agentSource = source(
    'agent-a',
    '---\ndescription: A canonical agent\nmode: primary\n---\nUse the canonical agent vocabulary.\n',
  );
  const host = {
    agentPolicies: AgentPoliciesSchema.parse({
      'profile-a': {
        runtime: 'codex',
        revision: 'r1',
        trustedRoots: [root],
        instructionSources: [instructions],
        skills: [skill],
      },
      'profile-b': {
        runtime: 'codex',
        revision: 'r1',
        trustedRoots: [root],
        instructionSources: [source('instructions-b', 'Use a different application vocabulary.')],
      },
      'agent-a': {
        runtime: 'opencode',
        revision: 'r1',
        trustedRoots: [root],
        agent: { name: 'agent-a', source: agentSource },
        denyTools: ['bash'],
      },
    }),
  };
  return { root, source, instructions, skill, agentSource, host };
}
const ref = { id: 'profile-a', revision: 'r1' };
const agentRef = { id: 'agent-a', revision: 'r1' };
const unavailable = 'Application policy is unavailable';

test('public policy reference refuses paths, bodies, environment, permission grants and extra policy fields', () => {
  expect(ApplicationPolicyReferenceSchema.parse(ref)).toEqual(ref);
  for (const fields of [
    { path: '/private/source' },
    { instructions: 'private body' },
    { skills: ['skill-a'] },
    { envFile: '/private/environment' },
    { tools: { bash: true } },
    { mcpServers: {} },
    { runtime: 'codex' },
    { digest: 'a'.repeat(64) },
  ])
    expect(ApplicationPolicyReferenceSchema.safeParse({ ...ref, ...fields }).success).toBe(false);
  for (const id of ['../source', '/source', '', 'a b'])
    expect(ApplicationPolicyReferenceSchema.safeParse({ id, revision: 'r1' }).success).toBe(false);
});

test('two profiles under one host remain distinct and repeated resolution preserves immutable metadata', () => {
  const { host } = fixture();
  const first = resolveApplicationPolicy(host, 'codex', ref);
  const second = resolveApplicationPolicy(host, 'codex', { id: 'profile-b', revision: 'r1' });
  expect(first.metadata.digest).not.toBe(second.metadata.digest);
  expect(first.metadata.capabilities).toEqual(['developer-instructions', 'native-skills']);
  expect(composePolicyDeveloperInstructions(first, 'Supervisor instructions')).toContain(
    'canonical application vocabulary',
  );
  expect(composePolicyDeveloperInstructions(second, 'Supervisor instructions')).not.toContain(
    'canonical application vocabulary',
  );
  expect(verifyApplicationPolicy(host, 'codex', first.metadata)).toEqual(first);
  expect(resolveApplicationPolicy(host, 'codex', ref)).toEqual(first);
});

test('unknown, removed, wrong revision and wrong runtime refuse before an admission callback', () => {
  const { host } = fixture();
  const accepted = resolveApplicationPolicy(host, 'codex', ref).metadata;
  let admitted = false;
  const admit = () => {
    resolveApplicationPolicy(host, 'codex', { id: 'missing', revision: 'r1' });
    admitted = true;
  };
  expect(admit).toThrow(unavailable);
  expect(admitted).toBe(false);
  expect(() => resolveApplicationPolicy(host, 'codex', { ...ref, revision: 'r2' })).toThrow(
    unavailable,
  );
  expect(() => resolveApplicationPolicy(host, 'opencode', ref)).toThrow(unavailable);
  delete host.agentPolicies[ref.id];
  expect(() => verifyApplicationPolicy(host, 'codex', accepted)).toThrow(unavailable);
});

test('restart refuses edited bytes or edited definition even when the host pins a new matching digest', () => {
  const { host, instructions } = fixture();
  const accepted = resolveApplicationPolicy(host, 'codex', ref).metadata;
  writeFileSync(instructions.path, 'Edited application instructions.', { mode: 0o600 });
  expect(() => verifyApplicationPolicy(host, 'codex', accepted)).toThrow(unavailable);
  const definition = host.agentPolicies[ref.id];
  if (definition?.runtime !== 'codex') throw new Error('fixture requires Codex policy');
  definition.instructionSources = [
    { ...instructions, sha256: policySha256('Edited application instructions.') },
  ];
  expect(resolveApplicationPolicy(host, 'codex', ref).metadata.digest).not.toBe(accepted.digest);
  expect(() => verifyApplicationPolicy(host, 'codex', accepted)).toThrow(unavailable);
  definition.revision = 'r2';
  expect(() => verifyApplicationPolicy(host, 'codex', accepted)).toThrow(unavailable);
});

test('source paths are canonical, inside an explicit trust root and cannot be symlinks', () => {
  const f = fixture();
  const definition = f.host.agentPolicies[ref.id];
  if (definition?.runtime !== 'codex') throw new Error('fixture requires Codex policy');
  expect(
    AgentPoliciesSchema.safeParse({
      unsafe: {
        ...definition,
        instructionSources: [{ ...f.instructions, path: `${f.root}/../source.md` }],
      },
    }).success,
  ).toBe(false);
  definition.trustedRoots = [join(f.root, 'unrelated')];
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  definition.trustedRoots = [f.root];
  const link = join(f.root, 'linked.md');
  symlinkSync(f.instructions.path, link);
  definition.instructionSources = [{ ...f.instructions, path: link }];
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  const nested = join(f.root, 'linked-directory');
  symlinkSync(f.root, nested);
  definition.instructionSources = [{ ...f.instructions, path: join(nested, 'instructions-a.md') }];
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
});

test('writable sources and parent directories are not trusted', () => {
  const f = fixture();
  chmodSync(f.instructions.path, 0o666);
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  chmodSync(f.instructions.path, 0o600);
  chmodSync(f.root, 0o777);
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  chmodSync(f.root, 0o700);
  expect(resolveApplicationPolicy(f.host, 'codex', ref).metadata.id).toBe(ref.id);
});

test('bounded source reading rejects absent, directory, oversized, NUL and invalid UTF-8 sources', () => {
  const f = fixture();
  const definition = f.host.agentPolicies[ref.id];
  if (definition?.runtime !== 'codex') throw new Error('fixture requires Codex policy');
  const dir = join(f.root, 'directory-source');
  mkdirSync(dir, { mode: 0o700 });
  for (const source of [
    { ...f.instructions, path: join(f.root, 'absent.md') },
    { ...f.instructions, path: dir },
    f.source('large', 'x'.repeat(MAX_POLICY_SOURCE_BYTES + 1)),
    f.source('nul', 'a\0b'),
  ]) {
    definition.instructionSources = [source];
    expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  }
  const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
  const path = join(f.root, 'invalid-utf8.md');
  writeFileSync(path, bytes, { mode: 0o600 });
  definition.instructionSources = [{ id: 'invalid', path, sha256: policySha256(bytes) }];
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
});

test('composition has aggregate limits and no duplicate source IDs or ambiguous skill names', () => {
  const f = fixture();
  const definition = f.host.agentPolicies[ref.id];
  if (definition?.runtime !== 'codex') throw new Error('fixture requires Codex policy');
  definition.instructionSources.push(f.instructions);
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  definition.instructionSources = [f.instructions];
  definition.skills.push({ ...f.skill, id: 'skill-b' });
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
  definition.skills = [];
  definition.instructionSources = Array.from({ length: 5 }, (_, index) =>
    f.source(`large-${index}`, 'x'.repeat(MAX_POLICY_SOURCE_BYTES)),
  );
  expect(() => resolveApplicationPolicy(f.host, 'codex', ref)).toThrow(unavailable);
});

test('desired/applied/unavailable projection excludes private materialization and error output stays generic', () => {
  const f = fixture();
  const secret = 'fixture-private-instruction-do-not-project';
  const definition = f.host.agentPolicies[ref.id];
  if (definition?.runtime !== 'codex') throw new Error('fixture requires Codex policy');
  definition.instructionSources = [f.source('secret-source', secret)];
  const resolved = resolveApplicationPolicy(f.host, 'codex', ref);
  const projected = JSON.stringify([
    applicationPolicyEvidence(resolved, 'desired'),
    applicationPolicyEvidence(resolved, 'applied'),
    applicationPolicyEvidence(resolved, 'unavailable'),
  ]);
  expect(projected).not.toContain(secret);
  expect(projected).not.toContain(f.root);
  expect(projected).not.toContain('trustedRoots');
  writeFileSync(join(f.root, 'secret-source.md'), 'changed');
  try {
    verifyApplicationPolicy(f.host, 'codex', resolved.metadata);
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).toBe(unavailable);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(f.root);
  }
  expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(logged.mock.calls)).not.toContain(f.root);
});

test('Codex preserves supervisor instructions and selects only exact enabled workspace-native skills', () => {
  const f = fixture();
  const policy = resolveApplicationPolicy(f.host, 'codex', ref);
  expect(composePolicyDeveloperInstructions(policy, 'SUPERVISOR')).toBe(
    'SUPERVISOR\n\nUse the canonical application vocabulary.',
  );
  const skill = { name: f.skill.name, path: f.skill.path, enabled: true };
  const inventory = { data: [{ cwd: f.root, errors: [], skills: [skill] }] };
  expect(policySkillInputs(policy, f.root, inventory)).toEqual([
    { type: 'skill', name: f.skill.name, path: f.skill.path },
  ]);
  for (const bad of [
    null,
    { data: [] },
    { data: [{ ...inventory.data[0], cwd: '/other' }] },
    { data: [{ cwd: f.root, errors: [{ message: 'private native reason' }], skills: [skill] }] },
    { data: [{ cwd: f.root, errors: [], skills: [{ ...skill, enabled: false }] }] },
    { data: [{ cwd: f.root, errors: [], skills: [{ ...skill, path: '/other/SKILL.md' }] }] },
    { data: [{ cwd: f.root, errors: [], skills: [skill, skill] }] },
  ])
    expect(() => policySkillInputs(policy, f.root, bad)).toThrow(unavailable);
  const noSkills = resolveApplicationPolicy(f.host, 'codex', { id: 'profile-b', revision: 'r1' });
  expect(policySkillInputs(noSkills, f.root, null)).toEqual([]);
});

test('OpenCode selects a canonical native agent without exposing or replacing its body/configuration', () => {
  const f = fixture();
  const policy = resolveApplicationPolicy(f.host, 'opencode', agentRef);
  const agent = {
    name: 'agent-a',
    mode: 'primary',
    prompt: 'Use the canonical agent vocabulary.\n',
    permission: [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'deny' },
    ],
    options: { sensitive: 'fixture-private-value' },
  };
  const original = JSON.stringify(agent);
  expect(selectOpenCodePolicyAgent(policy, [agent])).toBe('agent-a');
  // Native 1.18.20 serializes unset hidden as null for canonical Markdown agents.
  expect(selectOpenCodePolicyAgent(policy, [{ ...agent, hidden: null }])).toBe('agent-a');
  expect(JSON.stringify(agent)).toBe(original);
  expect(verifyApplicationPolicy(f.host, 'opencode', policy.metadata)).toEqual(policy);
  expect(JSON.stringify(applicationPolicyEvidence(policy, 'applied'))).not.toContain(
    'fixture-private-value',
  );
  for (const candidate of [
    { ...agent, prompt: 'different' },
    { ...agent, hidden: true },
    { ...agent, mode: 'subagent' },
    { ...agent, name: 'different' },
  ])
    expect(() => selectOpenCodePolicyAgent(policy, [candidate])).toThrow(unavailable);
  expect(() => selectOpenCodePolicyAgent(policy, [agent, agent])).toThrow(unavailable);
  expect(() => selectOpenCodePolicyAgent(policy, {})).toThrow(unavailable);
  expect(() => composePolicyDeveloperInstructions(policy, 'supervisor')).toThrow(unavailable);
});

test('OpenCode denies all-resource grant exceptions and never appends allow to a host ceiling', () => {
  const f = fixture();
  const policy = resolveApplicationPolicy(f.host, 'opencode', agentRef);
  const agent = {
    name: 'agent-a',
    mode: 'primary',
    prompt: 'Use the canonical agent vocabulary.',
    permission: [],
  };
  const deny = { permission: 'bash', pattern: '*', action: 'deny' };
  for (const permission of [
    [],
    [{ ...deny, pattern: 'dangerous *' }],
    [deny, { permission: '*', pattern: 'safe *', action: 'allow' }],
    [deny, { permission: 'b*', pattern: 'safe *', action: 'ask' }],
  ])
    expect(() => selectOpenCodePolicyAgent(policy, [{ ...agent, permission }])).toThrow(
      unavailable,
    );
  expect(
    selectOpenCodePolicyAgent(policy, [
      {
        ...agent,
        permission: [
          { permission: 'bash', pattern: 'safe *', action: 'allow' },
          deny,
          { permission: 'bash', pattern: 'dangerous *', action: 'deny' },
        ],
      },
    ]),
  ).toBe('agent-a');
  const definition = f.host.agentPolicies[agentRef.id];
  expect(
    AgentPoliciesSchema.safeParse({ unsafe: { ...definition, allowTools: ['bash'] } }).success,
  ).toBe(false);
  expect(
    AgentPoliciesSchema.safeParse({ unsafe: { ...definition, mcp: { allow: true } } }).success,
  ).toBe(false);
  const codex = f.host.agentPolicies[ref.id];
  expect(AgentPoliciesSchema.safeParse({ unsafe: { ...codex, denyTools: ['bash'] } }).success).toBe(
    false,
  );
});

test('strict materialization refuses accidental public serialization as evidence metadata', () => {
  const f = fixture();
  const policy = resolveApplicationPolicy(f.host, 'codex', ref);
  expect(MaterializedPolicySchema.safeParse({ ...policy, environment: {} }).success).toBe(false);
  expect(() =>
    verifyApplicationPolicy(f.host, 'codex', { ...policy.metadata, digest: '0'.repeat(64) }),
  ).toThrow(unavailable);
});

test('native agent source comparison normalizes CRLF and refuses broken frontmatter or an empty prompt', () => {
  const f = fixture();
  const definition = f.host.agentPolicies[agentRef.id];
  if (definition?.runtime !== 'opencode') throw new Error('fixture requires OpenCode policy');
  definition.agent.source = f.source(
    'crlf',
    '---\r\nmode: primary\r\n---\r\nCanonical prompt.\r\n',
  );
  const policy = resolveApplicationPolicy(f.host, 'opencode', agentRef);
  expect(
    selectOpenCodePolicyAgent(policy, [
      {
        name: 'agent-a',
        mode: 'all',
        prompt: 'Canonical prompt.\n',
        permission: [{ permission: 'b?sh', pattern: '*', action: 'deny' }],
      },
    ]),
  ).toBe('agent-a');
  for (const body of [
    '---\nmode: primary\nmissing delimiter',
    '---\nmode: primary\n---\n\n',
    '  \n',
  ]) {
    definition.agent.source = f.source('broken', body);
    expect(() => resolveApplicationPolicy(f.host, 'opencode', agentRef)).toThrow(unavailable);
  }
});
