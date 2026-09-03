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

const MAX_SERVICES = 8;
const MAX_SERVICE_TOOLS = 32;

/**
 * Every tool name one recipe declares — coding tools and service operations, in one expression.
 *
 * The two lists are configured apart because they are configured by different things, and that is
 * precisely why this exists rather than each reader assembling its own union. Composition admitted
 * both while the applied-profile check knew only `tools`, so a recipe declaring any service was
 * accepted, earned a digest, reported `configured` — and its session died on its first profile
 * event with «Native applied profile differs from its host authority». One set, two copies, and
 * they disagreed; the same shape this file already carries a note about, one field up.
 */
export function declaredCustomToolNames(config: CustomLaunchConfig): string[] {
  return [...config.tools, ...config.services.flatMap((service) => service.tools)];
}

/**
 * The most names a valid recipe can declare, for the readers that must bound that set.
 *
 * Derived rather than written down: a literal here would be the third authority on this set, and
 * this file records what happened the last two times one went stale. A downstream bound smaller
 * than this rejects a recipe the schema accepted, which is the same defect one layer along.
 */
export const MAX_DECLARED_CUSTOM_TOOLS =
  CustomToolNameSchema.options.length + MAX_SERVICES * MAX_SERVICE_TOOLS;

/**
 * A contract service whose operations this host mounts as tools of a Custom session.
 *
 * Custom exists to run this system's own loop on a machine that is not the consumer's, and without
 * this a session could read and write files and perform not one operation of the party that started
 * it. The seam was never missing — `mountAgent` takes services — what was missing is where the
 * operation SHAPES come from, because the service runs elsewhere. They arrive by handshake: ccmux
 * spawns the declared executable and speaks MCP over its stdio, so no schema is written down twice
 * and nothing of the far side's code runs inside the supervisor.
 */
const CustomServiceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    /**
     * The executable this host runs to serve the operations, absolute like every other one here.
     *
     * A child process rather than an address or a module, and that is the whole security argument:
     * the supervisor holds every session's approval secret and provider credential, so third-party
     * code must not enter it. This is the boundary `executables` already draws.
     */
    command: z.string().startsWith('/').max(4096),
    args: z.array(z.string().max(4096)).max(16).default([]),
    credentialEnv: EnvironmentNameSchema.optional(),
    /**
     * The operations this recipe admits, by tool name.
     *
     * Admission is the recipe's alone, exactly as for coding tools: an operation the server offers
     * and this list omits is never mounted, so widening what a session can reach stays a recipe
     * change and a new digest rather than a change on the far side.
     */
    tools: z
      // A dot is part of the name, not decoration: a contract server names its tools
      // `prefix.operation`, and a charset copied from the coding-tool names rejected every one of
      // them. The recipe declares what the server offers, verbatim — renaming here would be this
      // side inventing a second name for one thing.
      .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/))
      .min(1)
      .max(MAX_SERVICE_TOOLS),
  })
  .strict();

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
    // Bounded by the list itself. Written as a literal it was a third authority on the same set and
    // went stale the moment the set grew: at seven, a recipe naming all nine was refused by a number.
    tools: z.array(CustomToolNameSchema).max(CustomToolNameSchema.options.length),
    approvalTools: z.array(CustomToolNameSchema).max(CustomToolNameSchema.options.length),
    // Defaulted, not required: every recipe that predates services declares none, and a host that
    // mounts no service is the ordinary case rather than a misconfiguration.
    services: z.array(CustomServiceSchema).max(MAX_SERVICES).default([]),
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
export type CustomService = z.infer<typeof CustomServiceSchema>;
