import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { HOME } from "../env.ts";

/**
 * What shapes a session at startup but is NOT in argv.
 *
 * The launch stamp hashes the argv a session is spawned with, which honestly covers everything ccmux
 * writes itself: the injected prompt, `--settings`, the mode, the flags. But the agent reads more
 * than argv when it boots — its global rule set, its MCP configuration — and the supervisor's own
 * runtime quietly contributes a fourth layer (the env files in the session's directory). None of it
 * is re-read by a running session, and none of it was visible.
 *
 * The cost of that blind spot is measured: a global rule set changed, every session on the fleet was
 * running yesterday's rules, and `ccmux list` showed a clean RESTART column for all of them. The only
 * remedy left was to bounce two dozen sessions blind, on three machines, without knowing which of
 * them had actually fallen behind.
 *
 * So an input is a NAMED, HASHED, EXTERNAL thing a launch reads. `reason` is the single word the
 * RESTART column prints; `digest` is what a later launch is compared against; `label` and `paths`
 * exist so `doctor` can say where a verdict came from instead of asking anyone to trust it.
 */
export interface LaunchInput {
  /** The word `list` prints in RESTART when this input has changed since launch. */
  reason: string;
  /** Human-facing origin, for `doctor`: what this digest actually covers. */
  label: string;
  /** Content digest, or `null` when the input does not exist on this machine. Absent is a STABLE
   *  value, not unknown: a rule file that has never existed must not read as "changed" every tick. */
  digest: string | null;
  /** The files that were read. Shown by `doctor`, never used for comparison. */
  paths: readonly string[];
  /** Variable NAMES this input contributes to the child environment — never their values. Present
   *  only for the environment input; a name answers "does the session have it", which is the only
   *  question asked here, and a value would put a secret in a diagnostic. */
  keys?: readonly string[];
}

export const digestOf = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Digest of one file's content, cached by mtime.
 *
 * The cache is not an optimisation detail — it is what makes this affordable at all. Stamps are
 * recomputed on every `list` and every `fleet`, which the TUI drives on a tick, so an uncached read
 * of a rule set plus a 100 KB configuration file would land on the hot path of a program whose idle
 * cost has already been an incident once (see `docs/architecture/tui-and-dev-flow.md`).
 *
 * A missing file is `null` and is NOT cached: there is no mtime to key on, and one `stat` is cheaper
 * than any scheme that would try.
 */
const cache = new Map<string, { mtimeMs: number; value: string }>();

function cachedDigest(key: string, path: string, compute: (text: string) => string | null): string | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs; // follows symlinks on purpose: a rule set is commonly a link
  } catch {
    cache.delete(key);
    return null;
  }
  const hit = cache.get(key);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.value;
  let value: string | null;
  try {
    value = compute(readFileSync(path, "utf8"));
  } catch {
    return null; // unreadable right now (a half-written config) — say nothing rather than guess
  }
  if (value === null) return null;
  cache.set(key, { mtimeMs, value });
  return value;
}

/** Digest of a whole file. */
export function fileDigest(path: string): string | null {
  return cachedDigest(path, path, (text) => digestOf(text));
}

/**
 * Digest of ONE FIELD of a JSON file, not of the file.
 *
 * Required, not fastidious: an agent's MCP servers live inside a configuration file that the agent
 * itself rewrites constantly — start counters, per-project state, cached feature flags. Hashing that
 * file would light the RESTART column for every session several times an hour and teach everyone to
 * ignore it, which is the precise failure this column was built to end. Keys are sorted so a rewrite
 * that only reorders them is not reported as a change.
 */
export function jsonFieldDigest(path: string, field: string): string | null {
  return cachedDigest(`${path}#${field}`, path, (text) => {
    try {
      const parsed: unknown = JSON.parse(text);
      const value = typeof parsed === "object" && parsed !== null && field in parsed ? (parsed as Record<string, unknown>)[field] : undefined;
      return value === undefined ? digestOf("<absent>") : digestOf(stableJson(value));
    } catch {
      return null;
    }
  });
}

/** Same idea for a TOML configuration: hash the named table, never the file around it. */
export function tomlTableDigest(path: string, table: string): string | null {
  return cachedDigest(`${path}#${table}`, path, (text) => {
    try {
      const parsed: unknown = Bun.TOML.parse(text);
      const value = typeof parsed === "object" && parsed !== null && table in parsed ? (parsed as Record<string, unknown>)[table] : undefined;
      return value === undefined ? digestOf("<absent>") : digestOf(stableJson(value));
    } catch {
      return null;
    }
  });
}

/** JSON with object keys sorted at every depth — so "the same configuration, written in a different
 *  order" is not a change anyone is asked to act on. */
export function stableJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Expand `~` against this user's home. A rule set commonly refers to one. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${HOME}${path.slice(1)}` : path;
}

/**
 * A rule set is a FILE PLUS WHATEVER IT PULLS IN, resolved for THIS machine.
 *
 * Rule files import each other (`@path`), and part of what they import is machine-specific. Hashing
 * only the entry file would call two machines identical while they were running different rules —
 * the same false "nothing changed" this whole change exists to remove, one level down.
 *
 * Depth is bounded and visits are remembered, because an import cycle is a thing people write by
 * accident and a supervisor may not hang on one. A path that does not resolve contributes as absent:
 * a rule file naming an import that is not there is a real difference between machines, and it is
 * one this digest should keep noticing.
 */
const IMPORT_RE = /(?:^|\s)@([^\s`'")\]]+)/g;
const MAX_IMPORT_DEPTH = 5;

export function ruleSetFiles(entry: string, depth = MAX_IMPORT_DEPTH, seen = new Set<string>()): string[] {
  const path = resolve(expandHome(entry));
  if (seen.has(path) || depth < 0) return [];
  seen.add(path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [path]; // absent, but still part of the set: "the import is missing here" is a difference
  }
  const out = [path];
  for (const match of text.matchAll(IMPORT_RE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    // Only things that LOOK like a path are followed. A rule file legitimately writes `@anthropic-ai/sdk`
    // or an email address, and chasing those would add noise to the digest and stat calls to the tick.
    const looksLikePath = raw.startsWith("~") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../");
    if (!looksLikePath) continue;
    const resolved = isAbsolute(expandHome(raw)) ? expandHome(raw) : resolve(dirname(path), raw);
    out.push(...ruleSetFiles(resolved, depth - 1, seen));
  }
  return out;
}

/** One digest over a whole set of files, stable under path order. */
export function fileSetDigest(paths: readonly string[]): string | null {
  const parts = [...new Set(paths)].sort().map((p) => [p, fileDigest(p)] as const);
  return parts.every(([, d]) => d === null) ? null : digestOf(JSON.stringify(parts));
}

/**
 * The env files the SUPERVISOR's runtime loads out of a session's directory — and therefore hands
 * to the agent and to every process the agent spawns.
 *
 * This is not a feature anyone designed. `_run` is a Bun process started with the session's directory
 * as its cwd, Bun loads `.env` from cwd into its own `process.env`, and `launchEnv` copies
 * `process.env` wholesale. Measured on a live fleet: sessions whose directory held an `.env` handed
 * their agent twenty-odd extra variables — project secrets among them — while sessions without one
 * handed over none. Nothing in `list`, `doctor` or the stamp said a word about it.
 *
 * Named here so it is at least VISIBLE while it remains true. Which files: the ones the runtime
 * itself reads, in its own precedence order, including the `NODE_ENV`-specific pair only when
 * `NODE_ENV` is actually set (verified: `.env.production` is not read without it).
 *
 * `nodeEnv` is a required parameter rather than a default read from the environment, because a
 * default would make an explicitly passed `undefined` silently mean "whatever this process has" —
 * which is exactly how a test asking about a machine with no NODE_ENV got answered about itself.
 */
export function envFiles(dir: string, nodeEnv: string | undefined): string[] {
  const files = [`${dir}/.env`, `${dir}/.env.local`];
  if (nodeEnv !== undefined && nodeEnv !== "") files.push(`${dir}/.env.${nodeEnv}`, `${dir}/.env.${nodeEnv}.local`);
  return files;
}

/** Variable NAMES declared by an env file. Deliberately a name-only parse: nothing here ever holds a
 *  value, so no diagnostic built on it can leak one. */
export function envFileKeys(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return [...new Set(keys)].sort();
}

/** Where a session's DECLARED env file lives. Relative resolves against `dir` (the form people
 *  write), absolute passes through. Pure — kept here, beside the other path helpers, so the recipe
 *  builder and the stamp cannot disagree about which file a session means. */
export function envFilePath(s: { dir: string; envFile?: string | undefined }): string | null {
  if (s.envFile === undefined) return null;
  return isAbsolute(expandHome(s.envFile)) ? expandHome(s.envFile) : resolve(s.dir, s.envFile);
}

/**
 * The environment input of a session: its DECLARED file, and nothing else.
 *
 * It used to be the files the runtime happened to load out of the working directory, because that
 * was the truth then. Now the pane runs with `--no-env-file` and the recipe subtracts those names,
 * so what shapes the agent's environment is what the session declared — and the stamp must describe
 * the recipe, not the accident it replaced.
 *
 * The change of meaning is itself useful: a session launched before this shipped carries a stamp
 * digesting its directory's `.env`, while a launch now would digest its declared file (usually
 * nothing). They differ, so `RESTART` says `env` — which is exactly true, because restarting it will
 * change its environment.
 */
export function envInput(s: { dir: string; envFile?: string | undefined }): LaunchInput {
  const path = envFilePath(s);
  if (path === null) return { reason: "env", label: "no env file declared", digest: null, paths: [], keys: [] };
  return {
    reason: "env",
    label: `declared env file: ${path}`,
    digest: fileDigest(path),
    paths: [path],
    keys: envFileKeys(path),
  };
}

/**
 * What the working directory WOULD leak in if nothing stopped it — the measurement that drives the
 * migration, and the only reason these paths are still computed at all.
 *
 * `doctor` uses it to say "this session is running on variables nobody declared, and it will stop
 * getting them when it restarts", and `env-file --adopt` uses it to turn that into a declaration.
 * Once every such session declares its file, this returns nothing and the migration is provably
 * over — which is what makes "are we done" answerable instead of a matter of belief.
 */
export function inheritedEnvInput(dir: string, nodeEnv: string | undefined): LaunchInput {
  const paths = envFiles(dir, nodeEnv).filter((p) => fileDigest(p) !== null);
  const keys = [...new Set(paths.flatMap((p) => envFileKeys(p)))].sort();
  return {
    reason: "env",
    label: paths.length === 0 ? "no env file in the session directory" : `env file(s) in the session directory: ${paths.join(", ")}`,
    digest: fileSetDigest(paths),
    paths,
    keys,
  };
}
