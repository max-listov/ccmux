import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMachine } from "./helpers.ts";
import { ControlPublisher } from "../src/control/publisher.ts";
import { CONTROL_MAX_READERS } from "../src/control/schema.ts";
import { createControlServer } from "../src/control/server.ts";
import { buildControlClient } from "../scripts/build-control-client.ts";
import { VERSION } from "../src/util/version.ts";

test("published control asset discovers IPC without provider binaries and streams offline with no process spawn", async () => {
  const root = mkdtempSync("/tmp/ccmux-control-asset-");
  const m = makeMachine({ stateDir: root, rcPrefix: "host-a" });
  const p = new ControlPublisher(m), owned = createControlServer(m, p);
  try {
    const config = join(root, "machine.json");
    writeFileSync(config, JSON.stringify({ stateDir: root, rcPrefix: m.rcPrefix }));
    await buildControlClient(root);
    const asset = join(root, "control-client.js");
    const hash = new Bun.CryptoHasher("sha256").update(readFileSync(asset)).digest("hex");
    expect(readFileSync(join(root, "control-client.sha256"), "utf8")).toBe(`${hash}  control-client.js\n`);
    const source = `
      import { spyOn } from "bun:test";
      spyOn(Bun,"spawn").mockImplementation(()=>{throw Error("spawn forbidden")});
      spyOn(Bun,"spawnSync").mockImplementation(()=>{throw Error("spawnSync forbidden")});
      spyOn(Bun,"serve").mockImplementation(()=>{throw Error("server forbidden")});
      const api = await import(${JSON.stringify(asset)});
      if(api.CONTROL_CLIENT_VERSION !== ${JSON.stringify(VERSION)}) throw Error("version");
      const client = api.createControlClient();
      try {
        const reads = await Promise.all(Array.from({length:100},()=>client.list()));
        if(!reads.every(r=>r.machine==="host-a"&&r.status==="unavailable")) throw Error("snapshot");
        const external = await Promise.all(Array.from({length:100},()=>client.external()));
        if(!external.every(r=>api.ExternalStatusSnapshotSchema.parse(r).reason==="observation-pending")) throw Error("external snapshot");
        for (const watch of [client.watch, client.watchExternal]) for (let round = 0; round <= ${CONTROL_MAX_READERS}; round++) {
          const abort = new AbortController();
          const stream = await watch.withOptions({signal:abort.signal});
          if (round % 3 !== 0 && (await stream.next()).value.machine!=="host-a") throw Error("baseline");
          if (round % 3 === 2) {
            const pending = stream.next().then(()=>"received",()=>"cancelled");
            abort.abort();
            if(await pending!=="cancelled") throw Error("pending read survived cancellation");
          }
          await stream.return();
        }
      } finally { await client.close(); }
      console.log("control asset OK");
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", source], {
      cwd: root, env: { ...process.env, CCMUX_CONFIG: config, BUN_INSTALL_CACHE_DIR: join(root, "empty-cache"), BUN_CONFIG_REGISTRY: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ out, err, code }).toEqual({ out: "control asset OK\n", err: "", code: 0 });
    for (let i = 0; i < 100 && p.subscribers; i++) await Bun.sleep(10);
    expect(p.subscribers).toBe(0);
    expect(owned.external.subscribers).toBe(0);
  } finally { p.close(); owned.external.close(); await owned.server.shutdown({ gracePeriodMs: 200 }); await owned.observability.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
