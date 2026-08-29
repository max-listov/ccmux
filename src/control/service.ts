import type { ApplicationAdmission } from "stitchkit/application";
import { implement } from "stitchkit/server";
import { ChatPrincipalSchema } from "../config/schema.ts";
import type { MachineConfig } from "../types.ts";
import { controlContract, controlEventsContract } from "./contract.ts";
import type { ControlPublisher } from "./publisher.ts";
import type { ExternalStatusPublisher } from "../external/resident-publisher.ts";
import { subscribeControlNative } from "./nativeFeed.ts";
import { createControlOperations, type ControlOperationDependencies } from "./operations.ts";
import { createControlServiceIngress } from "./serviceIngress.ts";

export function controlServices(m: MachineConfig, publisher: ControlPublisher, external: ExternalStatusPublisher,
  upstream?: ApplicationAdmission, dependencies: ControlOperationDependencies = {}) {
  const { operations, mutations, waits } = createControlOperations(m, publisher, external, upstream, dependencies);
  const service = implement(controlContract, {
    list: operations.list,
    external: operations.external,
    get: ({ input }) => operations.get(input),
    create: ({ input, signal }) => operations.create(input, signal),
    archive: ({ input, signal }) => operations.archive(input, signal),
    message: ({ input, signal, principal }) => operations.message(input, ChatPrincipalSchema.parse(principal), signal),
    start: ({ input, signal }) => operations.start(input, signal),
    interrupt: ({ input, signal }) => operations.interrupt(input, signal),
    native: ({ input }) => operations.native(input),
    respond: ({ input, signal }) => operations.respond(input, signal),
    wait: ({ input, signal }) => operations.wait(input, signal),
  });
  const events = implement(controlEventsContract, {
    watch: ({ signal }) => publisher.subscribe(signal),
    watchExternal: ({ signal }) => external.subscribe(signal),
    watchNative: ({ input, signal }) => subscribeControlNative(m, publisher, input.target, input.cursor, signal),
  });
  const ingress = createControlServiceIngress(operations);
  return { services: [service, events, ingress], service, ingress, mutations, waits };
}
