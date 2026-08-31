#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packageControlServiceClient } from './package-control-service.ts';

const directory = mkdtempSync('/tmp/ccmux-packed-service-');
const packageDir = join(directory, 'package');
const consumer = join(directory, 'consumer');
const results: Array<{ gate: string; exitCode: number | null; diagnostics: string[] }> = [];

function run(gate: string, command: string, args: string[]) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: consumer,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  results.push({
    gate,
    exitCode: result.exitCode,
    diagnostics: output
      .split('\n')
      .filter((line) => /error TS\d+|Error:/.test(line))
      .slice(0, 50),
  });
  return result.exitCode === 0;
}

try {
  // Post-publication verification must consume the downloaded artifact, not rebuild its substitute.
  const suppliedArtifact = process.env.CCMUX_PACKED_CLIENT_ARTIFACT;
  const packed =
    suppliedArtifact === undefined
      ? await packageControlServiceClient(packageDir)
      : await (async () => {
          const artifact = resolve(suppliedArtifact);
          const bytes = new Uint8Array(await Bun.file(artifact).arrayBuffer());
          return {
            artifact,
            bytes: bytes.byteLength,
            sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
          };
        })();
  mkdirSync(consumer, { recursive: true });
  await Bun.write(
    join(consumer, 'package.json'),
    `${JSON.stringify({
      name: 'ccmux-packed-client-gate',
      private: true,
      type: 'module',
      dependencies: { '@ccmux/control-service-client': `file:${resolve(packed.artifact)}` },
      devDependencies: { typescript: '7.0.2' },
    })}\n`,
  );
  await Bun.write(
    join(consumer, 'check.ts'),
    `import {z} from 'zod';
    import descriptorFile from '@ccmux/control-service-client/descriptor.json' with {type:'json'};
    import {
      ApiError, ControlServiceDescriptorSchema, ControlNativeStreamFrameSchema, ControlTargetSchema,
      ExternalContentReadSchema, ExternalContentResultSchema,
      LaunchRecipeMetadataSchema, LaunchRecipeReferenceSchema, ModelSelectionSchema,
      ControlDirectoryResultSchema, ControlModelCatalogSchema, ControlModelsReadSchema,
      RuntimeCatalogSchema, CCMUX_CONTROL_SERVICE_REVISION, AttachmentReferenceSchema, SelectionResultSchema,
      NativeSelectionEvidenceSchema, ControlHistoryResultSchema, ControlContextOperationResultSchema,
      SteeringReceiptSchema, NativeForkRequestSchema, MessageOperationResultSchema, ToolObservationSchema, ContentRecordSchema, PermissionScopeSchema, ControlInterruptSchema,
      MessageAttributionSchema, MessageOriginSchema, NotificationAudienceSchema, ControlMessageSchema,
      ChatPrincipalSchema, ChatTargetSchema, LogRowSchema, LogPayloadSchema, LogFrameSchema,
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
    const registrationGeneration = crypto.randomUUID();
    const externalTarget = {provider:'codex',machine:'host-a',threadId:crypto.randomUUID()};
    const externalRead = ExternalContentReadSchema.parse({target:externalTarget});
    const externalPage = ExternalContentResultSchema.parse({target:externalTarget,outcome:'available',revision:'a'.repeat(64),observedAt:new Date().toISOString(),entries:[{id:'123',role:'assistant',text:'authored',truncated:false}],nextCursor:null,truncated:false,omittedRecords:0});
    const external = createCcmuxControlServiceClient(async (url) => {
      if (!String(url).endsWith('/external.history')) throw new Error('external history route lost');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:externalPage});
    });
    if ((await external.externalHistory(externalRead)).entries[0]?.text !== 'authored') throw new Error('external content lost');
    const operationInput = {target,registrationGeneration,messageId:crypto.randomUUID()};
    const operationResult = MessageOperationResultSchema.parse({...operationInput,outcome:'available',evidence:{state:'completed',nativeSession:{runtime:'codex',id:target.threadId},turnId:'turn-exact',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10000).toISOString()}});
    const operations = createCcmuxControlServiceClient(async (url) => {
      if (!String(url).endsWith('/message.operation')) throw new Error('message operation route lost');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:operationResult});
    });
    if ((await operations.messageOperation(operationInput)).evidence?.turnId !== 'turn-exact') throw new Error('exact message correlation lost');
    const attribution = MessageAttributionSchema.parse({applicationId:'sample-app',channelId:'chat',actor:'human'});
    const origin = MessageOriginSchema.parse({ingress:'service',actor:'human',assurance:'application-attested',application:{...attribution,revision:'r1',digest:'b'.repeat(64)}});
    const notification = NotificationAudienceSchema.parse('conversation');
    const sender = ChatPrincipalSchema.parse({kind:'service',source:'ccmux',machine:'host-a',transport:'declared-service'});
    const chatTarget = ChatTargetSchema.parse(target);
    const logRow = LogRowSchema.parse({messageId:operationInput.messageId,sender,target:chatTarget,origin,notification,registrationGeneration,
      machine:'host-a',ts:new Date().toISOString(),kind:'chat',from:'display',to:'display',body:'sample input'});
    const logPayload = LogPayloadSchema.parse({machines:[{machine:'host-a'}],rows:[logRow]});
    const logFrame = LogFrameSchema.parse({kind:'row',cursor:'2.1.0',row:logPayload.rows[0]});
    if (logFrame.kind !== 'row' || logFrame.row.messageId !== operationInput.messageId || logFrame.row.origin.assurance !== 'application-attested')
      throw new Error('Typed feed identity lost');
    const {origin:omittedOrigin,...incompleteRow} = logRow;
    if (LogRowSchema.safeParse(incompleteRow).success) throw new Error('Missing feed origin accepted');
    const messageInput = ControlMessageSchema.parse({...operationInput,origin:attribution,body:'sample input'});
    const messenger = createCcmuxControlServiceClient(async (url, init) => {
      const request = ControlMessageSchema.parse(JSON.parse(String(init?.body)));
      if (!String(url).endsWith('/message.send') || request.origin?.actor !== 'human' || request.registrationGeneration !== registrationGeneration)
        throw new Error('Application origin input lost');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{messageId:request.messageId,accepted:true,duplicate:false,turnOptions:null,registrationGeneration,origin,notification}});
    });
    const messageReceipt = await messenger.message(messageInput);
    if (messageReceipt.origin.assurance !== 'application-attested' || messageReceipt.notification !== 'conversation' || messageReceipt.registrationGeneration !== registrationGeneration)
      throw new Error('Accepted origin receipt lost');
    let calls = 0;
    const client = createCcmuxControlServiceClient(async () => {
      calls++;
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{target,archived:true,duplicate:false,stopped:true}});
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
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{
        requestId:'11111111-1111-4111-8111-111111111111',target,workspace:'/work',registrationGeneration,duplicate:false,
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
    const capabilities = {runtime:'opencode',structured:true,modelCatalog:true,modelSelection:true,approval:true,input:true,nativeStream:true,interrupt:true,resume:true,
      imageInput:true,selectionDefaults:true,turnOptions:true,turnSteering:false,history:true,fork:true,compaction:true,rollback:false,applicationPolicy:true};
    const runtimeClient = createCcmuxControlServiceClient(async (url, init) => {
      if (String(url).endsWith('/runtime.list')) return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{runtimes:[{runtime:'opencode',availability:'configured',reason:null,capabilities}]}});
      const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      if (payload.runtime !== 'opencode' || payload.modelSelection.provider !== 'external') throw new Error('runtime selection lost');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{requestId:payload.requestId,target:nativeTarget,workspace:'/work',registrationGeneration,duplicate:false,
        nativeSession:{runtime:'opencode',id:'ses_native',version:'1.18.20'},driverCapabilities:capabilities,modelSelection:payload.modelSelection}});
    });
    const runtimeCatalog = RuntimeCatalogSchema.parse(await runtimeClient.runtimes({}));
    if (runtimeCatalog.runtimes[0]?.capabilities.structured !== true) throw new Error('runtime capabilities failed');
    const nativeCreated = await runtimeClient.create({requestId:crypto.randomUUID(),runtime:'opencode',name:'agent-a',workspace:'/work',modelSelection:{provider:'external',model:'model-a'}});
    if (nativeCreated.nativeSession?.id !== 'ses_native' || nativeCreated.target.agent !== 'opencode') throw new Error('native identity lost');
    const reference = AttachmentReferenceSchema.parse({id:crypto.randomUUID(),digest:'b'.repeat(64),mediaType:'image/png',bytes:3,width:1,height:1});
    const selectionResult = SelectionResultSchema.parse({protocol:1,registrationGeneration,
      current:{revision:1,options:{runtime:'codex',model:{provider:'openai',model:'model-a'},mode:'plan'}}});
    const uploadClient = createCcmuxControlServiceClient(async (url, init) => {
      const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const result = String(url).endsWith('/selection.read') || String(url).endsWith('/selection.update') ? selectionResult
        : String(url).endsWith('/attachment.finalize') ? reference
          : String(url).endsWith('/attachment.read') ? {reference,offset:0,data:'YWJj',nextOffset:3,complete:true}
            : String(url).endsWith('/attachment.cancel') ? {uploadId:reference.id,cancelled:true}
              : {uploadId:reference.id,receivedBytes:String(url).endsWith('/attachment.chunk') ? 3 : 0,totalBytes:3,phase:'uploading',expiresAt:new Date().toISOString()};
      if (payload.target.threadId !== target.threadId) throw new Error('upload target lost');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result});
    });
    await uploadClient.selection({target,registrationGeneration});
    await uploadClient.select({target,registrationGeneration,operationId:crypto.randomUUID(),expectedRevision:0,
      options:{runtime:'codex',model:{provider:'openai',model:'model-a'},mode:'plan'}});
    await uploadClient.attachmentBegin({target,uploadId:reference.id,mediaType:'image/png',totalBytes:3,digest:reference.digest});
    await uploadClient.attachmentChunk({target,uploadId:reference.id,offset:0,data:'YWJj'});
    const finalized = await uploadClient.attachmentFinalize({target,uploadId:reference.id});
    const preview = await uploadClient.attachmentRead({target,reference:finalized,offset:0});
    if (preview.data !== 'YWJj' || !preview.complete) throw new Error('attachment preview contract failed');
    await uploadClient.attachmentCancel({target,uploadId:reference.id});
    const generation = crypto.randomUUID(), operationId = crypto.randomUUID();
    const permissionScope = PermissionScopeSchema.parse({operation:'external_directory',kind:'filesystem-patterns',requested:{patterns:['/work/narrow/*'],omitted:0,complete:true},session:{patterns:['/work/*'],omitted:0,complete:true}});
    if (permissionScope.requested.patterns[0] === permissionScope.session.patterns[0]) throw new Error('Approval scopes conflated');
    const interruptInput = ControlInterruptSchema.parse({target,generation,turnId:'turn-a'});
    const canceller = createCcmuxControlServiceClient(async (url, init) => {
      const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      if (!String(url).endsWith('/turn.interrupt') || payload.generation !== generation || payload.turnId !== 'turn-a') throw new Error('Cancellation identity lost');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{target,accepted:true}});
    });
    await canceller.interrupt(interruptInput);
    NativeSelectionEvidenceSchema.parse({model:modelSelection,options:selectionResult.current.options,source:'settings',turnId:null});
    const tool = ToolObservationSchema.parse({callId:'native-call',name:'bash',lifecycle:'completed',outcome:'failed',exitCode:7});
    const toolRecord = ContentRecordSchema.parse({sequence:1,at:new Date().toISOString(),kind:'tool',operation:'lifecycle',turnId:'turn-a',itemId:'part-a',revision:1,offsetBytes:0,prefixKnown:true,text:null,totalBytes:0,omittedBytes:0,complete:true,status:'completed',tool});
    if (toolRecord.tool?.outcome !== 'failed' || !toolRecord.complete) throw new Error('Tool lifecycle/outcome conflated');
    const historyResult = ControlHistoryResultSchema.parse({target,registrationGeneration,runtime:'codex',nativeId:target.threadId,
      revision:1,entries:[{turnId:'turn-a',itemId:'part-a',kind:'tool',text:null,omittedBytes:0,images:[],omittedImages:0,status:'completed',tool}],nextCursor:null,completeness:'complete',omittedItems:0,omittedBytes:0});
    const contextResult = ControlContextOperationResultSchema.parse({target,registrationGeneration,operation:{operationId,generation,
      state:'queued',revision:1,createdAt:1,updatedAt:1}});
    const steeringResult = SteeringReceiptSchema.parse({protocol:1,operationId,target,registrationGeneration,generation,
      turnId:'turn-a',clientUserMessageId:'steer:'+operationId,state:'submitted',observedAt:new Date().toISOString()});
    const contextClient = createCcmuxControlServiceClient(async (url) => {
      const result = String(url).endsWith('/history.read') ? historyResult
        : String(url).endsWith('/turn.steer') ? steeringResult
          : String(url).endsWith('/turn.steering-operation') ? {operation:steeringResult} : contextResult;
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result});
    });
    if ((await contextClient.history({target,registrationGeneration,limit:8})).nativeId !== target.threadId) throw new Error('history contract failed');
    if ((await contextClient.history({target,registrationGeneration,limit:8})).entries[0]?.tool?.exitCode !== 7) throw new Error('Native tool outcome lost by client');
    await contextClient.compact({target,registrationGeneration,generation,operationId});
    await contextClient.contextOperation({target,registrationGeneration,operationId});
    await contextClient.steer({target,registrationGeneration,generation,operationId,expectedTurnId:'turn-a',body:'continue'});
    await contextClient.steeringOperation({target,registrationGeneration,operationId});
    const forkInput = NativeForkRequestSchema.parse({target,registrationGeneration,generation,requestId:crypto.randomUUID(),name:'fork-a'});
    if (typeof contextClient.fork !== 'function' || forkInput.target.threadId !== target.threadId) throw new Error('fork client missing');
    const reader = createCcmuxControlServiceClient(async (url) => {
      const directory = String(url).endsWith('/directory.list');
      return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:directory
        ? {path:'/work',parent:'/',entries:[{name:'repo',kind:'dir',path:'/work/repo'}],nextCursor:null}
        : {source:{kind:'host',runtime:'codex',machine:'host-a',provider:'openai'},data:[],nextCursor:null}});
    });
    const catalog = await reader.models({});
    if (catalog.target !== undefined || catalog.source.kind !== 'host') throw new Error('host discovery failed');
    for (const runtime of ['codex','opencode','custom']) {
      for (const kind of ['host','session']) {
        const input = ControlModelsReadSchema.parse({runtime,...(kind === 'session' ? {target:{...target,agent:runtime}} : {}),limit:1});
        const source = {kind,runtime,machine:'host-a',provider:'openai'};
        const pages = createCcmuxControlServiceClient(async (url, init) => {
          const payload = ControlModelsReadSchema.parse(JSON.parse(String(init?.body)));
          if (!String(url).endsWith('/model.list') || payload.runtime !== runtime || payload.target?.agent !== input.target?.agent) throw new Error('catalog selector lost');
          return Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:{
            ...(input.target ? {target:input.target} : {}),source,data:[],nextCursor:payload.cursor === null ? 'page-2' : null}});
        });
        const first = await pages.models(input);
        const second = await pages.models({...input,cursor:first.nextCursor});
        const knownRuntime: 'claude'|'codex'|'opencode'|'custom' = first.source.runtime;
        if (knownRuntime !== runtime || second.source.runtime !== runtime || JSON.stringify(first.source) !== JSON.stringify(second.source)) throw new Error('catalog runtime identity lost');
      }
    }
    for (const source of [
      {kind:'host',machine:'host-a',provider:'openai'},
      {kind:'session',machine:'host-a',provider:'openai',runtime:'opencode'},
    ]) {
      const malformed = {source,...(source.kind === 'session' ? {target} : {}),data:[],nextCursor:null};
      if (ControlModelCatalogSchema.safeParse(malformed).success) throw new Error('catalog omission or mismatch accepted');
      const invalid = createCcmuxControlServiceClient(async () => Response.json({v:1,revision:CCMUX_CONTROL_SERVICE_REVISION,result:malformed}));
      let refused = false;
      try { await invalid.models({runtime:'codex'}); } catch (error) { if (!(error instanceof ApiError)) throw error; refused = true; }
      if (!refused) throw new Error('packed client accepted invalid catalog');
    }
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
  await Bun.write(
    join(consumer, 'browser.ts'),
    `
    import {LogRowSchema,LogPayloadSchema,LogFrameSchema,ChatPrincipalSchema,ChatTargetSchema} from '@ccmux/control-service-client';
    export const schemas = {LogRowSchema,LogPayloadSchema,LogFrameSchema,ChatPrincipalSchema,ChatTargetSchema};
  `,
  );
  if (run('install', process.execPath, ['install', '--ignore-scripts'])) {
    run('browser-bundle', process.execPath, [
      'build',
      '--target=browser',
      '--outdir=browser',
      'browser.ts',
    ]);
    run('bun-runtime', process.execPath, ['check.ts']);
    run('node-runtime', 'node', ['--experimental-strip-types', 'check.ts']);
    for (const resolution of ['nodenext', 'bundler']) {
      run(`types-${resolution}`, process.execPath, [
        './node_modules/typescript/bin/tsc',
        '--noEmit',
        '--skipLibCheck',
        'false',
        '--module',
        resolution === 'nodenext' ? 'nodenext' : 'esnext',
        '--moduleResolution',
        resolution,
        '--target',
        'es2022',
        '--resolveJsonModule',
        'true',
        '--lib',
        'es2022,dom',
        'check.ts',
      ]);
    }
  }
  console.log(JSON.stringify({ outsideCheckout: true, artifact: packed, results }));
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
