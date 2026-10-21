import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';

// The whole path of `ccmux accounts`: profiles found in a home folder, each asked of the vendor's own
// program, the answers merged and printed — run as the real command, against stand-in programs.

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 33% used · resets Oct 17 at 11:59pm (Asia/Bangkok)
Current week (all models): 61% used · resets Oct 20 at 6:59pm (Asia/Bangkok)
`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-accounts-'));
  const home = join(root, 'home');
  mkdirSync(home);
  // Two Claude profiles and one Codex home, none with a session.
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'agent-a@example.test' } }),
  );
  mkdirSync(join(home, '.claude-3'));
  writeFileSync(
    join(home, '.claude-3', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'agent-c@example.test' } }),
  );
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');

  // The Claude stand-in answers as whoever CLAUDE_CONFIG_DIR names, as the real program does.
  const claude = join(root, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh
who=agent-a@example.test
case "$CLAUDE_CONFIG_DIR" in *.claude-3) who=agent-c@example.test ;; esac
case "$1" in
  auth) echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"apiProvider\\":\\"firstParty\\",\\"email\\":\\"$who\\",\\"subscriptionType\\":\\"max\\"}" ;;
  -p) cat <<'USAGE_END'
${USAGE}
USAGE_END
  ;;
esac
`,
  );
  chmodSync(claude, 0o755);
  const codex = join(root, 'codex');
  writeFileSync(
    codex,
    `#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
    const message = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (message.id === undefined) continue;
    const result =
      message.method === 'account/read'
        ? { account: { type: 'chatgpt', planType: 'pro', email: 'agent-g@example.test' } }
        : message.method === 'account/rateLimits/read'
          ? { rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1792649803 }, secondary: null } }
          : {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }
}
`,
  );
  chmodSync(codex, 0o755);
  const tmux = join(root, 'tmux');
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n');
  chmodSync(tmux, 0o755);
  const machine = MachineConfigSchema.parse({
    claudeBin: claude,
    codexBin: codex,
    tmuxBin: tmux,
    projectsDir: join(root, 'claude'),
    codexSessionsDir: join(root, 'codex-sessions'),
    rcPrefix: 'host-a',
    stateDir: join(root, 'state'),
    bootLabel: 'ccmux-test.service',
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));
  return { config, home, state: join(root, 'state') };
}

async function run(w: ReturnType<typeof world>, args: string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = w.config;
  env.CCMUX_STATE_DIR = w.state;
  env.HOME = w.home;
  delete env.CLAUDE_CONFIG_DIR;
  const proc = Bun.spawn(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

test('one request names every account, with its windows, source and plan', async () => {
  const w = world();
  const { stdout, code } = await run(w, ['accounts', '--local', '--refresh', '--json']);
  expect(code).toBe(0);
  const answer = JSON.parse(stdout) as {
    accounts: {
      id: string;
      plan: string | null;
      subscription: string | null;
      sessions: string[];
      profiles: { profile: string; error: string | null }[];
      limits: { source: string; windows: { key: string; percent: number }[] } | null;
    }[];
    problems: unknown[];
  };
  const byId = new Map(answer.accounts.map((a) => [a.id, a]));
  expect([...byId.keys()].sort()).toEqual([
    'chatgpt:agent-g@example.test',
    'firstParty:agent-a@example.test',
    'firstParty:agent-c@example.test',
  ]);
  const claude = byId.get('firstParty:agent-c@example.test');
  expect(claude?.plan).toBe('max');
  expect(claude?.subscription).toBeNull();
  expect(claude?.sessions).toEqual([]);
  expect(claude?.limits?.source).toBe('probe');
  expect(claude?.limits?.windows.map((x) => [x.key, x.percent])).toEqual([
    ['five_hour', 33],
    ['seven_day', 61],
  ]);
  const gpt = byId.get('chatgpt:agent-g@example.test');
  expect(gpt?.plan).toBe('pro');
  expect(gpt?.limits?.windows[0]).toMatchObject({ percent: 100 });
  expect(answer.problems).toEqual([]);
});

test('without a refresh nothing is asked: the profiles are listed and say they were never read', async () => {
  const w = world();
  const { stdout, code } = await run(w, ['accounts', '--local']);
  expect(code).toBe(0);
  // Claude's own login file names the account, so it is shown; its windows are not read yet, and the
  // Codex home names nobody until a probe has asked.
  expect(stdout).toContain('agent-a@example.test');
  expect(stdout).toContain('limits not read');
  expect(stdout).toContain('codex profile default — no probe has read this profile yet');
});
