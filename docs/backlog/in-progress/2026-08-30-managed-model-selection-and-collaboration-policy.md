---
title: Preserve explicit model selection across managed launch and collaboration modes
description: Separate a selected model from the host launch profile and prevent collaboration presets from substituting a different model.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
---

## Problem

In v0.39.22 `ControlCreateSchema` accepts a host recipe but has no typed model selection. Choosing
another model consequently requires another private recipe containing different model flags.
A model catalog can change independently of host authentication and permissions; consumers should
not maintain one host recipe for every model.

The collaboration policy also changes selection. `prepareManagedCodexTurn` in
`src/agent/codex/appServer.ts` uses `preset.model ?? context.model`. Running that function with a
loaded thread model `selected-external-model` and a Plan preset model `preset-default-model`
produces `collaborationMode.settings.model = preset-default-model`. This deterministic source
probe demonstrates substitution; no live external-provider turn was claimed.

## Result

- The required consumer case is a native Codex session using its authenticated model catalog.
  Hosting OpenRouter or LM Studio inference is not required for this task. Existing external-provider
  capabilities may be preserved, but must not be a prerequisite for native Codex acceptance.
- Remain a session lifecycle/control adapter over the structured App Server protocol. Do not add
  an agent loop, application prompt/tool ownership, terminal scraping or simulated keystrokes.
- Add typed provider/model selection separate from the immutable host launch profile. Host-owned
  auth, endpoints, env sources and permissions remain private; no caller flags or arbitrary code.
- Keep the selected provider/model in durable create identity and receipts across retries and
  restart; refusal is explicit if the host cannot execute that selection.
- A collaboration preset may supply behavior/effort supported by that provider, but cannot silently
  override the loaded thread model. Check provider support and fail explicitly where unsupported.
- Existing known-model recipes must not be the only route to selecting newly catalogued models.

## План

- [x] Add typed provider/model selection to create, durable identity and safe projections.
- [x] Validate the selected provider against native host configuration and preserve selection across resume.
- [x] Preserve the loaded thread model when applying collaboration presets; prove native execution.

## Acceptance checks

- [x] Two models use one host provider profile without adding a recipe per model.
- [x] Same-ID retry with different selection is refused; restart preserves the selected model.
- [x] Different preset and thread models cannot silently switch inference providers/models.
- [x] A real native Codex turn executes a tool and its reported model matches the authenticated
  catalog selection, including after applying a differing collaboration preset.
- [ ] Updated clients/descriptor, focused regressions, release and runtime evidence are recorded.

## Что сделано

- `modelSelection: { provider, model }` is separate from the immutable recipe, fingerprints create
  requests and persists through the existing session transaction, launch stamp and native admission.
  Invalid native catalog selections refuse before writer creation. Accepted retries retain identity.
- `prepareManagedCodexTurn` uses the loaded model, never the preset's replacement model. Regression
  coverage checks substitution and pinned-context refusal before turn submission.
- Real `scripts/control-model-selection-acceptance.ts` used `gpt-5.6-luna` and `gpt-5.4-mini` with
  one Plan profile, verified three completed native shell-tool turns, same-ID retry/conflict,
  provider and daemon restart, native/status metadata, exact input response and terminal wait.
  A third recipe-less create verified the unchanged default path. All three probe sessions archived.
- The differing-preset case deliberately substitutes that field in an actual capability response
  before calling the production policy function, then submits a real native turn and verifies its
  model. It does not claim the installed provider itself advertised the differing preset.
- A repeat live run reproduced `list_turns is not supported yet` during fresh admission. The root
  was an unnecessary historical read after bootstrap; fresh threads now use their already-active
  native event subscription. Resume still reconciles bounded historical state. The fresh-admission
  regression asserts no history-list RPC and the complete live probe passed after this correction.
