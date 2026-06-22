// The exact-match `=NAME` invariant lives ONLY here. Without the leading `=`, tmux
// prefix-matches and `cc-api` would resolve to `cc-api-staging`. No call
// site is allowed to build a target string by hand.

export const exactTarget = (name: string): string => `=${name}`;
export const paneTarget = (name: string): string => `=${name}:0.0`;
