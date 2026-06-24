import { VERSION } from "../util/version.ts";

type HelpEntry = { verb: string; args: string; desc: string; example?: string };

/** Public command surface (hidden internals `_run`/`_restart-worker` are intentionally omitted). */
export const COMMANDS: HelpEntry[] = [
  { verb: "list", args: "", desc: "managed sessions + status/uptime", example: "ccmux list" },
  { verb: "new", args: "<name> <dir> [-- flags]", desc: "create + start a session (pins a fresh uuid)", example: "ccmux new cc-api ~/code/api" },
  { verb: "rm", args: "<name> [--force]", desc: "stop + unregister (jsonl history kept)" },
  { verb: "adopt", args: "<uuid> [name] [--fork|--takeover]", desc: "manage an external session (live one: fork a copy, or take it over)", example: "ccmux adopt 4e117aea-… --fork" },
  { verb: "start", args: "<name>", desc: "start a registered session" },
  { verb: "stop", args: "<name> [--force]", desc: "kill it (daemon re-heals unless archived)" },
  { verb: "restart", args: "<name>", desc: "bounce it (survives killing the caller)" },
  { verb: "send", args: "<name> <keys...>", desc: "type into a session (text or /slash)", example: "ccmux send cc-api '/compact'" },
  { verb: "logs", args: "<name> [lines]", desc: "print a session's pane buffer" },
  { verb: "transcript", args: "<name> --json [--tail N] [--cursor LINE]", desc: "conversation history as JSON (incremental reads via --cursor)", example: "ccmux transcript cc-api --json --tail 50" },
  { verb: "doctor", args: "[--json]", desc: "health check: bins, config, daemon" },
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
