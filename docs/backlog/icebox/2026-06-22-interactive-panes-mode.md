---
title: `ccmux panes` — several agents side by side, and you can type into each
description: One tmux window, one pane per agent, each pane a real live agent (not a mirror); the hard part is that a conversation uuid can only run once, so grouping must take sessions over rather than duplicate them
type: task
status: icebox
created: 2026-06-22
updated: 2026-08-25
related: docs/decisions/2026-06-22-no-readonly-pane-mirror.md
defrost: по решению владельца. Разморозка — когда несколько агентов рядом в одном окне понадобятся на практике; до тех пор ручной tmux покрывает это без риска для инварианта «один uuid — один писатель».
---

# Interactive pane mode

Seeing N agents at once **and being able to type into each**, from one command. Interactive — not a
mirror; the read-only version was built, removed, and must not come back
(`docs/decisions/2026-06-22-no-readonly-pane-mirror.md`).

> **Заморожено 2026-08-25 по решению владельца** — задача и раньше несла «do not start without an
> explicit go», теперь это состояние записано статусом, а не только строчкой в тексте.

## Sketch (deferred — do not start without an explicit go)
- `ccmux panes agent-a agent-b` → one tmux window, one pane per agent, each running `ccmux _run
  <name>` — i.e. a **real live agent** in the pane (resumed by uuid, fully interactive). What you
  would do by hand, done for you.
- **The hard constraint:** one conversation uuid must never run twice. So an agent is EITHER a
  standalone session OR a member of a pane group — `panes` has to stop the standalone sessions
  first, not spawn copies beside them.
- A group marker (e.g. `groups.json` = `{window: [names]}`) so the daemon does not start a grouped
  agent a SECOND time as standalone; the duplicate-uuid case is the one that corrupts a conversation.
- Healing: conversation-level comes free (each pane is its own `_run`); pane/window-level means the
  daemon re-splits or recreates the window from the marker.
- Touches: a `panes` command (+ ungroup), group storage, the heal pass, cli, tests.

## Open question carried over
Should removing **another** session need confirmation, the way removing the one you are calling from
already does (`refusesSelf` + `--force`)? Today `rm <other>` goes through unchallenged. Not urgent —
noted so the question does not evaporate.
