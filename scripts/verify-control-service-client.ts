#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageControlServiceClient } from "./package-control-service.ts";

const directory = mkdtempSync("/tmp/ccmux-packed-service-");
const packageDir = join(directory, "package");
const consumer = join(directory, "consumer");
const results: Array<{ gate: string; exitCode: number | null; diagnostics: string[] }> = [];

function run(gate: string, command: string, args: string[]) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: consumer,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  results.push({
    gate,
    exitCode: result.exitCode,
    diagnostics: output
      .split("\n")
      .filter((line) => /error TS\d+|Error:/.test(line))
      .slice(0, 50),
  });
  return result.exitCode === 0;
}

try {
  const packed = await packageControlServiceClient(packageDir);
  mkdirSync(consumer, { recursive: true });
  await Bun.write(
    join(consumer, "package.json"),
    `${JSON.stringify({
      name: "ccmux-packed-client-gate",
      private: true,
      type: "module",
      dependencies: { "@ccmux/control-service-client": `file:${resolve(packed.artifact)}` },
      devDependencies: { typescript: "7.0.2" },
    })}\n`,
  );
  await Bun.write(
    join(consumer, "check.ts"),
    `import {
      ApiError, ControlServiceDescriptorSchema, ControlNativeStreamFrameSchema, ControlTargetSchema,
      ccmuxControlServiceComposition, ccmuxControlServiceDescriptor,
      createCcmuxControlServiceClient, createCcmuxNativeStreamProfile,
      encodeControlNativeStreamCursor, readControlNativeStreamCursor,
    } from '@ccmux/control-service-client';
    const {target} = ControlTargetSchema.parse({target:{kind:'managed',source:'ccmux',machine:'host-a',agent:'codex',session:'agent-a',threadId:crypto.randomUUID()}});
    let calls = 0;
    const client = createCcmuxControlServiceClient(async () => {
      calls++;
      return Response.json({v:1,revision:'1',result:{target,archived:true,duplicate:false,stopped:true}});
    });
    const receipt = await client.archive({target});
    if (!receipt.archived || calls !== 1) throw new Error('typed reply failed');
    if (ccmuxControlServiceComposition.descriptor !== ccmuxControlServiceDescriptor ||
        !ControlServiceDescriptorSchema.safeParse(ccmuxControlServiceDescriptor).success) throw new Error('descriptor failed');
    const profile = createCcmuxNativeStreamProfile('/opt/bin/ccmux');
    if (profile.argv[0] !== 'control-native-stream' || profile.callerArgs.mode !== 'none') throw new Error('profile failed');
    const cursor = encodeControlNativeStreamCursor(target,{generation:crypto.randomUUID(),sequence:7});
    if (readControlNativeStreamCursor(cursor,target)?.sequence !== 7) throw new Error('cursor failed');
    ControlNativeStreamFrameSchema.parse({channel:'data',data:'{}',cursor});
    class DeliveryFailure extends Error { delivery = 'unknown'; }
    const cause = new DeliveryFailure();
    let attempts = 0;
    const failed = createCcmuxControlServiceClient(async () => { attempts++; throw cause; });
    try { await failed.archive({target}); throw new Error('unexpected success'); }
    catch (error) {
      if (!(error instanceof ApiError) || error.cause !== cause || attempts !== 1) throw new Error('delivery uncertainty lost or replayed');
    }
    `,
  );
  if (run("install", process.execPath, ["install", "--ignore-scripts"])) {
    run("bun-runtime", process.execPath, ["check.ts"]);
    run("node-runtime", "node", ["--experimental-strip-types", "check.ts"]);
    for (const resolution of ["nodenext", "bundler"]) {
      run(`types-${resolution}`, process.execPath, [
        "./node_modules/typescript/bin/tsc",
        "--noEmit",
        "--skipLibCheck",
        "false",
        "--module",
        resolution === "nodenext" ? "nodenext" : "esnext",
        "--moduleResolution",
        resolution,
        "--target",
        "es2022",
        "--lib",
        "es2022,dom",
        "check.ts",
      ]);
    }
  }
  console.log(JSON.stringify({ outsideCheckout: true, artifact: packed, results }));
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
