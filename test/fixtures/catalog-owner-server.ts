#!/usr/bin/env bun
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.env.CODEX_HOME;
const address = process.argv[process.argv.indexOf('--listen') + 1];
if (!root || !address?.startsWith('unix://'))
  throw new Error('Catalog target fixture misconfigured');
/**
 * A file the test reads appears whole or not at all. `writeFileSync` creates the name before it
 * writes the bytes, and a test that waits for the name reads an empty pid there: under a loaded
 * machine that window is long enough to see (`Number('')` is 0, which the process reader refuses).
 */
const publish = (name: string, text: string) => {
  const path = join(root, name);
  writeFileSync(`${path}.partial`, text);
  renameSync(`${path}.partial`, path);
};
publish('target.pid', String(process.pid));
publish('guard.pid', String(process.ppid));
publish('runtime.directory', dirname(address.slice(7)));
const member = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
  env: process.env,
  stdout: 'ignore',
  stderr: 'ignore',
});
publish('member.pid', String(member.pid));
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
      else if (request.method === 'initialized') publish('initialized', 'ready');
      else if (request.method === 'config/read')
        ws.send(
          JSON.stringify({ id: request.id, result: { config: { model_provider: 'openai' } } }),
        );
      else if (request.method === 'model/list') publish('rpc', 'pending');
    },
  },
});
process.on('SIGTERM', () => {
  server.stop(true);
  process.exit(0);
});
