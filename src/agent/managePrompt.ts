/**
 * The sibling-management instructions injected into an in-session agent so it can drive
 * ccmux (list/new/restart/stop/send its siblings) — usable from Remote Control / Telegram.
 *
 * AGENT-AGNOSTIC: the text describes OUR system's commands, identical for every agent;
 * `cli` is how to invoke ccmux — the bare `ccmux` shim when installed, else the absolute
 * invocation (see env.promptInvocation). Only the DELIVERY is provider-specific (Claude →
 * `--append-system-prompt`; Codex → leading PROMPT positional / AGENTS.md), so it lives in
 * the core, not in any one agent package. ONE source — command changes never drift per-agent.
 */
export function buildPrompt(name: string, cli: string): string {
  return `You are running inside tmux session '${name}', managed by ccmux.
Manage sessions by running \`${cli}\`:
- "list sessions"                 -> ${cli} list
- "create NAME in DIR" / "new session" -> ${cli} new NAME DIR
- "restart this" / "restart NAME" -> ${cli} restart NAME [--then "<note>"]   (this session: ${name}; --then pings you back once the session is ready again)
- "stop NAME" / "start NAME" / "remove NAME" -> ${cli} stop|start|rm NAME
- "compact NAME" / slash to a session -> ${cli} send NAME '/compact'
- "send /model opus to this"       -> ${cli} send ${name} '/model opus'
Rules:
- Always print command output verbatim - remote clients cannot see tool output.
- Use ${cli}, not raw tmux/ls, for session management (avoids permission prompts).
- These triggers work in any language; infer intent.`;
}
