---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# ccmux — project conventions

## 🔒 This is a PUBLIC repo — never leak the maintainer's private identifiers
Everything committed here (code, docs, backlog, tests, comments) is published. NEVER write into
this repo the maintainer's private fleet/machine names, hostnames, machine `rcPrefix` values,
concrete session names, project names, usernames, email, or absolute home paths. This holds even
in examples, motivation text, and backlog notes.
- Use generic placeholders instead: `agent-A`/`agent-B` for sessions, `host-A`/`host-B` for
  machines, `<target>`/`<name>` for arguments, `/Users/u/...` or `~/...` for paths, `<prefix>` for
  an rcPrefix.
- Before finishing any edit that touches `.md`/comments, sweep the changed lines for private tokens.
- If unsure whether a term is private, treat it as private and use a placeholder.

`bun scripts/check-publication.ts` checks current tracked/untracked Markdown as part of the full
gate. The pre-commit hook uses the same structural rules on staged additions in every file type.
It rejects concrete home-path shapes, deployment-machine label shapes, operational frontmatter
and UUID-addressed return routes; diagnostics show only file, line and rule. Generic placeholders
remain valid. This is not an exhaustive private-name detector or a historical Git/asset scan:
review arbitrary prose manually, and never embed private identifiers in the checker itself.

### Commit messages carry the same rule — and one leak the list above missed
Claude Code appends `Co-Authored-By: Claude …` and `Claude-Session: https://claude.ai/code/session_…`
to commit messages **by default**. That default lives in the agent's environment, not in this repo,
so it is not something a session decides to do — it is something a session must be stopped from
doing. `Claude-Session` is a live link to the maintainer's private working session, published in a
public repository: more sensitive than any name in the list above, and absent from it. Two commits
reached `main` carrying both before this was written down.

NEVER let either line into a commit message here. Compose the message yourself rather than accepting
the default footer. `.githooks/commit-msg` refuses them, and `.githooks/pre-commit` refuses staged
content containing the maintainer's paths — a rule alone cannot hold against a default set outside
this repository, so the check is the mechanism and the rule is only its explanation.

## Release authority and completion
Follow the current maintainer mandate and global Git/index rules. An authorized owned-project
release includes gates, publication, rollout to owned runtimes and post-rollout verification;
do not ask for the same approval again. It does not authorize another project's deployment.
Local implementation, tests and release readiness do not themselves authorize publication or
rollout. Do not carry an earlier release mandate into a new local-only request: stop at the
verified working-tree result when the current instruction excludes release or production updates.
Close task checkboxes only against actual evidence. Implementation documentation travels with its
meaningful code commit, not an unsolicited separate bookkeeping commit. Documentation-only work
does not require a runtime version bump or rollout.

### Required order: finish → document → done/ → commit → release
1. Finish the implementation and its authorized checks.
2. Update the affected architecture documentation and record `## Что сделано` in the existing
   task with concrete file paths and evidence. Close acceptance checkboxes individually, only
   when verified; never mark an unperformed check as complete.
3. Once the task's acceptance is satisfied, set `status: done`, add the actual `completed`
   timestamp and move it to `docs/backlog/done/` before committing the completed work.
4. Only when the current mandate includes publication, commit, release and verify the owned runtimes. If acceptance
   requires post-release evidence, keep those items and the task open until that evidence exists.

This documentation obligation is independent of the checkout rule below: fixing the release
location must not remove task completion or architecture-documentation requirements. Routine
Git synchronization does not need a new backlog task.

## One canonical working checkout
Implementation, commits and the local release ceremony run from the maintainer's normal working
checkout. Never create a temporary release clone, secondary worktree or alternate-index commit
path to bypass the clean-tree guard or leave the visible checkout behind published history.
CI may check out the published tag to build assets; it is not a second development/release source.

This rule governs this repository's release checkout, not product-to-repository cardinality.
A product may include several repositories, and a repository may participate in several products.
Membership must be explicit; a dependency, directory or harness workspace name does not establish it.

Before releasing, reconcile the authorized changes in this checkout while preserving unrelated
reviewed changes. A clean-tree requirement is not permission to discard or reorganize the review
buffer. After publication, verify local HEAD, the published commit/tag and package version agree;
identify any deliberately retained local-only changes explicitly. A release is not complete while
the working checkout still presents already-published implementation as uncommitted work.

## One current control contract; no compatibility branches
Control APIs may make breaking changes: there is no required installed-client compatibility
population. Keep one current contract, descriptor, client path and native-content stream. Replace
superseded interfaces in the same change; do not retain legacy endpoints, aliases, version-parallel
clients, compatibility wrappers or fallback dispatch "for existing clients". While pre-release,
public route, client and profile names are unversioned: do not introduce V1/V2/V3 name families.
Required envelope/format validation and upstream protocol versions are not compatibility branches.
Update owned callers, examples, tests and release artifacts together. Provider-specific adapters and
local/remote transports share the same domain operations; they are not compatibility alternatives.

This does not authorize losing session identities, native history, credentials or accepted work.
Preserve durable state and one-writer/idempotency guarantees through an explicit bounded migration
when necessary, not through a second permanent runtime path. The prohibited branch arose from
assuming an installed-client requirement that the project does not have.

## ⚠️ TUI: горячий цикл и сироты (если «комп горячий»)
Интерактивный TUI (Ink) умеет жечь ядро и сиротеть — это **реальный инцидент** (`ccmux-dev -f`
держал ~84% ядра 14ч). Полный разбор + инварианты + пошаговый дебаг — **`docs/architecture/tui-and-dev-flow.md`
→ «Производительность рендера и время жизни»**. Кратко:
- Первый шаг при «комп горячий»: `ps aux | grep -E "src/cli.ts|ccmux.js" | grep -v grep` → `bun run
  src/cli.ts` на ~целом ядре часами = горячий рендер; `PPID=1` = осиротевший TUI (терминал закрыт, а
  он жив). Убивать `kill -9` (обычный `kill` сирота глушит). Демон при этом НЕ трогать — он отдельный.
- Инварианты, которые НЕЛЬЗЯ ломать: спиннер (`useSpinner`) тикает только при `status.active`;
  `ChatMessage`/`Markdown` мемоизированы; `useTranscript` гейтит по mtime; `installExitOnTerminalDeath`
  в `run.tsx` форсит выход на SIGHUP/SIGTERM/EIO-stdout. Правишь рендер-путь — проверь, что idle-CPU
  остался ~0% и что TUI умирает при закрытии pty (рецепты замера — в арх-доке).

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun run check` for the complete local gate: Biome, TypeScript, tests and packed clients.
`bun run lint` checks without editing; `bun run format` formats; `bun run lint:fix` applies safe
Biome fixes. The shared style is two spaces, 100 columns, single quotes and semicolons. Use the
checked-in `biome.json`; do not introduce a parallel formatter or suppress whole rule groups to
hide findings. A passing local gate does not override the release-authority boundary above.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
