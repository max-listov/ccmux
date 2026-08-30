import { readFileSync } from 'node:fs';
import { CHAT_CREDENTIAL_ENV } from '../chat/auth.ts';
import type { Session } from '../types.ts';
import { envFilePath, envFiles, fileDigest } from './launchInputs.ts';
import type { LaunchStamp } from './launchStamp.ts';

/**
 * The environment a session gets is a RECIPE, not an inheritance.
 *
 * What it replaces: `_run` is a Bun process whose cwd is the session directory; the runtime loads
 * that directory's `.env` into its own environment, and `launchEnv` copied that environment into the
 * agent wholesale. Nobody designed that — it followed from the supervisor being written in Bun — and
 * it meant a project's secrets reached the agent AND every process the agent spawns (MCP servers,
 * shell tools, subagents), undeclared, invisible to `list`, `doctor` and the launch stamp. Measured
 * on a live fleet before this change: 5 of 14 sessions were carrying project variables that way.
 *
 * Two mechanisms, deliberately belt-and-braces, because they fail in different places:
 *
 *  1. The pane command carries `--no-env-file`, so the runtime never loads the directory's files
 *     into the supervisor at all. Verified against Bun 1.3.14. It is the clean mechanism, and it is
 *     the one that works in production, where ccmux runs as `bun <bundle>`.
 *  2. This module subtracts, by NAME, whatever those files declare — so the guarantee does not
 *     depend on the runtime honouring a flag. Verified necessary: a `bun build --compile` binary
 *     never sees `--no-env-file` (the flag lands in the app's argv, not the runtime's), and no
 *     environment variable or bunfig replaces it there. Without this, a compiled build would quietly
 *     go back to leaking while every test still passed.
 *
 * The subtraction is by name and therefore approximate in exactly one case: a variable that is BOTH
 * in the directory's env file and genuinely in the supervisor's environment is dropped too. That is
 * the safe direction to be wrong in — a missing variable is visible and fixable by declaring it,
 * whereas a leaked secret is neither — and mechanism 1 makes the case unreachable in production.
 */

/**
 * Parse an env file into name → value.
 *
 * ccmux parses it rather than handing the path to the runtime's own `--env-file`, and that is a
 * decision, not laziness: the runtime's loader puts the file's variables into the SUPERVISOR, where
 * a project file could then redefine `CCMUX_STATE_DIR` and repoint the whole instance. Parsing here
 * keeps the file's reach exactly where it was declared to reach — the agent — and keeps the recipe a
 * property of ccmux rather than of whichever runtime happens to host it. That last point is the
 * original complaint about this whole area: an implementation detail had leaked into product
 * behaviour, and swapping the runtime would have silently changed it.
 *
 * Supported, matching what people actually write: `export ` prefixes, `#` comments, single/double/
 * backtick quotes, multi-line quoted values, and `$VAR` / `${VAR}` expansion against the environment
 * being built plus values defined earlier in the same file. Single quotes do not expand, as in every
 * shell. Values are returned only to be handed to a child process — never to a log or a diagnostic.
 */
export function parseEnvFile(
  text: string,
  base: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/s.exec(line);
    if (match === null) continue;
    const key = match[1];
    let rest = match[2] ?? '';
    if (key === undefined) continue;
    const quote = rest.startsWith('"')
      ? '"'
      : rest.startsWith("'")
        ? "'"
        : rest.startsWith('`')
          ? '`'
          : null;
    let value: string;
    if (quote === null) {
      value = rest.split(' #')[0]?.trimEnd() ?? ''; // an unquoted trailing comment is not part of the value
    } else {
      rest = rest.slice(1);
      let closed = rest.indexOf(quote);
      // A quoted value may run over several lines — a PEM key in an env file is the common case.
      while (closed === -1 && i + 1 < lines.length) {
        i += 1;
        rest += `\n${lines[i] ?? ''}`;
        closed = rest.indexOf(quote);
      }
      value = closed === -1 ? rest : rest.slice(0, closed);
    }
    out[key] = quote === "'" ? value : expand(value, { ...base, ...out });
  }
  return out;
}

const expand = (value: string, scope: Readonly<Record<string, string>>): string =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_all, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      return scope[name] ?? '';
    },
  );

/** Read + parse a declared env file. A file that is named but missing yields nothing: the session
 *  still starts (a supervisor whose sessions refuse to boot is worse than one variable short), and
 *  `list`/`doctor` are what say so. */
export function readEnvFile(
  path: string,
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'), base);
  } catch {
    return {};
  }
}

/**
 * Names ccmux controls and a project file may never set.
 *
 * Without this, an `.env` in a working directory could set `CCMUX_STATE_DIR` and point the session's
 * whole instance elsewhere, or set `CCMUX_SESSION` and make one session answer to another's name —
 * from a file that is often not even in version control. The recipe grants a session variables; it
 * does not let a project reconfigure its supervisor.
 */
export const RESERVED_ENV_PREFIX = 'CCMUX_';
export const isReservedEnvKey = (key: string): boolean =>
  key.startsWith(RESERVED_ENV_PREFIX) || key === CHAT_CREDENTIAL_ENV;

export interface SessionEnvRecipe {
  env: Record<string, string>;
  /** Names the declared file tried to set but is not allowed to — surfaced, never silently dropped. */
  refused: string[];
  /** Names that were inherited implicitly and have now been removed. Diagnostics only. */
  removed: string[];
}

/**
 * Build the environment a session's agent should receive.
 *
 * Order: inherited environment, minus anything the working directory's env files declare, plus the
 * DECLARED file. The declared file wins — the original note is explicit that anything else means no
 * determinism, and notes that today's behaviour is the opposite (the runtime does not overwrite what
 * is already set).
 */
export function sessionEnvRecipe(
  s: Pick<Session, 'dir' | 'envFile'>,
  inherited: Readonly<Record<string, string | undefined>>,
  nodeEnv: string | undefined,
): SessionEnvRecipe {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inherited)) if (v !== undefined) env[k] = v;

  const declaredPath = envFilePath(s);
  const declared = declaredPath === null ? {} : readEnvFile(declaredPath, env);

  // Mechanism 2 (see the module note): drop what the directory's files declare, unless the session
  // declared that same file on purpose — in which case it is about to be applied deliberately.
  const removed: string[] = [];
  for (const path of envFiles(s.dir, nodeEnv)) {
    if (path === declaredPath) continue;
    for (const key of Object.keys(readEnvFile(path, env))) {
      if (key in env && !(key in declared)) {
        delete env[key];
        removed.push(key);
      }
    }
  }

  const refused: string[] = [];
  for (const [key, value] of Object.entries(declared)) {
    if (isReservedEnvKey(key)) refused.push(key);
    else env[key] = value;
  }
  return { env, refused: refused.sort(), removed: [...new Set(removed)].sort() };
}

/**
 * Is this RUNNING session still carrying variables nobody declared?
 *
 * Three states have to be told apart, and getting it wrong in either direction is expensive: reporting
 * a session that is already clean is crying wolf, and missing one means it silently loses its
 * variables at the next restart.
 *
 *  - **no stamp at all** — nothing is known, and unknown is never reported (the same doctrine the
 *    RESTART column follows).
 *  - **a stamp with no `inputs` map** — written before the launch recipe existed, so this session was
 *    launched by a build that DID inherit the directory's env files. If such a file is there, it is
 *    reaching that agent right now. This is the case the first version of this check missed, which
 *    made the migration list read empty on the very fleet that needed it.
 *  - **a stamp whose `inputs.env` is null** — launched under the recipe with nothing declared, so a
 *    file sitting in the directory is inert and must not be reported.
 *
 * One predicate, shared by `doctor` and `env-file --adopt`, so the report and the fix can never
 * disagree about who is on the list.
 */
export function inheritsUndeclaredEnv(
  s: Pick<Session, 'dir' | 'envFile' | 'archived'>,
  stamp: LaunchStamp | null,
  nodeEnv: string | undefined,
): boolean {
  if (s.archived || s.envFile !== undefined || stamp === null) return false;
  const launchedBeforeTheRecipe = stamp.inputs === null;
  const stampedADirectoryFile =
    stamp.inputs !== null && stamp.inputs.env !== null && stamp.inputs.env !== undefined;
  if (!launchedBeforeTheRecipe && !stampedADirectoryFile) return false;
  return envFiles(s.dir, nodeEnv).some((p) => fileDigest(p) !== null);
}
