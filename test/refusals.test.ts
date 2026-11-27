import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { refusals } from '../src/control-client.ts';

const root = join(import.meta.dir, '..', 'src');

test('a refusal carries its code, status, retryable and default text from one table', () => {
  const error = refusals.errors.SESSION_SLEEPING();
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: 'SESSION_SLEEPING', status: 409 });
  expect(error.message).toBe(refusals.definitions.SESSION_SLEEPING.message);
  expect(refusals.errors.NOT_IDLE({ message: 'agent-a is working' }).message).toBe(
    'agent-a is working',
  );
  expect(refusals.errors.UNAVAILABLE().retryable).toBe(true);
  expect(refusals.errors.IDENTITY_MISMATCH().retryable).toBe(false);
  expect(refusals.isCode('PINNED_SESSION')).toBe(true);
  expect(refusals.isCode('NOT_A_CODE')).toBe(false);
});

test('every code has one status and a sentence a consumer can show', () => {
  for (const [code, definition] of Object.entries(refusals.definitions)) {
    expect([code, typeof definition.message === 'string' && definition.message.length > 0]).toEqual(
      [code, true],
    );
    expect([code, definition.status >= 400 && definition.status < 600]).toEqual([code, true]);
    expect([code, typeof definition.retryable]).toEqual([code, 'boolean']);
  }
});

test('the source raises refusals through the table, not a code typed at the throw', async () => {
  // A code written as a string literal at a throw site is a code the table does not know about.
  const found: string[] = [];
  const glob = new Bun.Glob('**/*.ts');
  for await (const file of glob.scan({ cwd: root })) {
    const text = await Bun.file(join(root, file)).text();
    for (const match of text.matchAll(/new AppError\(\s*'([A-Z_]+)'/g))
      found.push(`${file}: ${match[1]}`);
  }
  expect(found).toEqual([]);
});
