import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { PermissionModeSchema } from '../runtime/projectionSchema.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig } from '../types.ts';
import { setControlPermissionMode } from './command.ts';
import type {
  ControlPermissionReadSchema,
  ControlPermissionResultSchema,
  ControlPermissionUpdateSchema,
} from './schema.ts';
import { controlTarget } from './target.ts';

/**
 * The permission mode of a live session, read and replaced.
 *
 * The capability was declared and served by nothing: `runtime.list` reported `permissionModes` for
 * native Claude while the plane had no operation for it, so a consumer could show the mode as a
 * label with a padlock and nothing more.
 *
 * There is no register of our own beside the runtime's value, and that absence is the design. A
 * revision would version OUR record of intent, while the thing a caller must not do blindly is
 * overwrite a mode that was changed somewhere else — which only a comparison against the observed
 * value catches. So the check is `expectedMode`, founded on something we genuinely know.
 */
function observed(
  m: MachineConfig,
  target: z.output<typeof ControlPermissionReadSchema>['target'],
) {
  const session = controlTarget(m, target);
  if (!runtimeCapabilities(session).permissionModes)
    throw new AppError('UNSUPPORTED', 'This runtime does not expose a permission mode', 409);
  const read = readManagedRuntimeStatus(m, session);
  const mode = read.snapshot?.permissionMode;
  return {
    session,
    // Absent while the runtime is not live. Not knowing the mode is a different answer from a
    // session running without one, and a caller comparing against a guess would be worse than one
    // told it cannot check.
    native:
      mode === undefined || read.snapshot === null
        ? null
        : { mode, observedAt: read.snapshot.observedAt },
  };
}

export function readControlPermission(
  m: MachineConfig,
  input: z.output<typeof ControlPermissionReadSchema>,
): z.output<typeof ControlPermissionResultSchema> {
  const { native } = observed(m, input.target);
  return {
    target: input.target,
    native,
    // Reported rather than assumed: Claude and Codex do not name the same set, and a list written
    // here would be a second authority that is wrong for one of them.
    supported: [...PermissionModeSchema.options],
  };
}

export async function updateControlPermission(
  m: MachineConfig,
  input: z.output<typeof ControlPermissionUpdateSchema>,
  signal: AbortSignal,
): Promise<z.output<typeof ControlPermissionResultSchema>> {
  const { native } = observed(m, input.target);
  if (native === null) throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
  if (native.mode !== input.expectedMode)
    throw new AppError(
      'STALE_REQUEST',
      `Session permission mode is ${native.mode}, not ${input.expectedMode}`,
      409,
    );
  await setControlPermissionMode(
    m,
    { target: input.target, mode: input.mode, operationId: input.operationId },
    signal,
  );
  // Answered with the mode the runtime accepted, read back rather than echoed: publishing the
  // requested value would report a mode the session might not be running under.
  const after = observed(m, input.target);
  return {
    target: input.target,
    native: after.native,
    supported: [...PermissionModeSchema.options],
  };
}
