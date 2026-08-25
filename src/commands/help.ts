import { VERSION } from "../util/version.ts";

type HelpEntry = { verb: string; args: string; desc: string; example?: string; note?: string };

/** Public command surface (hidden internals `_run`/`_restart-worker` are intentionally omitted). */
export const COMMANDS: HelpEntry[] = [
  { verb: "list", args: "", desc: "managed sessions with explicit agent provider + status/uptime; the RESTART column names what a restart would change (rules/mcp/env/chat/mode/modules/config) — empty means nothing to pick up", example: "ccmux list" },
  { verb: "new", args: "<name> <dir> [--agent claude|codex] [-- flags]", desc: "create + start a provider-explicit session (Claude default; pins a fresh uuid)", example: "ccmux new cc-api ~/code/api --agent codex" },
  { verb: "rm", args: "<name> [--force]", desc: "stop + unregister (jsonl history kept)" },
  { verb: "renew", args: "<name> [--force]", desc: "give the session a FRESH conversation, keeping its dir/mode/chat/prompt modules — the way out when its transcript was deleted; refuses while the conversation is still there", example: "ccmux renew agent-a" },
  { verb: "adopt", args: "<claude|codex> <uuid> [name] [--fork | --takeover --confirm-writer <pid>]", desc: "manage a local external thread; Codex adopt is atomic resume, fork is provider-native, takeover is dedicated-CLI-only", example: "ccmux adopt codex 4e117aea-… --fork" },
  { verb: "start", args: "<name>", desc: "start a registered session" },
  { verb: "stop", args: "<name> [--force]", desc: "kill it (daemon re-heals unless archived)" },
  { verb: "events", args: "[--follow] [--since <iso>] [--session <name>] [-n N] [--json|--framed]", desc: "what HAPPENED to sessions — turn boundaries, waiting at a menu, stop/blocked; --follow streams them as they occur; --framed wraps each line for a transport that resumes", example: "ccmux events --follow --json" },
  { verb: "env-file", args: "<name> <path|--none> | --adopt [--dry-run]", desc: "declare the env file a session's agent is launched with (applies on restart); --adopt declares what sessions are currently inheriting undeclared", example: "ccmux env-file cc-api .env" },
  { verb: "restart", args: "<name|machine:name> | --all", desc: "bounce a session (survives killing the caller); --all sweeps every session on this machine, one at a time and reports the result back to the session that started it", example: "ccmux restart --all" },
  { verb: "mode", args: "<name> <mode|default>", desc: "per-session permission-mode override (default = inherit machine); restart to apply", example: "ccmux mode cc-api auto" },
  { verb: "send", args: "<name|machine:name> <keys...>", desc: "PRESS KEYS in a session (slash commands, short answers) — not a way to write to an agent: nothing is recorded, the reader cannot tell it from the human typing, there is no reply address, and it types even into a menu. Use msg for that", example: "ccmux send cc-api '/compact'" },
  { verb: "msg", args: "<to|machine:to|owner> <text...> [--to-agent claude|codex] [--to-thread UUID] [--task X] [--defer] [--after <sec>] [--on-behalf-of <who>]  |  cancel <task>", desc: "chat a deliverable managed session or 'owner' (you, Telegram-only); --to-agent/--to-thread pin and revalidate exact replies; a remote target is <machine>:<session>; --defer holds until turn end, --after N is a timer", note: "sender is automatic and process-authenticated: this managed session, or 'cli'", example: "ccmux msg cc-api 'build is green' --to-agent claude --to-thread 4e117aea-…" },
  { verb: "inbox", args: "[name|machine:name] [--peek]", desc: "read a session's still-UNDELIVERED chat + mark read (--peek doesn't); each line says WHY it hasn't landed (recipient stopped, chat off, waiting for the turn to end, human typing…); a message already pushed to the pane isn't here — inbox is the fallback for offline/held mail, not an archive", example: "ccmux inbox" },
  { verb: "chat", args: "<log [-n N] [--fleet] [--json] | on <name|machine:name> | off <name|machine:name>>", desc: "the exchange log — what arrived AND what this machine sent elsewhere (including sends that never left); --fleet merges every machine's log into one time-ordered stream; per-session enable (default off)", example: "ccmux chat log --fleet -n 50" },
  { verb: "logs", args: "<name> [lines]", desc: "print a session's pane buffer" },
  { verb: "transcript", args: "<name|machine:name> <--json [--tail N] [--cursor LINE] | --last-message>", desc: "conversation history as JSON (incremental reads via --cursor), or --last-message for just the agent's final answer as text (full, not clipped)", example: "ccmux transcript cc-api --last-message" },
  { verb: "wait", args: "<name|machine:name> [--timeout N] [--quiet]", desc: "block until the session is between turns — exit 0 settled (the line says whether it finished or was interrupted), 2 timed out, 1 unknown/stopped; no polling loops, works without chat", example: "ccmux wait cc-api && ccmux transcript cc-api --last-message" },
  { verb: "doctor", args: "[--json]", desc: "health check: bins, config, daemon; verifies the fleet map really points where it claims" },
  { verb: "fleet", args: "[--json]", desc: "every managed session on every fleet machine, with explicit provider and full address; never infer a target from cwd/project; an older peer with no provider reports unknown, not Claude", example: "ccmux fleet" },
  { verb: "completions", args: "<bash|zsh|fish>", desc: "print a shell completion script (generated from the command list)", example: "ccmux completions zsh > \"${fpath[1]}/_ccmux\"" },
  { verb: "update", args: "[--check|--rollback|--force]", desc: "self-update binary + bounce daemon (sessions live)" },
  { verb: "install", args: "[--rc-prefix <name>] [--release-url URL]", desc: "write config + boot unit; start daemon (--rc-prefix = this machine's label, e.g. local/dev/prod; --release-url wires autoUpdate)" },
  { verb: "uninstall", args: "", desc: "remove boot unit (sessions + history kept)" },
  { verb: "ensure", args: "", desc: "run one heal pass now" },
  { verb: "tui", args: "[-f|--fullscreen]", desc: "interactive fleet TUI (bare `ccmux` does this too); `x` toggles the external inventory, which is off unless the machine sets externalInventory" },
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
    `ccmux ${VERSION} — persistent agent sessions in tmux\n\n` +
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
