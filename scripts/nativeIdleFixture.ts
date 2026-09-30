import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig, Session } from '../src/types.ts';

/** Provider stand-ins perform no inference; the measured process is the real native owner. */
export function nativeIdleFixture(root: string, m: MachineConfig, s: Session) {
  const sdk = join(root, 'sdk');
  mkdirSync(sdk);
  writeFileSync(
    join(sdk, 'sdk.mjs'),
    `
export function query() {
  let finish;
  const done = new Promise(resolve => finish = resolve);
  return {
    async *[Symbol.asyncIterator]() { await done; },
    async interrupt() { finish(); },
    async supportedModels() { return []; },
    async supportedCommands() { return []; },
    async mcpServerStatus() { return []; }
  };
}`,
  );
  const path = join(root, 'provider');
  writeFileSync(
    path,
    `#!/usr/bin/env bun
if (process.argv[2] === 'resume') await Bun.sleep(6000000);
else {
  const endpoint = process.argv[process.argv.indexOf('--listen') + 1].replace(/^unix:\\/\\//, '');
  const thread = { id: ${JSON.stringify(s.uuid)}, name: null, source: 'cli', status: { type: 'idle' }, canAcceptDirectInput: true };
  Bun.serve({unix: endpoint, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, {status:400}); }, websocket: {message(ws, raw) {
    const request=JSON.parse(String(raw)); if (request.id === undefined) return;
    let result = {};
    switch(request.method) {
      case 'initialize': result={userAgent:'codex/0.147.0'}; break;
      case 'thread/resume': case 'thread/read': result={thread,model:'fixture-model',modelProvider:'openai',reasoningEffort:'low'};break;
      case 'thread/turns/list': result={data:[]};break;
      case 'account/read': result={account:null};break;
      case 'account/rateLimits/read': result={rateLimits:{}};break;
      case 'collaborationMode/list': result={data:[{name:'Default',mode:'default',model:null,reasoning_effort:null}]};break;
    }
    ws.send(JSON.stringify({id:request.id,result}));
  }}});
}
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  mkdirSync(m.codexSessionsDir ?? '', { recursive: true });
  writeFileSync(
    join(m.codexSessionsDir ?? '', `rollout-fixture-${s.uuid}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: s.uuid, cwd: root, originator: 'fixture' } })}\n`,
    { mode: 0o600 },
  );
  return { sdk, path };
}
