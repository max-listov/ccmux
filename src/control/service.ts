import { AppError } from "stitchkit";
import { createBoundedAdmission, BoundedAdmissionRefusalError, BoundedOperationWaitError,
  type ApplicationAdmission } from "stitchkit/application";
import { implement } from "stitchkit/server";
import { ChatPrincipalSchema } from "../config/schema.ts";
import { clearLifecycleBlock } from "../config/lifecycleBlocks.ts";
import { withSessionRegistryLock } from "../config/registryLock.ts";
import { startSession } from "../commands/lifecycle.ts";
import type { MachineConfig } from "../types.ts";
import { controlContract, controlEventsContract } from "./contract.ts";
import { acceptControlMessage } from "./message.ts";
import { interruptControlTurn, waitControlSession } from "./native.ts";
import type { ControlPublisher } from "./publisher.ts";
import { controlTarget } from "./target.ts";
import type { ExternalStatusPublisher } from "../external/resident-publisher.ts";

export function controlServices(m: MachineConfig, publisher: ControlPublisher, external: ExternalStatusPublisher, upstream?: ApplicationAdmission) {
  const mutations = createBoundedAdmission({ ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 8 }, perKey: { maxConcurrent: 1, maxKeys: 256 } } });
  const waits = createBoundedAdmission({ ...(upstream ? { upstream } : {}), policy: { global: { maxConcurrent: 16 } } });
  const service = implement(controlContract, {
    list: () => publisher.read(),
    external: () => external.read(),
    get: ({ input }) => {
      controlTarget(m, input.target);
      const row = publisher.read().sessions.find((s) => s.identity.session === input.target.session && s.identity.threadId === input.target.threadId);
      if (!row) throw new AppError("UNAVAILABLE", "Session has no prepared observation", 503);
      return row;
    },
    message: (ctx) => mutations.run(ctx.input.target.session,
      ({ signal }) => acceptControlMessage(m, ChatPrincipalSchema.parse(ctx.principal), ctx.input, signal),
      { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 15_000 }).catch(controlRefusal),
    start: (ctx) => mutations.run(ctx.input.target.session, ({ signal }) => withSessionRegistryLock(m, async () => {
      signal.throwIfAborted();
      const session = controlTarget(m, ctx.input.target);
      if (session.archived) throw new AppError("ARCHIVED", "Archived sessions cannot be started", 409);
      clearLifecycleBlock(m, session.name);
      await startSession(m, session.name, session.dir);
      return { target: ctx.input.target, accepted: true } satisfies { target: typeof ctx.input.target; accepted: true };
    }), { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 15_000 }).catch(controlRefusal),
    interrupt: (ctx) => mutations.run(ctx.input.target.session,
      ({ signal }) => interruptControlTurn(m, ctx.input.target, ctx.input.turnId, signal),
      { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 10_000 }).catch(controlRefusal),
    wait: (ctx) => waits.run(undefined,
      ({ signal }) => waitControlSession(m, publisher, ctx.input.target, ctx.input.timeoutMs, signal),
      { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 61_000 }).catch(controlRefusal),
  });
  const events = implement(controlEventsContract, {
    watch: ({ signal }) => publisher.subscribe(signal),
    watchExternal: ({ signal }) => external.subscribe(signal),
  });
  return { services: [service, events], service, mutations, waits };
}

function controlRefusal(error: unknown): never {
  if (error instanceof BoundedAdmissionRefusalError) {
    const draining = error.reason === "not-accepting" || error.reason === "upstream";
    throw new AppError(draining ? "UNAVAILABLE" : "BUSY", draining ? "Control is draining" : "Control capacity reached", draining ? 503 : 429);
  }
  if (error instanceof BoundedOperationWaitError) {
    throw new AppError(error.reason === "timed-out" ? "TIMEOUT" : "CANCELLED", "Control call did not finish within its caller budget", 504);
  }
  throw error;
}
