---
title: Keep operational coordination identities out of public task documents
description: Remove private coordination metadata from public-facing backlog records and qualify the publication guard without embedding private identifiers.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31 19:02 +0700
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

The approved completion scope includes the active-document correction, a minimal anonymization
of the identified historical rollout sentence, and a structural publication guard with generic
regression fixtures. Preserve technical acceptance, versions and artifact evidence. Git history,
existing tags and released artifacts are not rewritten. Exact historical values stay in private
evidence. This task participates in the integrated patch release and owned-runtime verification.

- [x] Remove operational executor/return metadata from the pending public draft after scope agreement.
- [x] Resolve the historical record through an explicitly agreed minimal privacy correction;
      preserve its technical acceptance and release evidence and do not rewrite Git history implicitly.
- [x] Define publication verification for coordination metadata using generic structural fixtures,
      without publishing the protected identifiers in a denylist or test case.

## Acceptance

- [x] The two identified public-facing records contain no concrete private machine/session identity.
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
- [x] Historical redaction and publication-guard scope are explicitly approved for completion on
      2026-08-31. A passing structural guard is not a claim to identify every private value.
- [x] Anonymized only the rollout machine labels in
      `docs/backlog/done/2026-08-29-codex-model-catalog-read.md`; version, CI runs, bundle checksum
      claim and technical acceptance are preserved. No Git history, tag or release asset was rewritten.
- [x] `scripts/publication-privacy.ts` owns structural rules; `scripts/check-publication.ts`
      checks current Markdown in the normal gate and staged additions through `.githooks/pre-commit`.
      Diagnostics return location/rule only. No protected values are embedded in fixtures or rules.
- [x] `test/publication-privacy.test.ts`: generic positive/negative cases, deleted text, source-line
      mapping, real staged-vs-working-tree disagreement, unchanged index bytes and non-echoing
      diagnostics all pass (4 tests / 15 assertions).
- [x] The first full current-Markdown scan also identified a machine-layout path in
      `docs/research/2026-07-30-t3code-analysis-ideas.md`; its source reference now uses generic
      checkout wording. The repeated scan covers 169 Markdown files with zero structural findings.
- [x] Complete local gate passes: 1006 tests / 5164 assertions across 170 files, plus browser,
      Bun/Node and both TypeScript packed-client resolutions. Manual changed-line review remains
      required for arbitrary private prose; historical revisions and assets are explicitly unscanned.
