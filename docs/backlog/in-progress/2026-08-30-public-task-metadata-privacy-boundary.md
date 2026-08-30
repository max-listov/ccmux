---
title: Keep operational coordination identities out of public task documents
description: Remove private coordination metadata from public-facing backlog records and qualify the publication guard without embedding private identifiers.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
---

## Why

A bounded source/document audit identified two public-facing records for review:

- `docs/backlog/inbox/2026-08-30-external-thread-content-capability.md` requires generic technical scope
  without an operational executor or return-routing footer.
- `docs/backlog/done/2026-08-29-codex-model-catalog-read.md` has concrete deployment machine labels
  in its rollout evidence near line 100. The record is tracked and predates this audit.

The exact values are deliberately not copied here. `CLAUDE.md` already prohibits private machine,
session and consumer identifiers. `.githooks/pre-commit` checks home-path shapes, not arbitrary
operational identities, so passing that hook alone is not full privacy verification. No secret
value was inspected, and this audit does not claim to have scanned every published asset or Git revision.

## Result

Public tasks contain generic technical requirements and anonymized evidence only. Exact executor,
consumer, private membership and return-routing data stay in authorized private coordination,
never in a public library's backlog or release notes.

## Scope

The bounded follow-up permits removing the operational footer from the active inbox document
only, preserving its technical scope. The historical done record, Git history and refs remain
untouched. Exact historical evidence and the proposed minimal redaction are retained privately,
not copied into this public task. Publication-guard changes need separate scope agreement.
No index change, commit, publication or rollout is part of this follow-up.

- [x] Remove operational executor/return metadata from the pending public draft after scope agreement.
- [ ] Resolve the historical record through an explicitly agreed minimal privacy correction;
      preserve its technical acceptance and release evidence and do not rewrite Git history implicitly.
- [ ] Define publication verification for coordination metadata using generic structural fixtures,
      without publishing the protected identifiers in a denylist or test case.

## Acceptance

- [ ] The two identified public-facing records contain no concrete private machine/session identity.
- [x] Generic release version, commit and artifact evidence remain intact.
- [x] Privacy verification covers the agreed scope and names any unscanned history/assets explicitly.
- [x] No private companion path, consumer identity or report destination is copied into public source,
      fixtures, task records, commit messages or release notes.

## Что сделано

- [x] Removed only the two-line operational footer from the active external-content inbox document;
      its problem, result, boundaries and technical acceptance are unchanged.
- [x] Preserved the historical done document byte-for-byte: SHA-256
      `666184ed6536ca71a7f9df719398ccb45c1eec44975f3ea8399d9f716624bc63` before and after.
      Exact finding, last-modifying commit and proposed one-line redaction are retained in private
      evidence outside this repository and returned by the authorized direct coordination channel.
- [x] Targeted search confirms the changed active draft has no concrete operational identity.
      No full historical or release-asset privacy scan is claimed. Git refs/history/index are untouched.
- [ ] Separately agree historical redaction and publication-guard scope. They remain deliberately
      unimplemented; neither this record nor a passing hook is blanket publication approval.
