---
title: Separate native model discovery and selection from managed identity
description: Discover before a conversation, retain exact runtime scope, and pin selection without multiplying host profiles.
type: decision
status: active
created: 2026-08-30
updated: 2026-08-30
---

# Decision

Native App Server `model/list` is a runtime catalog, not a conversation operation. The control
service therefore accepts a host catalog read with no target. A metadata-only process uses the
same host binary, authentication and launch-environment mechanism, starts no thread, and is reaped
within the bounded read lifecycle. Explicit session reads use only the exact owned runtime socket.
The result names its source. Missing context-window metadata remains unknown.

The public create request can choose `{ provider, model }` independently of a host recipe.
The recipe continues to own authentication, endpoints, environment and permissions; typed selection
cannot change those. Selection is part of durable idempotency and safe projection. The native
catalog validates OpenAI choices before writer creation; native admission verifies the actual
selected provider/model and every restart keeps the same identity and selection.

Collaboration presets do not own model choice. The loaded thread model wins; missing capability,
missing model or disagreement with a pinned selection refuses the turn. CCMux uses native built-in
mode instructions, not copied application prompts or a new agent/tool loop.

# Alternatives rejected

- Creating a dummy conversation for discovery invents a writer and a history entry.
- Gating a machine socket read on an unrelated session UUID falsely labels its authority.
- One launch recipe per model couples volatile model inventory to host credentials and policy.
- Treating native picker results as another provider's model inventory makes unsupported claims.
- A provider-specific external inference proxy is outside native session control.

# Consequences

Cold reads launch a bounded metadata process; native catalog refresh/cache semantics remain native.
One call is one page, not a new CCMux model cache. Consumers reuse the published typed client and
unchanged transport envelope. Workspace discovery is separately authorized `directory.list`, not
shell execution or a mutation. Existing recipe-less/default creation remains supported.
