---
title: Typed application policy and applied evidence for managed native runtimes
description: Separate caller-owned agent policy from host-owned launch configuration without copying loops or widening permissions.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
---

## Problem

Published 0.39.24 ControlCreateSchema strictly accepts runtime, requestId, name, workspace,
flags, launchRecipe and modelSelection. It has no application instruction/skill/tool policy
boundary. Native OpenCode rejects launchRecipe and caller flags. Saving a desired policy in
a consumer cannot prove its application or bind it to native continuation.
Host-owned launch recipes correctly own credentials/process configuration; they must not
be repurposed as application prompts or permission bypasses.

## Required result

A typed, versioned application policy boundary independent from launch recipes and model choice.
The caller selects desired canonical instruction/project/skill sources and tool/MCP policy;
the host validates and materializes only supported, authorized inputs. Runtime adapters report
applied identity, versions/digests and explicit unsupported capabilities. Do not make the
supervisor select application prompts/skills or duplicate their canonical source bodies.

## Plan

- [x] Define the policy reference/composition contract with explicit trust and provenance.
  Reuse existing native facilities and the published custom harness seam where applicable.
- [x] Validate requested permissions against host authority; reject unsupported policy before
  launch/admission. No caller flags, arbitrary env path or inline credentials as a workaround.
- [x] Bind policy identity/revision to create idempotency, managed/native identity and recovery.
  A changed required source must refuse or perform an explicitly defined transition, never silently drift.
- [x] Expose safe applied policy/capability evidence in receipts/status/native snapshots without
  instruction bodies, secrets or host-private paths in public metadata.
- [x] Preserve native tool names and native approval/input behavior; do not inject policy into
  user-message history or create another provider loop/writer.
- [x] Verify canonical source loading and selected skill body application on a real native turn;
  desired metadata alone is insufficient. Cover restart, mismatched revision, unsupported policy.
- [ ] Publish typed service client/descriptor with exact version and packed consumer evidence.

## Acceptance

- [x] Two application policy profiles remain distinct under one host launch configuration.
- [x] Applied policy evidence survives restart of the same managed/native session.
- [x] Unsupported instruction/tool/permission fields fail explicitly without authority escalation.
- [x] Native session control and policy use the single current client contract; no legacy aliases,
  parallel versions or compatibility wrappers remain. Session identity and accepted work are preserved.
- [x] Consumer can distinguish desired, applied and unavailable policy without interpreting logs.

## Что сделано

- [x] `src/policy/` resolves immutable owner sources and native application evidence independently
  of launch configuration; source drift and unsupported authority fail before provider spawn.
- [x] `scripts/native-policy-acceptance.ts`: four profiles, eight actual marker responses from
  canonical instructions/skills/agents, same-ID retries, daemon/provider restart and source drift.
  Evidence SHA-256: `65d3c4086507d7bf15743fb2de0642fe00750aa75ab39ff7ceee12823f49614f`.
- [x] `test/policy-selection-admission.test.ts` closes the admission/dispatch policy-agent seam;
  `docs/decisions/2026-08-30-native-application-policy.md` documents the applied-evidence boundary.
