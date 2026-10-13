import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { transcriptJson } from '../src/context/transcriptJson.ts';
import { TranscriptJsonSchema } from '../src/context/transcriptJsonSchema.ts';
import {
  ControlTranscriptReadSchema,
  ControlTranscriptResultSchema,
} from '../src/control/schema/native.ts';
import { readControlTranscript } from '../src/control/transcript.ts';
import { appendSession } from '../src/session/registry.ts';
import { makeMachine, makeSession } from './helpers.ts';

const UUID = 'a1b2c3d4-0000-4000-8000-000000000001';
const RESULT = 'b1b2c3d4-0000-4000-8000-000000000001';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-tool-images-'));
  const dir = join(root, 'project');
  const projectsDir = join(root, 'projects');
  const historyDir = join(projectsDir, encodeDir(dir));
  mkdirSync(historyDir, { recursive: true });
  const m = makeMachine({
    stateDir: join(root, 'state'),
    projectsDir,
    rcPrefix: 'host-a',
    claudeBin: '/bin/true',
    tmuxBin: '/bin/true',
  });
  const session = makeSession({ name: 'reader', uuid: UUID, dir });
  const data = Buffer.alloc(512 * 1024, 42).toString('base64');
  writeFileSync(
    join(historyDir, `${UUID}.jsonl`),
    `${[
      JSON.stringify({
        uuid: UUID,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'read-image',
              name: 'Read',
              input: { file_path: '/tmp/image.png' },
            },
          ],
        },
      }),
      JSON.stringify({
        uuid: RESULT,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-image',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
              ],
            },
          ],
        },
      }),
    ].join('\n')}\n`,
  );
  await appendSession(m, session);
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(m));
  return { root, m, session, config, data };
}

test('CLI JSON addresses a tool picture and a slow pipe receives every byte', async () => {
  const f = await fixture();
  const env = {
    ...process.env,
    CCMUX_CONFIG: f.config,
    CCMUX_STATE_DIR: f.m.stateDir,
    CCMUX_CACHE_DIR: join(f.root, 'cache'),
    CCMUX_DATA_DIR: join(f.root, 'data'),
  };
  const run = (flags: string[]) =>
    Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        'transcript',
        'reader',
        ...flags,
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    );
  try {
    const listing = run(['--json']);
    const [json, listError, listCode] = await Promise.all([
      new Response(listing.stdout).text(),
      new Response(listing.stderr).text(),
      listing.exited,
    ]);
    expect(listError).toBe('');
    expect(listCode).toBe(0);
    const view = TranscriptJsonSchema.parse(JSON.parse(json));
    const descriptor = view.messages[0]?.resultImages?.[0];
    expect(descriptor?.address).toBe(`${RESULT}#0/0`);
    if (!descriptor) throw new Error('CLI did not address its tool image');
    expect(json).not.toContain(f.data);
    const picture = run(['--image', descriptor.address]);
    const error = new Response(picture.stderr).text();
    const chunks: Uint8Array[] = [];
    // Delay consumption beyond the pipe capacity, then consume incrementally.
    await Bun.sleep(100);
    for await (const chunk of picture.stdout) {
      chunks.push(chunk);
      await Bun.sleep(1);
    }
    expect(await picture.exited).toBe(0);
    expect(await error).toBe('');
    expect(Buffer.concat(chunks).toString()).toBe(`data:image/png;base64,${f.data}\n`);
    const refused = run(['--image', `${RESULT}#0/0junk`]);
    const [out, stderr, code] = await Promise.all([
      new Response(refused.stdout).text(),
      new Response(refused.stderr).text(),
      refused.exited,
    ]);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(stderr).toContain('image unavailable (malformed)');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('control schema preserves descriptors and real indexed windows preserve result-only images', async () => {
  const f = await fixture();
  try {
    const target = {
      kind: 'managed',
      source: 'ccmux',
      agent: 'claude',
      machine: f.m.rcPrefix,
      session: f.session.name,
      threadId: UUID,
    };
    const answer = await readControlTranscript(f.m, ControlTranscriptReadSchema.parse({ target }));
    const checked = ControlTranscriptResultSchema.parse(answer);
    expect(checked.messages[0]?.resultImages?.[0]?.address).toBe(`${RESULT}#0/0`);
    expect(checked.stats).toMatchObject({ user: 0, assistant: 0, toolCalls: 1, thinking: 0 });
    const images = checked.messages[0]?.resultImages;
    for (const window of [{ tail: 1 }, { tail: 2, cursor: 1 }, { tail: 2, before: 3, limit: 1 }]) {
      const view = await transcriptJson(f.m, f.session, window);
      expect(view.messages[0]?.kind).toBe('tool_result');
      expect(view.messages[0]?.resultImages).toEqual(images);
      expect(view.stats).toEqual(answer.stats);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
