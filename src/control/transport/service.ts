import type { ApplicationAdmission } from 'stitchkit/application';
import { implement } from 'stitchkit/server';
import { sameTarget } from '../../chat/identity.ts';
import { ChatPrincipalSchema } from '../../chat/identitySchema.ts';
import {
  applicationAuthorityCapabilities,
  authorizeApplicationMutation,
  openApplicationAuthority,
  requireApplicationAuthority,
  updateApplicationAuthority,
} from '../../delegation/application.ts';
import { delegationRefused } from '../../delegation/resolve.ts';
import type { ExternalStatusPublisher } from '../../external/residentPublisher.ts';
import { peerChatLogAnswer, peerListAnswer } from '../../fleet/peerRead.ts';
import { peerReadContract } from '../../fleet/peerReadContract.ts';
import type { MachineConfig } from '../../types.ts';
import { subscribeControlNative } from '../nativeFeed.ts';
import type { ControlOperationDependencies } from '../operations/context.ts';
import { createControlOperations } from '../operations.ts';
import type { ControlPublisher } from '../publisher.ts';
import { controlContract } from '../schema/contract.ts';
import { controlEventsContract } from '../schema/eventsContract.ts';
import { controlTarget } from '../target.ts';

export function controlServices(
  m: MachineConfig,
  publisher: ControlPublisher,
  external: ExternalStatusPublisher,
  upstream?: ApplicationAdmission,
  dependencies: ControlOperationDependencies = {},
) {
  const { operations, mutations, waits, reads, catalog } = createControlOperations(
    m,
    publisher,
    external,
    upstream,
    dependencies,
  );
  const mutate = <T>(
    principal: unknown,
    target: Parameters<typeof authorizeApplicationMutation>[2],
    run: () => T,
    allowEnded = false,
  ): T => {
    authorizeApplicationMutation(m, ChatPrincipalSchema.parse(principal), target, allowEnded);
    return run();
  };
  const service = implement(controlContract, {
    'daemon.performance': operations.performance,
    'daemon.performance.configure': ({ input, signal }) =>
      operations.performanceConfigure(input, signal),
    'terminal.prompt': ({ input }) => operations.terminalPrompt(input.target),
    'terminal.respond': ({ input, signal }) => operations.terminalRespond(input, signal),
    'usage.read': ({ input, signal }) => operations.usage(input, signal),
    'usage.list': ({ input, signal }) => operations.usageList(input, signal),
    'external.history': ({ input, signal }) => operations.externalHistory(input, signal),
    'external.capabilities': ({ input, signal }) => operations.externalCapabilities(input, signal),
    'message.cancel': ({ input, principal }) =>
      operations.messageCancel(input, ChatPrincipalSchema.parse(principal)),
    'message.operation': ({ input, principal }) =>
      operations.messageOperation(input, ChatPrincipalSchema.parse(principal)),
    'transcript.read': ({ input, signal }) => operations.transcript(input, signal),
    'history.read': ({ input, signal }) => operations.history(input, signal),
    'context.compact': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.compact(input, signal)),
    'context.operation': ({ input }) => operations.contextOperation(input),
    'session.fork': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.fork(input, signal)),
    'turn.steer': ({ input, signal, principal }) =>
      operations.steer(input, ChatPrincipalSchema.parse(principal), signal),
    'turn.steering-operation': ({ input, signal, principal }) =>
      operations.steeringOperation(input, ChatPrincipalSchema.parse(principal), signal),
    'selection.read': ({ input, signal }) => operations.selection(input, signal),
    'selection.update': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.select(input, signal)),
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
    'session.create': ({ input, signal, principal }) => {
      const caller = ChatPrincipalSchema.parse(principal);
      if (
        caller.kind === 'managed' &&
        (input.delegation === undefined ||
          input.delegation.parent.target.kind !== 'managed' ||
          !sameTarget(caller, input.delegation.parent.target))
      )
        delegationRefused('Managed caller must delegate its own authority');
      return operations.create(input, signal, caller);
    },
    'session.archive': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.archive(input, signal), true),
    'message.send': ({ input, signal, principal }) =>
      operations.message(input, ChatPrincipalSchema.parse(principal), signal),
    'delegation.application.capabilities': ({ principal }) =>
      applicationAuthorityCapabilities(m, ChatPrincipalSchema.parse(principal)),
    'delegation.application.open': ({ input, principal }) =>
      openApplicationAuthority(m, ChatPrincipalSchema.parse(principal), input),
    'delegation.application.renew': ({ input, principal }) =>
      updateApplicationAuthority(m, ChatPrincipalSchema.parse(principal), input, false),
    'delegation.application.close': ({ input, principal }) =>
      updateApplicationAuthority(m, ChatPrincipalSchema.parse(principal), input, true),
    'delegation.cancel': ({ input, signal, principal }) => {
      const caller = ChatPrincipalSchema.parse(principal);
      if (
        caller.kind === 'managed' &&
        (input.parent.target.kind !== 'managed' ||
          !sameTarget(caller, input.parent.target) ||
          controlTarget(m, caller).registrationGeneration !== input.parent.registrationGeneration)
      )
        delegationRefused('Caller is not the delegated parent');
      authorizeApplicationMutation(m, caller, input.target, true);
      const rootAuthority = controlTarget(m, input.target).delegation?.applicationAuthority;
      if (rootAuthority !== undefined && caller.kind !== 'managed')
        requireApplicationAuthority(m, caller, rootAuthority, true);
      if (input.parent.target.kind === 'application')
        requireApplicationAuthority(
          m,
          caller,
          { ...input.parent, target: input.parent.target },
          true,
        );
      return operations.cancelDelegation(input, signal);
    },
    'session.idle': ({ input }) => operations.idle(input),
    'session.sleep': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.sleep(input, signal)),
    'session.wake': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.wake(input, signal)),
    'session.start': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.start(input, signal)),
    'turn.interrupt': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.interrupt(input, signal)),
    'native.read': ({ input }) => operations.native(input),
    'command.list': ({ input }) => operations.commands(input),
    'mcp.list': ({ input }) => operations.mcpServers(input),
    'mcp.control': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.mcpControl(input, signal)),
    'session.rewind': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.rewind(input, signal)),
    'command.run': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.command(input, signal)),
    'permission.read': ({ input }) => operations.permissionRead(input),
    'permission.update': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.permissionUpdate(input, signal)),
    'permission.mode': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.permissionMode(input, signal)),
    'model.list': ({ input, signal }) => operations.models(input, signal),
    'native.respond': ({ input, signal, principal }) =>
      mutate(principal, input.target, () => operations.respond(input, signal)),
    'session.wait': ({ input, signal }) => operations.wait(input, signal),
  });
  const events = implement(controlEventsContract, {
    watch: ({ signal }) => publisher.subscribe(signal),
    watchExternal: ({ signal }) => external.subscribe(signal),
    watchNative: ({ input, signal }) =>
      subscribeControlNative(m, input.target, input.cursor, signal),
  });
  // A fleet reader on another machine, relayed by `ccmux _peer-read`: answered here, where the
  // caches that make building the rows cheap are warm.
  const measure = dependencies.measure ?? (<T>(_name: string, run: () => T) => run());
  const peerRead = implement(peerReadContract, {
    list: ({ input }) =>
      measure('control/peer-list', async () =>
        peerListAnswer(m, input.known, await dependencies.peerRows?.()),
      ),
    'chat-log': ({ input }) =>
      measure('control/peer-chat-log', () => peerChatLogAnswer(m, input.limit, input.known)),
  });
  return { services: [service, events, peerRead], service, mutations, waits, reads, catalog };
}
