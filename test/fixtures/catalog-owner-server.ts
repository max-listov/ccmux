#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.env.CODEX_HOME;
const address = process.argv[process.argv.indexOf('--listen') + 1];
if (!root || !address?.startsWith('unix://'))
  throw new Error('Catalog target fixture misconfigured');
writeFileSync(join(root, 'target.pid'), String(process.pid));
writeFileSync(join(root, 'guard.pid'), String(process.ppid));
writeFileSync(join(root, 'runtime.directory'), dirname(address.slice(7)));
const member = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
  env: process.env,
  stdout: 'ignore',
  stderr: 'ignore',
});
writeFileSync(join(root, 'member.pid'), String(member.pid));
if (process.argv.includes('before-listen')) await new Promise(() => {});
const server = Bun.serve({
  unix: address.slice(7),
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response(null, { status: 400 });
  },
  websocket: {
    message(ws, raw) {
      const request = JSON.parse(String(raw));
      if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, result: {} }));
      else if (request.method === 'initialized') writeFileSync(join(root, 'initialized'), 'ready');
      else if (request.method === 'config/read')
        ws.send(
          JSON.stringify({ id: request.id, result: { config: { model_provider: 'openai' } } }),
        );
      else if (request.method === 'model/list') writeFileSync(join(root, 'rpc'), 'pending');
    },
  },
});
process.on('SIGTERM', () => {
  server.stop(true);
  process.exit(0);
});
