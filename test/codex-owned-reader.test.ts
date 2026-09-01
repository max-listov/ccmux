import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCodexRuntimeReader } from '../scripts/build-codex-runtime-reader.ts';
import { OwnedCodexProjection } from '../src/agent/codex/ownedProjection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/ownedStatus.ts';
import { VERSION } from '../src/util/version.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('released ESM reader works offline, coalesces 100 callers and never starts CLI/RPC processes', async () => {
  const root = mkdtempSync('/tmp/ccmux-codex-reader-test-');
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
  const s = makeSession({ agent: 'codex', runtime: 'app-server' });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify({ stateDir: root, rcPrefix: m.rcPrefix }), { mode: 0o600 });
  const p = new OwnedCodexProjection(m, s, process.pid);
  p.reconcile({ type: 'idle' }, 0);
  await new OwnedCodexStatusWriter(m, s.name).write(p.snapshot());
  await buildCodexRuntimeReader(root);
  const asset = join(root, 'codex-runtime-reader.js');
  const hash = new Bun.CryptoHasher('sha256').update(readFileSync(asset)).digest('hex');
  expect(readFileSync(join(root, 'codex-runtime-reader.sha256'), 'utf8')).toBe(
    `${hash}  codex-runtime-reader.js\n`,
  );
  const source = `
    import { spyOn, mock } from "bun:test";
    import * as fs from "node:fs/promises";
    import net from "node:net";
    const spawn = spyOn(Bun,"spawn").mockImplementation(()=>{throw Error("forbidden spawn")});
    const sync = spyOn(Bun,"spawnSync").mockImplementation(()=>{throw Error("forbidden spawnSync")});
    const rpc = spyOn(net,"createConnection").mockImplementation(()=>{throw Error("forbidden RPC")});
    const originalOpen = fs.open; let opens = 0, beforeOpen = async()=>{};
    mock.module("node:fs/promises",()=>({...fs,open:async(...args)=>{opens++;await beforeOpen(...args);return originalOpen(...args)}}));
    const api = await import(${JSON.stringify(asset)});
    if(api.CODEX_RUNTIME_READER_VERSION !== ${JSON.stringify(VERSION)}) throw Error("version");
    const options = {session:${JSON.stringify(s.name)},threadId:${JSON.stringify(s.uuid)},timeoutMs:1000};
    // This step is about COALESCING and residency: how many file opens a hundred callers cause, and
    // that no process starts. It is not about how fast the machine is — and the reader's own cap of
    // one second is not raisable, so on a busy box the batch came back "deadline" and the suite
    // failed for something the case does not test. A deadline is this reader's legitimate answer,
    // so the batch is taken again rather than counted as a defect; anything else still fails, and
    // the open count is measured per batch so a retry cannot hide a reader that stopped coalescing.
    // The deadline behaviour itself is still proven below, at two milliseconds against a read
    // deliberately slowed to twenty.
    const batch = async () => { opens = 0; return Promise.all(Array.from({length:100},()=>api.readCodexRuntime(options))); };
    let reads = await batch();
    if(reads.some(r=>r.reason==="deadline")) reads = await batch();
    if(!reads.every(r=>r.status==="live" && r.snapshot.threadId===options.threadId)) throw Error(JSON.stringify(reads.find(r=>r.status!=="live")));
    if(opens !== 3) throw Error("not coalesced: "+opens);
    if(spawn.mock.calls.length || sync.mock.calls.length || rpc.mock.calls.length) throw Error("not resident");
    const abort = new AbortController(); abort.abort();
    if((await api.readCodexRuntime({...options,signal:abort.signal})).reason !== "cancelled") throw Error("cancel");
    if((await api.readCodexRuntime({...options,threadId:crypto.randomUUID()})).reason !== "identity-mismatch") throw Error("identity");
    if((await api.readCodexRuntime({...options,path:"/tmp/anything"})).reason !== "invalid") throw Error("caller path accepted");
    const denied = spyOn(process,"kill").mockImplementation(()=>{throw Object.assign(Error("denied"),{code:"EPERM"})});
    if((await api.readCodexRuntime(options)).status !== "live") throw Error("sandbox read failed");
    denied.mockRestore();
    beforeOpen = async()=>{await Bun.sleep(20)};
    if((await api.readCodexRuntime({...options,timeoutMs:2})).reason !== "deadline") throw Error("deadline");
    const cancel = new AbortController();
    const cancelled = api.readCodexRuntime({...options,signal:cancel.signal});
    const survivor = api.readCodexRuntime(options); cancel.abort();
    if((await cancelled).reason !== "cancelled" || (await survivor).status !== "live") throw Error("cancellation affected peer");
    const saturated = await Promise.all(Array.from({length:129},()=>api.readCodexRuntime(options)));
    if(saturated.filter(r=>r.reason==="busy").length !== 1 || saturated.filter(r=>r.status==="live").length !== 128) throw Error("unbounded waiters");
    let migrated = false;
    beforeOpen = async(path)=>{
      if(!migrated && String(path).endsWith(".json") && String(path)!==process.env.CCMUX_CONFIG){
        migrated = true;
        await fs.writeFile(process.env.CCMUX_CONFIG,JSON.stringify({stateDir:${JSON.stringify(join(root, 'missing'))},rcPrefix:${JSON.stringify(m.rcPrefix)}}));
      }
    };
    if((await api.readCodexRuntime(options)).reason !== "config-changed") throw Error("root migration raced into live");
    beforeOpen = async()=>{};
    if((await api.readCodexRuntime(options)).reason !== "missing") throw Error("fell back to old root");
    console.log("native reader OK");
  `;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--no-install', '--eval', source], {
    cwd: root,
    env: { ...process.env, CCMUX_CONFIG: config, CCMUX_RC_PREFIX: m.rcPrefix },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ out, err, code }).toEqual({ out: 'native reader OK\n', err: '', code: 0 });
});
