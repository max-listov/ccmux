// The exact-match `=NAME` invariant lives ONLY here. Without the leading `=`, tmux
// prefix-matches and `cc-api` would resolve to `cc-api-staging`. No call
// site is allowed to build a target string by hand.

export const exactTarget = (name: string): string => `=${name}`;
/** Legacy agent-pane address, used only for a session that recorded no pane id: an index, which a
 *  second window can make point at the wrong pane (see `AGENT_PANE_OPTION`). */
export const paneTarget = (name: string): string => `=${name}:0.0`;
/** The session as `set-option` must name it. `set-option` resolves its target as a pane, and a bare
 *  `=NAME` is then no session at all — "no such session", on tmux 3.4 and 3.7 alike — so every option
 *  ccmux set that way was silently never applied. The trailing `:` keeps the exact match and names
 *  the session. */
export const sessionOptionTarget = (name: string): string => `=${name}:`;
