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
  // Post-publication verification must consume the downloaded artifact, not rebuild its substitute.
  const suppliedArtifact = process.env.CCMUX_PACKED_CLIENT_ARTIFACT;
  const packed = suppliedArtifact === undefined
    ? await packageControlServiceClient(packageDir)
    : await (async () => {
      const artifact = resolve(suppliedArtifact);
      const bytes = new Uint8Array(await Bun.file(artifact).arrayBuffer());
      return { artifact, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
    })();
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
    `import {z} from 'zod';
    import descriptorFile from '@ccmux/control-service-client/descriptor.json' with {type:'json'};
    import {
      ApiError, ControlServiceDescriptorSchema, ControlNativeStreamFrameSchema, ControlTargetSchema,
      LaunchRecipeMetadataSchema, LaunchRecipeReferenceSchema, ModelSelectionSchema,
      ControlDirectoryResultSchema,
      RuntimeCatalogSchema,
      ccmuxControlServiceComposition, ccmuxControlServiceDescriptor,
      controlServiceEffects, createCcmuxControlServiceClient, createCcmuxNativeStreamProfile,
      encodeControlNativeStreamCursor, readControlNativeStreamCursor,
    } from '@ccmux/control-service-client';
    const identifier = z.string().max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
    const transportDescriptor = z.object({
      service:z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
      revision:z.string().max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
      maxInflight:z.number().int().min(1).max(32),
      operations:z.array(z.object({
        id:identifier,effect:identifier,
        limits:z.object({requestBytes:z.number().int().min(1).max(65536),responseBytes:z.number().int().min(1).max(1048576),timeoutMs:z.number().int().min(1).max(30000)}).strict(),
      }).strict()).min(1).max(64),
    }).strict();
    const {target} = ControlTargetSchema.parse({target:{kind:'managed',source:'ccmux',machine:'host-a',agent:'codex',session:'agent-a',threadId:crypto.randomUUID()}});
    let calls = 0;
    const client = createCcmuxControlServiceClient(async () => {
      calls++;
      return Response.json({v:1,revision:'1',result:{target,archived:true,duplicate:false,stopped:true}});
    });
    const receipt = await client.archive({target});
    if (!receipt.archived || calls !== 1) throw new Error('typed reply failed');
    const launchRecipe = LaunchRecipeReferenceSchema.parse({id:'provider-a',revision:'r1'});
    const recipeMetadata = LaunchRecipeMetadataSchema.parse({
      ...launchRecipe,digest:'a'.repeat(64),capabilities:['external-provider','responses'],collaborationMode:'plan',
    });
    let createPayload = '';
    const creator = createCcmuxControlServiceClient(async (_url, init) => {
      createPayload = typeof init?.body === 'string' ? init.body : '';
      return Response.json({v:1,revision:'1',result:{
        requestId:'11111111-1111-4111-8111-111111111111',target,workspace:'/work',duplicate:false,
        launchRecipe:recipeMetadata,modelSelection:{provider:'openai',model:'model-a'},
      }});
    });
    const modelSelection = ModelSelectionSchema.parse({provider:'openai',model:'model-a'});
    const created = await creator.create({requestId:'11111111-1111-4111-8111-111111111111',name:'agent-a',workspace:'/work',flags:[],launchRecipe,modelSelection});
    if (created.modelSelection?.model !== modelSelection.model || !createPayload.includes('modelSelection'))
      throw new Error('typed model selection failed');
    if (created.launchRecipe?.digest !== recipeMetadata.digest || created.launchRecipe.collaborationMode !== 'plan' ||
      createPayload.includes('fixture-secret') || createPayload.includes('collaborationMode'))
      throw new Error('safe recipe contract failed');
    const nativeTarget = {...target,agent:'opencode'};
    const capabilities = {runtime:'opencode',structured:true,modelCatalog:true,modelSelection:true,approval:true,input:true,nativeStream:true,interrupt:true,resume:true};
    const runtimeClient = createCcmuxControlServiceClient(async (url, init) => {
      if (String(url).endsWith('/runtime.list')) return Response.json({v:1,revision:'1',result:{runtimes:[{runtime:'opencode',availability:'configured',reason:null,capabilities}]}});
      const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      if (payload.runtime !== 'opencode' || payload.modelSelection.provider !== 'external') throw new Error('runtime selection lost');
      return Response.json({v:1,revision:'1',result:{requestId:payload.requestId,target:nativeTarget,workspace:'/work',duplicate:false,
        nativeSession:{runtime:'opencode',id:'ses_native',version:'1.18.20'},driverCapabilities:capabilities,modelSelection:payload.modelSelection}});
    });
    const runtimeCatalog = RuntimeCatalogSchema.parse(await runtimeClient.runtimes({}));
    if (runtimeCatalog.runtimes[0]?.capabilities.structured !== true) throw new Error('runtime capabilities failed');
    const nativeCreated = await runtimeClient.create({requestId:crypto.randomUUID(),runtime:'opencode',name:'agent-a',workspace:'/work',modelSelection:{provider:'external',model:'model-a'}});
    if (nativeCreated.nativeSession?.id !== 'ses_native' || nativeCreated.target.agent !== 'opencode') throw new Error('native identity lost');
    const reader = createCcmuxControlServiceClient(async (url) => {
      const directory = String(url).endsWith('/directory.list');
      return Response.json({v:1,revision:'1',result:directory
        ? {path:'/work',parent:'/',entries:[{name:'repo',kind:'dir',path:'/work/repo'}],nextCursor:null}
        : {source:{kind:'host',machine:'host-a',provider:'openai'},data:[],nextCursor:null}});
    });
    const catalog = await reader.models({});
    if (catalog.target !== undefined || catalog.source.kind !== 'host') throw new Error('host discovery failed');
    const directory = ControlDirectoryResultSchema.parse(await reader.directories({path:'/work'}));
    if (directory.entries[0]?.kind !== 'dir') throw new Error('directory listing failed');
    if (ccmuxControlServiceComposition.descriptor !== ccmuxControlServiceDescriptor ||
        !ControlServiceDescriptorSchema.safeParse(ccmuxControlServiceDescriptor).success) throw new Error('descriptor failed');
    if (JSON.stringify(transportDescriptor.parse(descriptorFile)) !== JSON.stringify(ccmuxControlServiceDescriptor))
      throw new Error('descriptor export/file mismatch');
    for (const operation of ccmuxControlServiceDescriptor.operations)
      if (operation.effect !== controlServiceEffects[operation.id]) throw new Error('effect metadata mismatch');
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
        "--resolveJsonModule",
        "true",
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
