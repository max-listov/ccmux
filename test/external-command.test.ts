import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../scripts/bundle.ts';
import { externalInventoryJson, externalTableLines } from '../src/commands/external.ts';
import { ExternalInventoryJsonSchema, ExternalSessionSchema } from '../src/config/schema.ts';

const THREAD = '11111111-1111-4111-8111-111111111111';
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const session = ExternalSessionSchema.parse({
  key: `external:codex:host-a#${THREAD}`,
  plane: 'external',
  provider: 'codex',
  host: 'host-a',
  threadId: THREAD,
  dir: '/Users/u/project',
  path: '/Users/u/.codex/sessions/rollout.jsonl',
  origin: 'desktop',
  storage: 'stored',
  writerEvidence: 'none-observed',
  writerRuntime: null,
  turnState: unknownTurnState('codex-app-server'),
  capabilities: {
    inspect: true,
    attemptAdopt: true,
    fork: true,
    terminateAndAdopt: false,
    releaseAtSource: false,
    reasons: ['no writer was observed; that is not proof the thread is free'],
  },
  lastActivityMs: 1,
  lastModel: 'model-a',
  usedTokens: 2,
  lastMessage: null,
});

describe('external inventory command', () => {
  test('JSON preserves the strict external plane and every independent evidence axis', () => {
    const output = externalInventoryJson('host-a', [session], new Date('2026-08-27T00:00:00.000Z'));
    expect(ExternalInventoryJsonSchema.parse(output)).toEqual(output);
    expect(output.sessions[0]).toMatchObject({
      plane: 'external',
      provider: 'codex',
      origin: 'desktop',
      storage: 'stored',
      writerEvidence: 'none-observed',
      writerRuntime: null,
    });
  });

  test('human output carries provider and full UUID for adopt without calling the row running', () => {
    const text = externalTableLines([session]).join('\n');
    expect(text).toContain('codex');
    expect(text).toContain(THREAD);
    expect(text).toContain('none-observed/-');
    expect(text).not.toContain('running');
  });

  test('the real CLI flushes JSON larger than a pipe buffer before exiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-external-cli-'));
    const sessionsDir = join(root, 'codex', 'sessions');
    const stateDir = join(root, 'state');
    const fakeBin = join(root, 'bin');
    const config = join(root, 'machine.json');
    const bundle = join(root, 'ccmux.js');
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeBin, 0o700);

    const rowCount = 2_000;
    for (let index = 1; index <= rowCount; index += 1) {
      const threadId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const record = {
        type: 'session_meta',
        payload: {
          id: threadId,
          cwd: '/Users/u/project',
          originator: 'Codex Desktop',
          source: 'vscode',
        },
      };
      writeFileSync(join(sessionsDir, `rollout-${index}.jsonl`), `${JSON.stringify(record)}\n`);
    }
    writeFileSync(
      config,
      JSON.stringify({
        claudeBin: fakeBin,
        codexBin: fakeBin,
        tmuxBin: fakeBin,
        projectsDir: join(root, 'claude'),
        codexHome: join(root, 'codex'),
        codexSessionsDir: sessionsDir,
        rcPrefix: 'host-a',
        stateDir,
        bootLabel: 'ccmux.service',
      }),
    );

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    env.CCMUX_CONFIG = config;

    try {
      expect(await buildBundle(bundle)).toBe(true);
      // The shipped bundle plus an intermediate pipe is the production failure shape: running the
      // source file or redirecting straight to disk can both hide a buffered-write truncation.
      const proc = Bun.spawn(
        ['sh', '-c', 'bun "$1" external --json | { sleep 0.1; cat; }', 'sh', bundle],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.length).toBeGreaterThan(1024 * 1024);
      expect(ExternalInventoryJsonSchema.parse(JSON.parse(stdout)).sessions).toHaveLength(rowCount);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normal event-loop completion preserves a command's non-zero exit code", async () => {
    const proc = Bun.spawn(['bun', CLI, 'external', '--bogus'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(1);
  });
});

import { unknownTurnState } from '../src/external/turnSchema.ts';
