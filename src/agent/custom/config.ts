import { z } from 'zod';
import { PolicySourceSchema } from '../../policy/schema.ts';
import { NativeModelSelectionSchema } from '../../runtime/selectionSchema.ts';
import { ENDPOINT_REFUSAL_TEXT, parseLocalEndpoint } from './endpoint.ts';

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/**
 * The names a recipe may declare — and they are the names the composed session actually gets.
 *
 * This list and the harness's own were two authorities on one set, and they disagreed both ways.
 * `apply_patch` could be declared and was never built, so a recipe naming it passed validation,
 * received a digest, reported `configured`, and then killed its session at startup; `edit_file`,
 * `glob` and `list_directory` were built and could not be declared, so a Custom session had no way
 * to edit a file at all — `write_file` rewrites it whole.
 *
 * A literal union is kept rather than derived from the harness, because the names are types
 * everywhere else in this tree. What keeps it honest is `composableToolNames` below and the test
 * that compares the two sets: the next divergence reddens there instead of in a consumer's session.
 */
export const CustomToolNameSchema = z.enum([
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'glob',
  'list_directory',
  'run_command',
  'read_output',
  'read_resource',
]);

/**
 * Which inference provider this host composes, and what each kind needs from the host to work.
 *
 * A discriminated union rather than an endpoint bolted onto one shape, because the kinds do not
 * differ by configuration alone: they differ in provenance. `kind` is what the catalog publishes as
 * the source of an answer and what every model in the registry must declare, so a local endpoint
 * described as `openrouter` would not be a shortcut — it would make the runtime report the wrong
 * origin for the work it did.
 *
 * The credential is required for the aggregator and optional for a local server, which is not a
 * relaxation of the rule but the rule stated accurately: an aggregator without a key cannot answer
 * at all, while the common local servers accept requests without one.
 */
export const CustomProviderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('openrouter'), credentialEnv: EnvironmentNameSchema }).strict(),
  z
    .object({
      kind: z.literal('local'),
      endpoint: z.string().min(1).max(2048),
      credentialEnv: EnvironmentNameSchema.optional(),
      /**
       * Which local server this is, when the host cares to say.
       *
       * `kind` answers where the work ran and is checked against the address; it deliberately cannot
       * answer what served it, so a host running two local engines reports the same provenance for
       * both. This carries that missing half — beside the locality fact, never instead of it.
       *
       * Free-form on purpose: the point of an OpenAI-compatible adapter is that the server does not
       * have to be one we have heard of, and a known-set would make this runtime the registrar of
       * every engine anyone runs. The charset is narrow and the value is host configuration pinned
       * by the recipe digest, not caller input, so a typo is a recipe change and not a silent
       * identity. It is reported and never matched on: nothing selects a model by this.
       */
      label: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
        .optional(),
    })
    .strict(),
]);

/** Execution-host definition only. The public API selects the existing immutable launch recipe;
 * it never receives this configuration, source paths, executable aliases or credentials. */
export const CustomLaunchConfigSchema = z
  .object({
    provider: CustomProviderSchema,
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
    // Two of the names are only composed when this same config supplies what they are made of, so a
    // recipe can name them and still get a session that cannot build them. Refused HERE, where the
    // recipe is accepted, rather than at startup: a recipe that cannot run should not earn a digest
    // and report `configured`, and the failure a consumer saw was CREATE_FAILED with the reason left
    // in the owner's journal. `tools.test.ts` pins both conditions against the harness itself.
    for (const [name, missing, needs] of [
      ['run_command', Object.keys(value.executables).length === 0, 'a declared executable'],
      ['read_resource', value.resources.length === 0, 'a declared resource'],
    ] as const)
      if (value.tools.includes(name) && missing)
        ctx.addIssue({
          code: 'custom',
          message: `Tool ${name} needs ${needs} in this recipe`,
          path: ['tools'],
        });
    if (
      value.commandEnvironment.some(
        (name) => name === value.provider.credentialEnv || name === value.approvalSecretEnv,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Execution credentials are not command capabilities',
      });
    // Validated here rather than inside the union member so the discriminator stays a plain object
    // schema; the reason for refusal is carried through verbatim instead of collapsing to "invalid".
    if (value.provider.kind === 'local') {
      const endpoint = parseLocalEndpoint(value.provider.endpoint);
      if ('refused' in endpoint)
        ctx.addIssue({
          code: 'custom',
          message: ENDPOINT_REFUSAL_TEXT[endpoint.refused],
          path: ['provider', 'endpoint'],
        });
    }
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
