import { VERSION } from '../util/version.ts';

/** One flag a command reads. `int` is a whole number, checked against `min`/`max`; `list` may repeat
 *  and each value may itself be comma-separated. The spec is what `parseFlags` accepts — nothing else. */
export type FlagSpec = {
  name: string;
  short?: string;
  kind: 'boolean' | 'string' | 'int' | 'list';
  min?: number;
  max?: number;
};

type HelpEntry = {
  verb: string;
  args: string;
  desc: string;
  example?: string;
  note?: string;
  flags?: FlagSpec[];
};

/** Public command surface (hidden internals `_run`/`_restart-worker` are intentionally omitted). */
export const COMMANDS: HelpEntry[] = [
  {
    verb: 'control',
    args: '<sessions|session|message|start|interrupt|wait|watch> [--help]',
    desc: 'typed local daemon API; watch streams bounded snapshots, commands require exact session identity',
    example: 'ccmux control sessions',
  },
  {
    verb: 'control-native-stream',
    args: '',
    desc: 'fixed stable-cursor NDJSON producer for an allowlisted transport profile; accepts only a typed target on stdin',
  },
  {
    verb: 'status',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '[--json]',
    desc: 'bounded daemon monitoring snapshot; managed-only, no per-reader pane/transcript scans; exit 2 stale, 3 unavailable',
    example: 'ccmux status --json',
  },
  {
    verb: 'runtime',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '<name|machine:name> [--json]',
    desc: 'bounded native runtime state, generation and event window; exit 2 stale, 3 unavailable',
    example: 'ccmux runtime agent-a --json',
  },
  {
    verb: 'list',
    flags: [
      { name: 'json', kind: 'boolean' },
      { name: 'all', kind: 'boolean' },
    ],
    args: '[--json] [--all]',
    desc: 'managed sessions with explicit agent provider + status/uptime; the RESTART column names what a restart would change (rules/mcp/env/chat/mode/modules/config) — empty means nothing to pick up',
    example: 'ccmux list',
  },
  {
    verb: 'new',
    flags: [
      { name: 'agent', kind: 'string' },
      { name: 'runtime', kind: 'string' },
      { name: 'env-file', kind: 'string' },
      { name: 'router', kind: 'boolean' },
    ],
    args: '<name> <dir> [--agent claude|codex|opencode] [--runtime tui|app-server|native] [--env-file PATH] [--router] [-- flags]',
    desc: 'create a managed session; OpenCode uses authenticated native control, Codex optionally uses App Server',
    example: 'ccmux new agent-a ~/code/demo --agent opencode',
  },
  {
    verb: 'rm',
    flags: [{ name: 'force', short: 'f', kind: 'boolean' }],
    args: '<name> [-f|--force]',
    desc: 'stop + unregister (jsonl history kept)',
  },
  {
    verb: 'renew',
    flags: [{ name: 'force', kind: 'boolean' }],
    args: '<name> [--force]',
    desc: 'give the session a FRESH conversation, keeping its dir/mode/chat/prompt modules — the way out when its transcript was deleted; refuses while the conversation is still there',
    example: 'ccmux renew agent-a',
  },
  {
    verb: 'adopt',
    flags: [
      { name: 'fork', kind: 'boolean' },
      { name: 'takeover', kind: 'boolean' },
      { name: 'confirm-writer', kind: 'int', min: 2 },
    ],
    args: '<claude|codex> <uuid> [name] [--fork | --takeover --confirm-writer <pid>]',
    desc: 'manage a local external thread; Codex adopt is atomic resume, fork is provider-native, takeover is dedicated-CLI-only',
    example: 'ccmux adopt codex 4e117aea-… --fork',
  },
  { verb: 'start', args: '<name>', desc: 'start a registered session' },
  {
    verb: 'stop',
    flags: [{ name: 'force', short: 'f', kind: 'boolean' }],
    args: '<name> [-f|--force]',
    desc: 'kill it (daemon re-heals unless archived)',
  },
  {
    verb: 'events',
    flags: [
      { name: 'follow', short: 'f', kind: 'boolean' },
      { name: 'json', kind: 'boolean' },
      { name: 'framed', kind: 'boolean' },
      { name: 'since', kind: 'string' },
      { name: 'cursor-env', kind: 'string' },
      { name: 'session', kind: 'string' },
      { name: 'n', kind: 'int', min: 1 },
    ],
    args: '[-f|--follow] [--since <iso>] [--cursor-env <NAME>] [--session <name>] [-n N] [--json|--framed]',
    desc: 'what HAPPENED to sessions — turn boundaries, waiting at a menu, stop/blocked, inventory changes; --follow streams them as they occur; --framed wraps each line for a transport that resumes, and --cursor-env names the variable that transport hands the resume point back in',
    example: 'ccmux events --follow --json',
  },
  {
    verb: 'env-file',
    flags: [
      { name: 'none', kind: 'boolean' },
      { name: 'adopt', kind: 'boolean' },
      { name: 'dry-run', kind: 'boolean' },
    ],
    args: '<name> <path|--none> | --adopt [--dry-run]',
    desc: "declare the env file a session's agent is launched with (applies on restart); --adopt declares what sessions are currently inheriting undeclared",
    example: 'ccmux env-file cc-api .env',
  },
  {
    verb: 'dir',
    args: '<name|machine:name> <path> | <name> (read) | (no args to list)',
    desc: "move a session's registered directory without losing its conversation — the checkout moved, the session should not be recreated to follow it. Applies on the next start, because a running agent's cwd belongs to its process; `list` marks it 'dir' until then",
    example: 'ccmux dir cc-api /Users/u/work/api/src',
  },
  {
    verb: 'role',
    flags: [{ name: 'none', kind: 'boolean' }],
    args: '<name|machine:name> <role|--none> | (no args to list)',
    desc: 'declare what a session is FOR, and address it by that: ccmux msg <machine>:@<role>. Applies at once — no restart. A role matching two sessions REFUSES the address and shows both, rather than silently picking one',
    example: 'ccmux role cc-api contract-owner',
  },
  {
    verb: 'relay',
    flags: [
      { name: 'task', kind: 'string' },
      { name: 'communication-authorization', kind: 'string' },
    ],
    args: 'owner/<name> [--task X] [--communication-authorization <JSON file>] "<their answer>"',
    desc: 'bring an answer back from an owner OUTSIDE the fleet — recorded as a relay (on behalf of), delivered to whoever wrote, and the letter stops waiting; a session recipient requires a communication authorization file just like msg',
    example: 'ccmux relay owner/contract-owner "shipped in 1.2.0"',
  },
  {
    verb: 'restart',
    flags: [{ name: 'all', kind: 'boolean' }],
    args: '<name|machine:name> | --all',
    desc: 'bounce a session (survives killing the caller); --all sweeps every session on this machine, one at a time and reports the result back to the session that started it',
    example: 'ccmux restart --all',
  },
  {
    verb: 'mode',
    args: '<name> <mode|default>',
    desc: 'per-session permission-mode override (default = inherit machine); restart to apply',
    example: 'ccmux mode cc-api auto',
  },
  {
    verb: 'send',
    args: '<name|machine:name> <keys...>',
    desc: 'PRESS KEYS in a session (slash commands, short answers) — not a way to write to an agent: nothing is recorded, the reader cannot tell it from the human typing, there is no reply address, and it types even into a menu. Use msg for that',
    example: "ccmux send cc-api '/compact'",
  },
  {
    verb: 'msg',
    flags: [
      { name: 'communication-authorization', kind: 'string' },
      { name: 'task', kind: 'string' },
      { name: 'json', kind: 'boolean' },
      { name: 'interrupt', kind: 'boolean' },
      { name: 'on-behalf-of', kind: 'string' },
      { name: 'to-agent', kind: 'string' },
      { name: 'to-thread', kind: 'string' },
      { name: 'after', kind: 'int', min: 1 },
    ],
    args: '<to|machine:to|app/UUID|machine:app/UUID|owner> <text...> [--communication-authorization <JSON file>] [--to-agent claude|codex|opencode] [--to-thread UUID] [--task X] [--interrupt] [--after <sec>] [--on-behalf-of <who>]  |  cancel <task>  |  pending [task]  |  sent [task] [--json]',
    desc: "chat a managed session, an exact Codex App thread, or 'owner'; 'pending' shows what is still undelivered and how long it has waited, 'sent' shows what this session sent and the reference each letter can be continued by, 'cancel' withdraws your own conditional mail — by SESSION, so a restart does not orphan it; --to-agent/--to-thread pin replies; mail ARRIVES AT THE RECIPIENT'S TURN BOUNDARY by default (an idle session gets it at once) — --interrupt breaks into a running turn instead, --after N is a timer",
    note: 'sender is automatic and verified: managed session, exact App thread, or cli. Every session target requires --communication-authorization: JSON naming a basis — user-instruction (whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope 40–4000 chars, verbatim userAuthorizationQuote, sourceMessageRef), peer-letter (the same, with sourceMessageRef as <peer thread uuid>#<message uuid> resolved against this machine\u2019s records), or thread-continuation (that reference alone, repeating nothing) — a successful send prints the reference of the letter it just created, and `sent` lists them again. A prose reference stays an unverified caller claim, not a grant. Owner messages and cancellation do not require it. See docs/communication-authorization.md.',
    example:
      "ccmux msg host-b:app/4e117aea-… 'build is green' --communication-authorization /absolute/authorization.json --to-agent codex --to-thread 4e117aea-…",
  },
  {
    verb: 'inbox',
    flags: [{ name: 'peek', kind: 'boolean' }],
    args: '[name|machine:name] [--peek]',
    desc: "read a session's still-UNDELIVERED chat + mark read (--peek doesn't); each line says WHY it hasn't landed (recipient stopped, chat off, waiting for the turn to end, human typing…); a message already pushed to the pane isn't here — inbox is the fallback for offline/held mail, not an archive",
    example: 'ccmux inbox',
  },
  {
    verb: 'chat',
    flags: [
      { name: 'n', kind: 'int', min: 1 },
      { name: 'fleet', kind: 'boolean' },
      { name: 'json', kind: 'boolean' },
      { name: 'follow', short: 'f', kind: 'boolean' },
      { name: 'framed', kind: 'boolean' },
      { name: 'since', kind: 'string' },
      { name: 'cursor-env', kind: 'string' },
    ],
    args: '<log [-n N] [--fleet] [--json] [-f|--follow [--framed] [--since CURSOR] [--cursor-env NAME]] | on <name|machine:name> | off <name|machine:name> | default <name|machine:name>>',
    desc: "the exchange log — what arrived AND what this machine sent elsewhere (including sends that never left); --fleet merges every machine's log into one time-ordered stream; per-session enable (default off)",
    example: 'ccmux chat log --fleet -n 50',
  },
  {
    verb: 'router',
    args: '<on <name> | off <name>>',
    desc: 'promote or demote a session to router mode (the autonomous-manager protocol): `on` adds the protocol module and enables chat, `off` removes it and leaves chat as it is; launch-time, so it applies on the next restart',
    example: 'ccmux router on <name>',
  },
  {
    verb: 'logs',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '<name|machine:name> [lines] [--json]',
    desc: "print a session's pane buffer",
  },
  {
    verb: 'transcript',
    flags: [
      { name: 'json', kind: 'boolean' },
      { name: 'last-message', kind: 'boolean' },
      { name: 'image', kind: 'string' },
      { name: 'agent', kind: 'string' },
      { name: 'tail', kind: 'int', min: 1 },
      { name: 'cursor', kind: 'int', min: 0 },
      { name: 'before', kind: 'int', min: 1 },
      { name: 'limit', kind: 'int', min: 1 },
      { name: 'text-limit', kind: 'int', min: 1 },
      { name: 'grep', kind: 'string' },
      { name: 'fixed-strings', short: 'F', kind: 'boolean' },
      { name: 'ignore-case', short: 'i', kind: 'boolean' },
      { name: 'case-sensitive', short: 's', kind: 'boolean' },
      { name: 'role', kind: 'list' },
      { name: 'kind', kind: 'list' },
    ],
    args: '<name|machine:name|app/UUID|machine:app/UUID|external:provider:machine#UUID> <--json [--tail N] [--cursor LINE] [--before LINE --limit N] [--text-limit CHARS] [--agent ID] | --last-message | --image ADDRESS | --grep PATTERN [-F|--fixed-strings] [-i|--ignore-case] [-s|--case-sensitive] [--role R,..] [--kind K,..] [--limit N] [--json]>',
    desc: "conversation history as JSON (incremental reads via --cursor; --tail up to 1000; --agent reads a spawned agent's transcript, --text-limit widens each message), --last-message for just the agent's final answer as text (full, not clipped), --image for one image as a data URL, or --grep to search the WHOLE history: one line per match (SEQ, age, role, kind, field, excerpt) and the range searched; case-insensitive unless the pattern has a capital; SEQ works with --before; --cursor/--before/--tail narrow the range; exit 0 found, 1 not",
    example: "ccmux transcript cc-api --grep 'deploy|rollback' --kind message",
  },
  {
    verb: 'usage',
    flags: [
      { name: 'json', kind: 'boolean' },
      { name: 'fleet', kind: 'boolean' },
      { name: 'since', kind: 'string' },
      { name: 'until', kind: 'string' },
      { name: 'timezone', kind: 'string' },
      { name: 'cursor', kind: 'string' },
      { name: 'pipeline-cursor', kind: 'string' },
      { name: 'limit', kind: 'int', min: 1 },
    ],
    args: '[address|--fleet] [--json] [--since ISO] [--until ISO] [--timezone IANA] [--cursor TOKEN] [--pipeline-cursor TOKEN] [--limit N]',
    desc: 'measured token usage, cache and daily/model breakdown without conversation content; exit 2 means incomplete coverage',
  },
  {
    verb: 'state',
    flags: [
      { name: 'json', kind: 'boolean' },
      { name: 'since', kind: 'string' },
    ],
    args: '[<name|machine:name>] [--since ISO] [--json]',
    desc: "one session's state by its ordinary address, for a job the session started: running, state, when the current life began, the conversation id; --since (the job's start) says whether that life is the same, restarted or stopped. Name defaults to CCMUX_SESSION. Exit 0 exists, 3 no such session, 1 could not ask (unknown or unreachable machine)",
    example: 'ccmux state host-a:agent-a --since 2026-09-23T08:00:00+07:00 --json',
  },
  {
    verb: 'window',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '<name|machine:name> [--json]',
    desc: "open a terminal window beside a running session's agent, in its directory, and print its tmux pane and window ids; created detached, so the agent's window stays current and keeps its size. It lives and dies with the session: stop, restart and the heal of a dead agent take it down, and ccmux never types into it. Exit 0 opened, 3 no such session, 1 not running or could not ask",
    example: 'ccmux window agent-a --json',
  },
  {
    verb: 'wait',
    flags: [
      { name: 'timeout', kind: 'int', min: 1 },
      { name: 'quiet', short: 'q', kind: 'boolean' },
    ],
    args: '<name|machine:name> [--timeout N] [-q|--quiet]',
    desc: 'block until the session is between turns — exit 0 settled (the line says whether it finished or was interrupted), 2 timed out, 1 unknown/stopped; no polling loops, works without chat',
    example: 'ccmux wait cc-api && ccmux transcript cc-api --last-message',
  },
  {
    verb: 'models',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '<launch-recipe-id> [--json]',
    desc: "check a Custom recipe's declared model registry against the provider that must serve it: per model, whether the provider serves that id and whether a published context window contradicts the declared one; a diagnostic, never a startup dependency — exit 0 settled, 2 contradicted, 1 could not look",
    example: 'ccmux models <launch-recipe-id>',
  },
  {
    verb: 'doctor',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '[--json]',
    desc: 'health check: bins, config, daemon; verifies the fleet map really points where it claims',
  },
  {
    verb: 'fleet',
    flags: [
      { name: 'json', kind: 'boolean' },
      { name: 'all', kind: 'boolean' },
    ],
    args: '[--json] [--all]',
    desc: 'every managed session on every fleet machine, with explicit provider and full address; never infer a target from cwd/project; an older peer with no provider reports unknown, not Claude',
    example: 'ccmux fleet',
  },
  {
    verb: 'external',
    flags: [{ name: 'json', kind: 'boolean' }],
    args: '[--json]',
    desc: 'local unmanaged threads as observed evidence; pass the exact row key to transcript --json to read records without adoption',
    example: 'ccmux external --json',
  },
  {
    verb: 'completions',
    args: '<bash|zsh|fish>',
    desc: 'print a shell completion script (generated from the command list)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The help example shows shell interpolation, not JavaScript.
    example: 'ccmux completions zsh > "${fpath[1]}/_ccmux"',
  },
  {
    verb: 'update',
    flags: [
      { name: 'check', kind: 'boolean' },
      { name: 'force', kind: 'boolean' },
      { name: 'rollback', kind: 'boolean' },
    ],
    args: '[--check|--rollback|--force]',
    desc: 'self-update binary + bounce daemon (sessions live)',
  },
  {
    verb: 'install',
    flags: [
      { name: 'rc-prefix', kind: 'string' },
      { name: 'release-url', kind: 'string' },
      { name: 'artifacts-only', kind: 'boolean' },
      { name: 'force', kind: 'boolean' },
    ],
    args: '[--rc-prefix <name>] [--release-url URL] [--force] | --artifacts-only',
    desc: "write config + boot unit; start daemon (--rc-prefix = this machine's label, e.g. local/dev/prod; --release-url wires autoUpdate)",
  },
  { verb: 'uninstall', args: '', desc: 'remove boot unit (sessions + history kept)' },
  { verb: 'ensure', args: '', desc: 'run one heal pass now' },
  {
    verb: 'tui',
    args: '[-f|--fullscreen]',
    desc: 'interactive fleet TUI (bare `ccmux` does this too); it opens on the managed fleet and `x` adds the local inventory of sessions outside ccmux (`externalInventory` governs external CONTENT access, not this view)',
  },
  { verb: 'version', args: '', desc: 'print version' },
  { verb: 'help', args: '[command]', desc: 'this help, or help for one command' },
];

function sig(e: HelpEntry): string {
  return `${e.verb} ${e.args}`.trimEnd();
}

/** The ONE usage line for a verb — the single source `<cmd> --help` and a command's own arg-error
 *  both render, so they can never drift (the exact divergence that shipped in 0.1.16). */
export function usageLine(verb: string): string {
  const e = COMMANDS.find((c) => c.verb === verb);
  if (e === undefined) return `usage: ccmux ${verb}`;
  const note = e.note !== undefined ? `   (${e.note})` : '';
  return `usage: ccmux ${sig(e)}${note}`;
}

/** Pure renderer (testable). Returns null for an unknown command verb. */
export function helpText(verb?: string): string | null {
  if (verb !== undefined && verb !== '') {
    const e = COMMANDS.find((c) => c.verb === verb);
    if (e === undefined) return null;
    const lines = [`ccmux ${sig(e)}`, `  ${e.desc}`];
    if (e.example !== undefined) lines.push(`  e.g. ${e.example}`);
    return lines.join('\n');
  }
  const w = Math.max(...COMMANDS.map((c) => sig(c).length));
  const body = COMMANDS.map((c) => `  ${sig(c).padEnd(w)}  ${c.desc}`).join('\n');
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
