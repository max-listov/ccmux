#!/usr/bin/env bun
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.CODEX_HOME;
const address = process.argv[process.argv.indexOf('--listen') + 1];
if (!home || !address?.startsWith('unix://')) throw new Error('fixture configuration missing');
writeFileSync(join(home, 'fixture.pid'), String(process.pid));
// `late-listen` in the home: the socket path exists as a real Unix socket inode before anything
// accepts on it. A real server's path appears at bind() and listen() follows; a loaded machine can
// hold that window open, and a reader that takes the path for readiness is refused with
// ECONNREFUSED inside it. Exiting right after bind() leaves a real S_IFSOCK inode with no listener
// so `stitchkit/agent-executor/codex`'s socket-type check passes and its retry loop is exercised.
if (existsSync(join(home, 'late-listen'))) {
  const sockPath = address.slice(7);
  Bun.spawnSync([
    process.execPath,
    '-e',
    'Bun.listen({ unix: process.argv[1], socket: { data() {} } }); process.exit(0);',
    sockPath,
  ]);
  await Bun.sleep(300);
  unlinkSync(sockPath);
}
const server = Bun.serve({
  unix: address.slice(7),
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response(null, { status: 400 });
  },
  websocket: {
    message(ws, raw) {
      const request = JSON.parse(String(raw));
      appendFileSync(join(home, 'requests.jsonl'), `${JSON.stringify(request)}\n`);
      if (request.id === undefined) return;
      if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, result: {} }));
      else if (request.method === 'config/read')
        ws.send(
          JSON.stringify({ id: request.id, result: { config: { model_provider: 'openai' } } }),
        );
      else if (request.method === 'model/list' && request.params.cursor !== 'hang')
        ws.send(
          JSON.stringify({
            id: request.id,
            result: {
              data: [
                {
                  id: 'preset-a',
                  model: 'model-a',
                  displayName: 'A',
                  description: '',
                  hidden: false,
                  isDefault: true,
                  inputModalities: ['text'],
                  serviceTiers: [],
                },
              ],
              nextCursor: null,
            },
          }),
        );
      else if (request.method !== 'model/list')
        ws.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: 'Only metadata reads are supported' },
          }),
        );
    },
  },
});
process.on('SIGTERM', () => {
  server.stop(true);
  process.exit(0);
});
