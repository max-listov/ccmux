---
title: No read-only pane mirror (`tile`) — a viewer you cannot type into is not a tool
description: A read-only capture-pane mirror was built and removed; watching several agents is already solved by an editor split, and the useful version of the idea is the interactive one (`panes`), which is a different feature
type: decision
status: active
created: 2026-06-22
updated: 2026-08-05
tags: [tui, panes, removed, scope]
---

# Killed: `tile` — a read-only mirror of several panes

## What it was
`src/commands/tile.ts` — one window showing N sessions side by side, filled by repeated
`capture-pane`. Watching only: the panes were a rendering of somebody else's terminal, not the
terminal itself.

## Why it was removed
Read-only is the whole problem. You cannot type into a session you are watching, so the moment the
view tells you something useful you have to leave it and go to the real session — which is the part
that actually costs time. And plain *watching* was never the expensive problem: an editor split (or
`tmux attach`) already does it, with zero code to maintain.

So it carried a real cost — a command, its rendering loop, its refresh policy — in exchange for
something already available for free.

## Do not reintroduce
A future "show me several agents at once" request is **not** an argument for bringing this back.
The version worth building is the interactive one, where each pane is a live agent you can type
into — tracked separately as `ccmux panes` in the project queue. Watching and working are
different tools, and only the second one earns its keep.
