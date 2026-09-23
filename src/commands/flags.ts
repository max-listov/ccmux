import { parseArgs } from 'node:util';
import { COMMANDS, type FlagSpec, usageLine } from './help.ts';

/**
 * One way to read a command line, declared next to the help that describes it.
 *
 * Each command used to read its own arguments, three ways over: hand-written loops, `args.includes`,
 * and `parseArgs` in one place. They disagreed on what a caller cannot see: an unknown flag was
 * refused by some commands and silently ignored by others, and a number that was not one was an error
 * in two, the default in two more, and dropped without a word in the rest — `--tail abc` answered as if
 * nobody had asked. Help and parsers drifted too: flags parsed but never documented, the command
 * accepting what its own description did not mention.
 *
 * Now a command's flags are a spec on its `COMMANDS` entry, and this reads them strictly: an unknown
 * flag, a missing value, and a number that is not a whole number in range are each an error that
 * names the flag. A flag is a word starting with `--` or a declared short one; every other word is an
 * argument, and everything after `--` is one.
 */
export class UsageError extends Error {}

export interface ParsedFlags {
  positionals: string[];
  /** The arguments as given, without the positional ones — what a command forwards to a peer
   *  alongside the target it resolved. */
  flagArgs: string[];
  bool(name: string): boolean;
  str(name: string): string | undefined;
  int(name: string): number | undefined;
  list(name: string): string[];
}

function specOf(verb: string): readonly FlagSpec[] {
  const entry = COMMANDS.find((command) => command.verb === verb);
  if (entry === undefined) throw new Error(`no command '${verb}' to read flags for`);
  return entry.flags ?? [];
}

export function parseFlags(
  verb: string,
  args: readonly string[],
  /** How many positional arguments the command takes, inclusive. Default: any number. */
  positionals: [min: number, max: number] = [0, Number.POSITIVE_INFINITY],
): ParsedFlags {
  const spec = specOf(verb);
  const options: Record<
    string,
    { type: 'boolean' | 'string'; short?: string; multiple?: boolean }
  > = {};
  for (const flag of spec)
    options[flag.name] = {
      type: flag.kind === 'boolean' ? 'boolean' : 'string',
      ...(flag.short === undefined ? {} : { short: flag.short }),
      ...(flag.kind === 'list' ? { multiple: true } : {}),
    };
  // Which words are flags is decided here, before `parseArgs` sees them: a word starting with `--`,
  // or a declared short flag. Any other word is an argument even when it starts with a dash — a letter
  // body "- one item", a pattern "-foo" — which `parseArgs` alone would refuse as an unknown option.
  // A value is the next word whatever it looks like, unless it is itself a `--` flag.
  // A one-letter name is a short flag only (`-n N`): its `--n` spelling is nobody's documented form.
  const byShort = new Map<string, FlagSpec>(
    spec.flatMap((flag): [string, FlagSpec][] => {
      const letter = flag.name.length === 1 ? flag.name : flag.short;
      return letter === undefined ? [] : [[`-${letter}`, flag]];
    }),
  );
  const byName = new Map(spec.map((flag) => [flag.name, flag]));
  const flagTokens: string[] = [];
  const positionalWords: string[] = [];
  const positionalAt = new Set<number>();
  for (let index = 0; index < args.length; index++) {
    const word = args[index] as string;
    if (word === '--') {
      for (let rest = index + 1; rest < args.length; rest++) {
        positionalWords.push(args[rest] as string);
        positionalAt.add(rest);
      }
      positionalAt.add(index);
      break;
    }
    const long = word.startsWith('--');
    const short = byShort.get(word);
    if (!long && short === undefined) {
      positionalWords.push(word);
      positionalAt.add(index);
      continue;
    }
    const longName = word.slice(2).split('=')[0] as string;
    if (long && longName.length === 1)
      throw new UsageError(
        `Unknown option '${word}' (did you mean -${longName}?)\n${usageLine(verb)}`,
      );
    const flag = long ? byName.get(longName) : short;
    if (flag === undefined || flag.kind === 'boolean' || word.includes('=')) {
      flagTokens.push(word);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`--${flag.name} needs a value\n${usageLine(verb)}`);
    flagTokens.push(`--${flag.name}=${value}`);
    index++;
  }
  // A flag that is not a list, given twice, has no single meaning: which one the caller meant is not
  // something to decide for them by keeping the last.
  const seen = new Set<string>();
  for (const token of flagTokens) {
    const flag = token.startsWith('--')
      ? byName.get(token.slice(2).split('=')[0] as string)
      : byShort.get(token);
    if (flag === undefined || flag.kind === 'list') continue;
    if (seen.has(flag.name)) throw new UsageError(`--${flag.name} given twice\n${usageLine(verb)}`);
    seen.add(flag.name);
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: flagTokens, options, strict: true, allowPositionals: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new UsageError(`${reason}\n${usageLine(verb)}`);
  }
  parsed.positionals = positionalWords;
  const [min, max] = positionals;
  const count = parsed.positionals.length;
  if (count < min || count > max) {
    const what =
      count < min
        ? `missing ${min === max ? '' : 'a required '}argument`
        : `unexpected argument '${parsed.positionals[max] ?? ''}'`;
    throw new UsageError(`${what}\n${usageLine(verb)}`);
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const ints = new Map<string, number>();
  for (const flag of spec) {
    if (flag.kind !== 'int') continue;
    const raw = values[flag.name];
    if (raw === undefined) continue;
    const text = String(raw);
    const n = Number(text);
    const min = flag.min ?? Number.MIN_SAFE_INTEGER;
    const max = flag.max ?? Number.MAX_SAFE_INTEGER;
    if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max)
      throw new UsageError(
        `--${flag.name} expects a whole number${flag.min !== undefined ? ` from ${min}` : ''}${flag.max !== undefined ? ` to ${max}` : ''}, got '${text}'\n${usageLine(verb)}`,
      );
    ints.set(flag.name, n);
  }
  const declared = (name: string): void => {
    if (!(name in options))
      throw new Error(`'${verb}' reads --${name}, which its spec does not declare`);
  };
  return {
    positionals: parsed.positionals,
    flagArgs: args.filter((_, index) => !positionalAt.has(index)),
    bool: (name) => {
      declared(name);
      return values[name] === true;
    },
    str: (name) => {
      declared(name);
      const value = values[name];
      return typeof value === 'string' ? value : undefined;
    },
    int: (name) => {
      declared(name);
      return ints.get(name);
    },
    list: (name) => {
      declared(name);
      const value = values[name];
      return Array.isArray(value) ? value.flatMap((item) => item.split(',')).filter(Boolean) : [];
    },
  };
}
