import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchEnv } from '../src/agent/claude/launch.ts';
import { claudeProfile, knownProjectsDirs } from '../src/agent/claude/profileRoot.ts';
import { findHistoryElsewhere, historyFile } from '../src/agent/claude/resume.ts';
import { providerFor } from '../src/agent/index.ts';
import { endedConversation } from '../src/commands/hookStatus.ts';
import { countRender } from '../src/commands/statusLine.ts';
import { profileViews, viewsBySession } from '../src/quota/view.ts';
import { conversationVerdict, missingConversation } from '../src/session/conversationGuard.ts';
import {
  clearConversationSeen,
  conversationSeen,
  markConversationSeen,
} from '../src/session/conversationSeen.ts';
import { readMetricsFile, writeMetricsFile } from '../src/session/metricsFile.ts';
import { appendSession, loadSessions, removeSession } from '../src/session/registry.ts';
import { makeMachine, makeSession, UUID } from './helpers.ts';

// A session's profile is a CLAUDE_CONFIG_DIR. The agent writes the conversation under
// `<profile>/projects`, and the machine's `projectsDir` is only the default profile's. Reading the
// default for a session that declared another profile looked for its conversation in the wrong
// place for as long as the session lived, which is how a restart of such a session ended blocked.

const roots: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-profile-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function declare(profileDir: string): string {
  const file = join(tmp(), 'profile.env');
  writeFileSync(file, `CLAUDE_CONFIG_DIR=${profileDir}\nANTHROPIC_API_KEY=\n`);
  return file;
}

test('a declared profile moves the session to its own root; an undeclared one keeps the machine root', () => {
  const m = makeMachine({ projectsDir: '/default/projects' });
  const own = tmp();
  const profile = claudeProfile({ dir: '/w', envFile: declare(own) }, m);
  expect(profile.projectsDir).toBe(join(own, 'projects'));
  expect(profile.globalConfigFile).toBe(join(own, '.claude.json'));
  expect(profile.userDir).toBe(own);
  const plain = claudeProfile({ dir: '/w' }, m);
  expect(plain.configDir).toBeNull();
  expect(plain.projectsDir).toBe('/default/projects');
  // The default profile's login file sits BESIDE the config directory, not inside it.
  expect(plain.globalConfigFile.endsWith('/.claude.json')).toBe(true);
  expect(plain.globalConfigFile.endsWith('/.claude/.claude.json')).toBe(false);
});

test('the process environment of whoever asks is not the session profile', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/someone/elses/profile';
  try {
    const m = makeMachine({ projectsDir: '/default/projects' });
    expect(claudeProfile({ dir: '/w' }, m).projectsDir).toBe('/default/projects');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('the history file is looked for under the session profile', () => {
  const own = tmp();
  const m = makeMachine({ projectsDir: join(tmp(), 'projects') });
  const s = makeSession({ dir: '/w/app', uuid: UUID, envFile: declare(own) });
  expect(historyFile(s, m)).toBe(join(own, 'projects', '-w-app', `${UUID}.jsonl`));
});

test('a conversation left in another profile is found, so a changed profile blocks instead of forking', async () => {
  const oldProfile = tmp();
  const newProfile = tmp();
  const m = makeMachine({ projectsDir: join(tmp(), 'projects'), stateDir: tmp() });
  const moved = makeSession({
    name: 'agent-A',
    dir: '/w/app',
    uuid: UUID,
    envFile: declare(newProfile),
  });
  const kept = join(oldProfile, 'projects', '-w-app');
  mkdirSync(kept, { recursive: true });
  const old = join(kept, `${UUID}.jsonl`);
  writeFileSync(old, 'x'.repeat(100));
  // Negative control: no registered session declares the old profile, so its root is not searched.
  await appendSession(m, moved);
  try {
    expect(findHistoryElsewhere(moved, m).found).toBeNull();
    // Another session on the machine declares it → its root is a place a conversation can be.
    await appendSession(
      m,
      makeSession({
        name: 'agent-B',
        dir: '/w/other',
        uuid: '33333333-3333-4333-8333-333333333333',
        envFile: declare(oldProfile),
      }),
    );
    expect(knownProjectsDirs(loadSessions(m), m)).toContain(join(oldProfile, 'projects'));
    expect(findHistoryElsewhere(moved, m).found).toBe(old);
  } finally {
    await removeSession(m, 'agent-A');
    await removeSession(m, 'agent-B');
  }
});

test('a conversation that was seen is protected; one that never existed starts fresh', () => {
  // The defect: a session closed on its folder-trust question carried a launch stamp for a
  // conversation that was never created, and was blocked for a missing file.
  expect(
    conversationVerdict({ present: false, found: null, seen: false, searchComplete: true }),
  ).toBe('start');
  expect(
    conversationVerdict({ present: false, found: null, seen: true, searchComplete: true }),
  ).toBe('block');
  expect(
    conversationVerdict({
      present: false,
      found: '/elsewhere/x.jsonl',
      seen: false,
      searchComplete: true,
    }),
  ).toBe('block');
  expect(
    conversationVerdict({ present: true, found: null, seen: false, searchComplete: true }),
  ).toBe('start');
  expect(
    conversationVerdict({ present: false, found: null, seen: false, searchComplete: false }),
  ).toBe('block');
});

test('the evidence is keyed by the conversation uuid, so a renewed session inherits none', () => {
  const name = `seen-${crypto.randomUUID()}`;
  expect(conversationSeen(name, UUID)).toBe(false);
  markConversationSeen(name, UUID);
  expect(conversationSeen(name, UUID)).toBe(true);
  // renew: same name, new uuid — the old conversation's evidence must not block the new one.
  expect(conversationSeen(name, '22222222-2222-4222-8222-222222222222')).toBe(false);
  clearConversationSeen(name);
  expect(conversationSeen(name, UUID)).toBe(false);
});

test('a turn ending names its conversation; other events and malformed input name none', () => {
  expect(endedConversation(JSON.stringify({ hook_event_name: 'Stop', session_id: UUID }))).toBe(
    UUID,
  );
  expect(
    endedConversation(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: UUID })),
  ).toBeNull();
  expect(endedConversation(JSON.stringify({ hook_event_name: 'Stop' }))).toBeNull();
  expect(endedConversation('not json')).toBeNull();
});

// The guard against starting a new conversation over a missing one, on a real filesystem.

function sessionWith(name: string, uuid: string, envFile?: string) {
  return makeSession({ name, dir: '/w/app', uuid, ...(envFile === undefined ? {} : { envFile }) });
}

test('a conversation that was seen and is gone blocks the launch, naming where it looked', () => {
  const profile = tmp();
  const m = makeMachine({ projectsDir: join(tmp(), 'projects'), stateDir: tmp() });
  const name = `guard-${crypto.randomUUID()}`;
  const s = sessionWith(name, UUID, declare(profile));
  const expected = historyFile(s, m);
  const provider = providerFor(s);
  // Never seen, never written: the session was closed on a question before it said anything.
  expect(missingConversation(m, s, provider, false, expected)).toBeNull();
  // Seen once (its file was there at a launch), then gone.
  expect(missingConversation(m, s, provider, true, expected)).toBeNull();
  const refusal = missingConversation(m, s, provider, false, expected);
  expect(refusal).toContain('Refusing to start a NEW conversation');
  expect(refusal).toContain(expected);
  expect(refusal).toContain(
    `Searched projects roots: ${m.projectsDir}, ${join(profile, 'projects')}`,
  );
  expect(refusal).toContain(`ccmux renew ${name}`);
  clearConversationSeen(name);
  // A renewed session (new uuid, same name) is not held by the conversation it replaced.
  markConversationSeen(name, UUID);
  const renewed = sessionWith(name, '44444444-4444-4444-8444-444444444444', declare(profile));
  expect(missingConversation(m, renewed, provider, false, historyFile(renewed, m))).toBeNull();
  clearConversationSeen(name);
});

test('the status line writes windows that the reader returns, and a render without them keeps them', () => {
  // The round trip through the file the status line and the rows share.
  const name = `metrics-${crypto.randomUUID()}`;
  const report = {
    at: 1_000,
    fiveHour: { pct: 73, resetsAt: 1792238400 },
    sevenDay: { pct: 39, resetsAt: null },
  };
  const first = {
    ts: 1_000,
    pct: null,
    contextSizeTokens: null,
    model: null,
    costUsd: null,
    renders: 1,
    rendersSince: 1_000,
    rateLimits: report,
  };
  return (async () => {
    await writeMetricsFile(name, first);
    expect(readMetricsFile(name)?.rateLimits).toEqual(report);
    const next = countRender(readMetricsFile(name), { ...first, ts: 2_000, rateLimits: null });
    await writeMetricsFile(name, next);
    expect(readMetricsFile(name)?.rateLimits).toEqual(report);
  })();
});

test('a terminal session is attributed to its profile login, and to none when it brings its own', () => {
  const profile = tmp();
  writeFileSync(
    join(profile, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'agent-a@example.test' } }),
  );
  const m = makeMachine();
  const bedrock = join(tmp(), 'bedrock.env');
  writeFileSync(bedrock, `CLAUDE_CONFIG_DIR=${profile}\nCLAUDE_CODE_USE_BEDROCK=1\n`);
  // A declared API key does not hide the login: the launch drops the key when a login exists.
  const keyed = join(tmp(), 'keyed.env');
  writeFileSync(keyed, `CLAUDE_CONFIG_DIR=${profile}\nANTHROPIC_API_KEY=sk-placeholder\n`);
  const bare = tmp();
  const sessions = [
    sessionWith('agent-A', UUID, declare(profile)),
    sessionWith('agent-B', UUID, bedrock),
    sessionWith('agent-C', UUID, keyed),
    sessionWith('agent-D', UUID, declare(bare)),
  ];
  const by = viewsBySession(profileViews(m, sessions), sessions, m);
  expect(by.get('agent-A')?.account?.label).toBe('agent-a@example.test');
  // The same profile, but the session's own environment brings a cloud provider: not this login.
  expect(by.get('agent-B')).toBeUndefined();
  expect(by.get('agent-C')?.account?.label).toBe('agent-a@example.test');
  // A profile with no login names no account.
  expect(by.get('agent-D')?.account).toBeNull();
});

test('the launch gives the agent the declared profile, never one the launching environment carries', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/someone/elses/profile';
  try {
    const m = makeMachine();
    // No declaration: the inherited value would put the agent's state where no reader looks.
    expect(launchEnv(m, sessionWith('agent-A', UUID)).CLAUDE_CONFIG_DIR).toBeUndefined();
    const own = tmp();
    expect(launchEnv(m, sessionWith('agent-B', UUID, declare(own))).CLAUDE_CONFIG_DIR).toBe(own);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
