import { z } from 'zod';
import { PolicySourceSchema } from '../../policy/schema.ts';
import { NativeModelSelectionSchema } from '../../runtime/selectionSchema.ts';

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const CustomToolNameSchema = z.enum([
  'read_file',
  'write_file',
  'search_files',
  'apply_patch',
  'run_command',
  'read_output',
  'read_resource',
]);

/** Execution-host definition only. The public API selects the existing immutable launch recipe;
 * it never receives this configuration, source paths, executable aliases or credentials. */
export const CustomLaunchConfigSchema = z
  .object({
    provider: z
      .object({
        kind: z.literal('openrouter'),
        credentialEnv: EnvironmentNameSchema,
      })
      .strict(),
    models: z
      .array(
        z
          .object({
            selection: NativeModelSelectionSchema,
            contextWindow: z.number().int().min(4096).max(4_194_304),
            capabilities: z.array(z.enum(['tools', 'vision', 'reasoning', 'files'])).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    defaultModel: NativeModelSelectionSchema,
    trustedRoots: z.array(z.string().startsWith('/').max(4096)).max(16),
    resources: z
      .array(
        PolicySourceSchema.extend({
          kind: z.enum(['instruction', 'skill', 'resource']),
        }).strict(),
      )
      .max(32),
    tools: z.array(CustomToolNameSchema).max(7),
    approvalTools: z.array(CustomToolNameSchema).max(7),
    approvalSecretEnv: EnvironmentNameSchema,
    executables: z.record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
      z.string().startsWith('/').max(4096),
    ),
    commandEnvironment: z.array(EnvironmentNameSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const values of [value.tools, value.approvalTools, value.commandEnvironment])
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: 'custom', message: 'Host capability lists must be unique' });
    if (
      value.commandEnvironment.some(
        (name) => name === value.provider.credentialEnv || name === value.approvalSecretEnv,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Execution credentials are not command capabilities',
      });
    if (new Set(value.resources.map(({ id }) => id)).size !== value.resources.length)
      ctx.addIssue({ code: 'custom', message: 'Resource identities must be unique' });
    const key = (model: z.infer<typeof NativeModelSelectionSchema>) => JSON.stringify(model);
    if (new Set(value.models.map(({ selection }) => key(selection))).size !== value.models.length)
      ctx.addIssue({ code: 'custom', message: 'Model identities must be unique' });
    if (!value.models.some(({ selection }) => key(selection) === key(value.defaultModel)))
      ctx.addIssue({ code: 'custom', message: 'Default model must be in the host registry' });
    if (value.models.some(({ selection }) => selection.provider !== value.provider.kind))
      ctx.addIssue({ code: 'custom', message: 'Model provider must match the host adapter' });
    if (value.approvalTools.some((name) => !value.tools.includes(name)))
      ctx.addIssue({ code: 'custom', message: 'Approval tool must be enabled' });
    if (Object.keys(value.executables).length > 32)
      ctx.addIssue({ code: 'custom', message: 'Executable catalog exceeds its bound' });
    if (value.resources.length > 0 && value.trustedRoots.length === 0)
      ctx.addIssue({ code: 'custom', message: 'Resources require trusted roots' });
  });
export type CustomLaunchConfig = z.infer<typeof CustomLaunchConfigSchema>;
