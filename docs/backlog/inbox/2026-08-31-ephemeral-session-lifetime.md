---
title: Control-created sessions outlive their purpose in the fleet map
description: Give short-lived control-created sessions a declared lifetime so the human-facing fleet listing stays a map of real work.
type: task
status: inbox
created: 2026-08-31
updated: 2026-08-31
priority: P2
---

## Problem and evidence

Measured on the live fleet at v0.39.38: `ccmux fleet` listed 91 session rows, of which 56 were
short-lived sessions created by control-plane exercises and 55 were `stopped`. The human-facing map
is now about one third real work.

The contract already publishes `archive`, so the capability is not missing — nothing obliges a
creator to use it, and a session that is merely stopped stays in the registry forever. Creation
through the control plane is cheap and scriptable; removal is neither automatic nor implied.

This is a consequence of new capability, not a defect in it. But `fleet` is the primary surface a
person reads to answer "what is running", and a listing that is mostly residue answers that badly.

## Result

- A session created through the control plane can declare that it is short-lived, and the daemon
  retires it without the creator having to remember.
- A retired session leaves no row in the default human listing while remaining inspectable
  explicitly. Provider history is not deleted by retirement.
- Long-lived supervised sessions are unaffected: no lifetime is the default, and nothing
  retires a session a human created.

## Open questions

- Whether the lifetime is a declared TTL, an explicit ephemeral flag, or a creator lease that
  expires when the creating connection goes away. A lease is the most honest but the most work.
- Whether the default listing should also fold away long-stopped sessions independently of this,
  which would help the existing residue without any creator change.
