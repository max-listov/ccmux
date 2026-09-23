import { expect, test } from 'bun:test';
import { parseFlags, UsageError } from '../src/commands/flags.ts';

/**
 * The one reader of command lines. What it must never do is the thing the per-command parsers did:
 * accept a line it could not read and answer anyway — an unknown flag ignored, a number that was not
 * one replaced by a default or dropped.
 */
test('flags, values and positionals come apart the same way for every command', () => {
  const flags = parseFlags('transcript', [
    'host-a:agent-a',
    '--grep',
    '-foo',
    '-F',
    '--role',
    'user,assistant',
    '--role',
    'tool',
    '--limit=7',
  ]);
  expect(flags.positionals).toEqual(['host-a:agent-a']);
  expect(flags.str('grep')).toBe('-foo'); // a value is the next word, dash or not
  expect(flags.bool('fixed-strings')).toBe(true);
  expect(flags.list('role')).toEqual(['user', 'assistant', 'tool']);
  expect(flags.int('limit')).toBe(7);
  expect(flags.flagArgs).toEqual([
    '--grep',
    '-foo',
    '-F',
    '--role',
    'user,assistant',
    '--role',
    'tool',
    '--limit=7',
  ]);
});

test('a word starting with a single dash is an argument unless it is a declared short flag', () => {
  const flags = parseFlags('wait', ['agent-a', '-q']);
  expect(flags.bool('quiet')).toBe(true);
  expect(() => parseFlags('wait', ['agent-a', '-x'], [1, 1])).toThrow("unexpected argument '-x'");
  expect(parseFlags('logs', ['--', '--json']).positionals).toEqual(['--json']);
});

test('what cannot be read is refused by name, never answered', () => {
  const refused = (args: string[], verb = 'transcript', arity: [number, number] = [0, 9]) => {
    try {
      parseFlags(verb, args, arity);
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      return (error as Error).message.split('\n')[0];
    }
    return 'accepted';
  };
  expect(refused(['a', '--tial', '5'])).toBe("Unknown option '--tial'");
  expect(refused(['a', '--tail', 'abc'])).toBe("--tail expects a whole number from 1, got 'abc'");
  expect(refused(['a', '--limit', '0'])).toBe("--limit expects a whole number from 1, got '0'");
  expect(refused(['a', '--grep'])).toBe('--grep needs a value');
  expect(refused(['a', '--grep', '--json'])).toBe('--grep needs a value');
  expect(refused(['a', '--json=yes'])).toBe("Option '--json' does not take an argument");
  expect(refused([], 'wait', [1, 1])).toBe('missing argument');
  expect(refused(['a', '--json', '--json'])).toBe('--json given twice');
});

test('a command cannot read a flag its spec does not declare', () => {
  expect(() => parseFlags('wait', ['agent-a']).bool('json')).toThrow('does not declare');
});
