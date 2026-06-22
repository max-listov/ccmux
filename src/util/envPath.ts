import { basename } from "node:path";
import { PLATFORM } from "../env.ts";

/** claude/codex draw their box-rules with Unicode; with NO UTF-8 locale they fall back to
 *  ASCII ('_' '|' '-') — the stray-underscore look. Boot daemons (launchd/systemd) start with
 *  no LANG, so force a UTF-8 one. Per-platform default: en_US.UTF-8 (macOS) / C.UTF-8 (Linux). */
export function ensureUtf8Locale(env: Record<string, string>): void {
  const cur = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  if (!/utf-?8/i.test(cur)) env.LANG = PLATFORM === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

/** The user's REAL login-shell PATH (fish-aware) — boot daemons (launchd/systemd) start
 *  with a thin PATH, so re-derive what the user's interactive shell would see. Mirrors bash
 *  ccmux: fish exposes $PATH space-separated → ask it to colon-join; POSIX prints as-is.
 *  Returns null if $SHELL is unset or the probe fails (callers fall back to ensurePath). */
export function loginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    const cmd = basename(shell) === "fish" ? "string join : $PATH" : 'printf %s "$PATH"';
    const proc = Bun.spawnSync([shell, "-lc", cmd], { stdout: "pipe", stderr: "ignore" });
    const out = proc.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Build a deduped PATH: caller-priority dirs first, then the inherited PATH, then a
 *  standard fallback set — so a spawned agent resolves git/rg/node/tmux even under a
 *  thin systemd/launchd PATH. Shared by every provider's launchEnv. */
export function ensurePath(current: string | undefined, extra: string[]): string {
  const std = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...extra, ...(current ? current.split(":") : []), ...std]) {
    if (p !== "" && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out.join(":");
}
