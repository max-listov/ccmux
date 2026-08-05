import { VERSION } from "../util/version.ts";

type HelpEntry = { verb: string; args: string; desc: string; example?: string; note?: string };

/** Public command surface (hidden internals `_run`/`_restart-worker` are intentionally omitted). */
export const COMMANDS: HelpEntry[] = [
  { verb: "list", args: "", desc: "managed sessions + status/uptime", example: "ccmux list" },
  { verb: "new", args: "<name> <dir> [-- flags]", desc: "create + start a session (pins a fresh uuid)", example: "ccmux new cc-api ~/code/api" },
  { verb: "rm", args: "<name> [--force]", desc: "stop + unregister (jsonl history kept)" },
  { verb: "adopt", args: "<uuid> [name] [--fork|--takeover]", desc: "manage an external session (live one: fork a copy, or take it over)", example: "ccmux adopt 4e117aea-… --fork" },
  { verb: "start", args: "<name>", desc: "start a registered session" },
  { verb: "stop", args: "<name> [--force]", desc: "kill it (daemon re-heals unless archived)" },
  { verb: "restart", args: "<name|machine:name> | --all", desc: "bounce a session (survives killing the caller); --all sweeps every session on this machine, one at a time", example: "ccmux restart --all" },
  { verb: "mode", args: "<name> <mode|default>", desc: "per-session permission-mode override (default = inherit machine); restart to apply", example: "ccmux mode cc-api auto" },
  { verb: "send", args: "<name> <keys...>", desc: "type into a session (text or /slash)", example: "ccmux send cc-api '/compact'" },
  { verb: "msg", args: "<to|machine:to|owner> <text...> [--task X] [--defer] [--after <sec>] [--on-behalf-of <who>]  |  cancel <task>", desc: "chat a session (delivered to its pane) or 'owner' (you, Telegram-only); a target on another fleet machine is <machine>:<session> — see README; --defer holds until the target finishes its turn, --after N is a timer, cancel drops your still-undelivered mail for a task; body may also come from stdin (echo … | ccmux msg <to>)", note: "sender is automatic: this session, or 'cli'", example: "ccmux msg cc-api 'build is green — deploy when ready'" },
  { verb: "inbox", args: "[name] [--peek]", desc: "read a session's still-UNDELIVERED chat + mark read (--peek doesn't); each line says WHY it hasn't landed (recipient stopped, chat off, waiting for the turn to end, human typing…); a message already pushed to the pane isn't here — inbox is the fallback for offline/held mail, not an archive", example: "ccmux inbox" },
  { verb: "chat", args: "<log [-n N] [--fleet] [--json] | on <name> | off <name>>", desc: "the exchange log — what arrived AND what this machine sent elsewhere (including sends that never left); --fleet merges every machine's log into one time-ordered stream; per-session enable (default off)", example: "ccmux chat log --fleet -n 50" },
  { verb: "logs", args: "<name> [lines]", desc: "print a session's pane buffer" },
  { verb: "transcript", args: "<name|machine:name> <--json [--tail N] [--cursor LINE] | --last-message>", desc: "conversation history as JSON (incremental reads via --cursor), or --last-message for just the agent's final answer as text (full, not clipped)", example: "ccmux transcript cc-api --last-message" },
  { verb: "wait", args: "<name|machine:name> [--timeout N] [--quiet]", desc: "block until the session finishes its turn — exit 0 settled, 2 timed out (no polling loops; works without chat)", example: "ccmux wait cc-api && ccmux transcript cc-api --last-message" },
  { verb: "doctor", args: "[--json]", desc: "health check: bins, config, daemon; verifies the fleet map really points where it claims" },
  { verb: "fleet", args: "[--json]", desc: "every session on every fleet machine, each line showing the full address you can message; unreachable machines are marked, never fatal", example: "ccmux fleet" },
  { verb: "completions", args: "<bash|zsh|fish>", desc: "print a shell completion script (generated from the command list)", example: "ccmux completions zsh > \"${fpath[1]}/_ccmux\"" },
  { verb: "update", args: "[--check|--rollback|--force]", desc: "self-update binary + bounce daemon (sessions live)" },
  { verb: "install", args: "[--rc-prefix <name>] [--release-url URL]", desc: "write config + boot unit; start daemon (--rc-prefix = this machine's label, e.g. local/dev/prod; --release-url wires autoUpdate)" },
  { verb: "uninstall", args: "", desc: "remove boot unit (sessions + history kept)" },
  { verb: "ensure", args: "", desc: "run one heal pass now" },
  { verb: "tui", args: "[-f|--fullscreen]", desc: "interactive fleet TUI (bare `ccmux` does this too)" },
  { verb: "version", args: "", desc: "print version" },
  { verb: "help", args: "[command]", desc: "this help, or help for one command" },
];

function sig(e: HelpEntry): string {
  return `${e.verb} ${e.args}`.trimEnd();
}

/** The ONE usage line for a verb — the single source `<cmd> --help` and a command's own arg-error
 *  both render, so they can never drift (the exact divergence that shipped in 0.1.16). */
export function usageLine(verb: string): string {
  const e = COMMANDS.find((c) => c.verb === verb);
  if (e === undefined) return `usage: ccmux ${verb}`;
  const note = e.note !== undefined ? `   (${e.note})` : "";
  return `usage: ccmux ${sig(e)}${note}`;
}

/** Pure renderer (testable). Returns null for an unknown command verb. */
export function helpText(verb?: string): string | null {
  if (verb !== undefined && verb !== "") {
    const e = COMMANDS.find((c) => c.verb === verb);
    if (e === undefined) return null;
    const lines = [`ccmux ${sig(e)}`, `  ${e.desc}`];
    if (e.example !== undefined) lines.push(`  e.g. ${e.example}`);
    return lines.join("\n");
  }
  const w = Math.max(...COMMANDS.map((c) => sig(c).length));
  const body = COMMANDS.map((c) => `  ${sig(c).padEnd(w)}  ${c.desc}`).join("\n");
  return (
    `ccmux ${VERSION} — persistent Claude Code sessions in tmux\n\n` +
    `commands:\n${body}\n\n` +
    `sessions persist across logout/reboot; the daemon heals them. 'ccmux help <cmd>' for one.`
  );
}

export function cmdHelp(verb?: string): number {
  const t = helpText(verb);
  if (t === null) {
    console.log(`unknown command: ${verb}\nrun 'ccmux help' for the list.`);
    return 1;
  }
  console.log(t);
  return 0;
}
