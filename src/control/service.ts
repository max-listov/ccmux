import type { ApplicationAdmission } from 'stitchkit/application';
import { implement } from 'stitchkit/server';
import { ChatPrincipalSchema } from '../config/schema.ts';
import type { ExternalStatusPublisher } from '../external/resident-publisher.ts';
import type { MachineConfig } from '../types.ts';
import { controlContract, controlEventsContract } from './contract.ts';
import { subscribeControlNative } from './nativeFeed.ts';
import { type ControlOperationDependencies, createControlOperations } from './operations.ts';
import type { ControlPublisher } from './publisher.ts';

export function controlServices(
  m: MachineConfig,
  publisher: ControlPublisher,
  external: ExternalStatusPublisher,
  upstream?: ApplicationAdmission,
  dependencies: ControlOperationDependencies = {},
) {
  const { operations, mutations, waits, reads } = createControlOperations(
    m,
    publisher,
    external,
    upstream,
    dependencies,
  );
  const service = implement(controlContract, {
    'external.history': ({ input, signal }) => operations.externalHistory(input, signal),
    'external.capabilities': ({ input, signal }) => operations.externalCapabilities(input, signal),
    'message.cancel': ({ input, principal }) =>
      operations.messageCancel(input, ChatPrincipalSchema.parse(principal)),
    'message.operation': ({ input, principal }) =>
      operations.messageOperation(input, ChatPrincipalSchema.parse(principal)),
    'transcript.read': ({ input, signal }) => operations.transcript(input, signal),
    'history.read': ({ input, signal }) => operations.history(input, signal),
    'context.compact': ({ input, signal }) => operations.compact(input, signal),
    'context.operation': ({ input }) => operations.contextOperation(input),
    'session.fork': ({ input, signal }) => operations.fork(input, signal),
    'turn.steer': ({ input, signal, principal }) =>
      operations.steer(input, ChatPrincipalSchema.parse(principal), signal),
    'turn.steering-operation': ({ input, signal, principal }) =>
      operations.steeringOperation(input, ChatPrincipalSchema.parse(principal), signal),
    'selection.read': ({ input, signal }) => operations.selection(input, signal),
    'selection.update': ({ input, signal }) => operations.select(input, signal),
    'attachment.begin': ({ input, signal, principal }) =>
      operations.attachmentBegin(input, ChatPrincipalSchema.parse(principal), signal),
    'attachment.chunk': ({ input, signal, principal }) =>
      operations.attachmentChunk(input, ChatPrincipalSchema.parse(principal), signal),
    'attachment.finalize': ({ input, signal, principal }) =>
      operations.attachmentFinalize(input, ChatPrincipalSchema.parse(principal), signal),
    'attachment.cancel': ({ input, signal, principal }) =>
      operations.attachmentCancel(input, ChatPrincipalSchema.parse(principal), signal),
    'attachment.read': ({ input, signal, principal }) =>
      operations.attachmentRead(input, ChatPrincipalSchema.parse(principal), signal),
    'runtime.list': operations.runtimes,
    'directory.list': ({ input, signal }) => operations.directories(input, signal),
    'session.list': operations.list,
    'external.list': operations.external,
    'session.get': ({ input }) => operations.get(input),
    'session.create': ({ input, signal }) => operations.create(input, signal),
    'session.archive': ({ input, signal }) => operations.archive(input, signal),
    'message.send': ({ input, signal, principal }) =>
      operations.message(input, ChatPrincipalSchema.parse(principal), signal),
    'session.start': ({ input, signal }) => operations.start(input, signal),
    'turn.interrupt': ({ input, signal }) => operations.interrupt(input, signal),
    'native.read': ({ input }) => operations.native(input),
    'command.list': ({ input }) => operations.commands(input),
    'mcp.list': ({ input }) => operations.mcpServers(input),
    'mcp.control': ({ input, signal }) => operations.mcpControl(input, signal),
    'session.rewind': ({ input, signal }) => operations.rewind(input, signal),
    'command.run': ({ input, signal }) => operations.command(input, signal),
    'permission.read': ({ input }) => operations.permissionRead(input),
    'permission.update': ({ input, signal }) => operations.permissionUpdate(input, signal),
    'permission.mode': ({ input, signal }) => operations.permissionMode(input, signal),
    'model.list': ({ input, signal }) => operations.models(input, signal),
    'native.respond': ({ input, signal }) => operations.respond(input, signal),
    'session.wait': ({ input, signal }) => operations.wait(input, signal),
  });
  const events = implement(controlEventsContract, {
    watch: ({ signal }) => publisher.subscribe(signal),
    watchExternal: ({ signal }) => external.subscribe(signal),
    watchNative: ({ input, signal }) =>
      subscribeControlNative(m, input.target, input.cursor, signal),
  });
  return { services: [service, events], service, mutations, waits, reads };
}
