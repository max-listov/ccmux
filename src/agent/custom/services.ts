import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RuntimeToolDefinition } from 'stitchkit/tools';
import { z } from 'zod';
import { VERSION } from '../../util/version.ts';
import type { CustomService } from './config.ts';

/**
 * Contract operations of the party a Custom session works for, mounted as tools of that session.
 *
 * Custom is the only way to run this system's own loop on a machine that is not the consumer's, and
 * without this a session could read and write files and perform not one operation of its owner —
 * it could neither take a task, nor report on it, nor read a registry. The seam was never missing:
 * what was missing is where the operation SHAPES come from, because the service runs elsewhere.
 *
 * They arrive by handshake. The recipe names an executable on the host, ccmux spawns it and speaks
 * MCP over its stdio, and the tool list with its JSON Schemas comes back over that. Two properties
 * of this were the reason to choose it over reading a document or importing a module: no
 * third-party code enters the supervisor process, which holds every session's approval secret and
 * provider credential, and no schema is written down twice, so there is no second place to go
 * stale. The trust boundary is exactly the one `executables` already draws — a child process the
 * host declared.
 */

const RESPONSE_BYTES = 256 * 1024;

/** A JSON Schema node, only as far as this converter reads one. */
const NodeSchema = z
  .object({
    type: z.union([z.string(), z.array(z.string()).max(32)]).optional(),
    enum: z.array(z.unknown()).optional(),
    items: z.unknown().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    description: z.string().max(1024).optional(),
    anyOf: z.array(z.unknown()).max(32).optional(),
  })
  .loose();

/**
 * The one union this reads: a nullable field.
 *
 * JSON Schema permits both `anyOf: [{ type: 'boolean' }, { type: 'null' }]` and
 * `type: ['boolean', 'null']` for it. Two branches where one is `null` is not a union of meanings —
 * it is one shape that may be absent, and it is the commonest form in a real contract tree: a
 * consumer counted 18 of them against 31 genuine unions. Refusing it would have cost them half
 * their operations or made them double the contract to spell out an optional field. A union of
 * two real types stays refused, because there the model would have to be told which one to send and
 * this cannot tell it.
 */
function nullableBranch(node: z.output<typeof NodeSchema>): unknown | null {
  if (Array.isArray(node.type)) {
    if (node.type.length !== 2 || node.type.filter((type) => type === 'null').length !== 1)
      return null;
    const concrete = node.type.find((type) => type !== 'null');
    return concrete === undefined ? null : { ...node, type: concrete };
  }
  if (node.anyOf === undefined || node.anyOf.length !== 2) return null;
  const parsed = node.anyOf.map((branch) => NodeSchema.parse(branch));
  const nulls = parsed.filter((branch) => branch.type === 'null');
  if (nulls.length !== 1) return null;
  return parsed.find((branch) => branch.type !== 'null') ?? null;
}

export class UnsupportedOperationShape extends Error {}

/**
 * The part of JSON Schema this mounts, and a refusal for the rest.
 *
 * Deliberately small: string, number, boolean, string enums, arrays and nested objects. Anything
 * else — a union, a `$ref`, a schema with no type — throws, and the caller drops that one operation
 * and says which. The alternative to refusing is guessing a shape, and a guessed input schema is a
 * tool the model calls wrongly forever with no error that points back here.
 */
function toZod(value: unknown): z.ZodType {
  const node = NodeSchema.parse(value);
  const described = <T extends z.ZodType>(schema: T) =>
    node.description === undefined ? schema : schema.describe(node.description);
  const nullable = nullableBranch(node);
  if (nullable !== null) return described(toZod(nullable).nullable());
  if (node.enum !== undefined) {
    const options = node.enum.filter((item): item is string => typeof item === 'string');
    if (options.length !== node.enum.length || options.length === 0)
      throw new UnsupportedOperationShape('enum values must be strings');
    return described(z.enum(options as [string, ...string[]]));
  }
  switch (node.type) {
    case 'string':
      return described(z.string());
    case 'number':
    case 'integer':
      return described(z.number());
    case 'boolean':
      return described(z.boolean());
    case 'array': {
      if (node.items === undefined) throw new UnsupportedOperationShape('array without items');
      return described(z.array(toZod(node.items)));
    }
    case 'object':
      return described(toZodObject(node));
    default:
      throw new UnsupportedOperationShape(`unsupported type ${node.type ?? 'absent'}`);
  }
}

function toZodObject(node: z.output<typeof NodeSchema>): z.ZodObject {
  const required = new Set(node.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, property] of Object.entries(node.properties ?? {})) {
    const converted = toZod(property);
    shape[key] = required.has(key) ? converted : converted.optional();
  }
  return z.object(shape);
}

export interface MountedService {
  tools: RuntimeToolDefinition[];
  /** Operations the recipe named that could not be mounted, and why — never silently absent. */
  refused: { name: string; reason: string }[];
  close(): Promise<void>;
}

/**
 * Spawn one declared service and mount the operations this recipe admits.
 *
 * Admission is the recipe's alone, exactly as it is for coding tools: an operation the server
 * offers and the recipe does not name is never built, so widening what a session can reach stays a
 * recipe change and a new digest rather than a change on the far side.
 */
export async function mountCustomService(
  service: CustomService,
  credential: string | undefined,
): Promise<MountedService> {
  const transport = new StdioClientTransport({
    command: service.command,
    ...(service.args.length === 0 ? {} : { args: [...service.args] }),
    // Only what the recipe declared. The session's own environment carries the approval secret and
    // the provider key, and a tool server has no business seeing either.
    env:
      credential === undefined || service.credentialEnv === undefined
        ? {}
        : { [service.credentialEnv]: credential },
  });
  const client = new Client({ name: 'ccmux', version: VERSION });
  await client.connect(transport);
  try {
    const admitted = new Set(service.tools);
    const listed = await client.listTools();
    const tools: RuntimeToolDefinition[] = [];
    const refused: { name: string; reason: string }[] = [];
    for (const offered of listed.tools) {
      if (!admitted.has(offered.name)) continue;
      let input: z.ZodObject;
      try {
        input = toZodObject(NodeSchema.parse(offered.inputSchema));
      } catch (error) {
        refused.push({
          name: offered.name,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      tools.push({
        name: offered.name,
        description: offered.description ?? offered.name,
        identity: { serviceName: service.id, action: offered.name, method: 'POST' },
        input,
        output: z.unknown(),
        handler: async ({ input: value }) => {
          const result = await client.callTool({
            name: offered.name,
            arguments: value as Record<string, unknown>,
          });
          const body = result.structuredContent ?? result.content;
          const text = JSON.stringify(body ?? null);
          if (Buffer.byteLength(text) > RESPONSE_BYTES)
            // Bounded like every other tool output here: the context window is the resource being
            // spent, and a service is free to answer with more than a turn can hold.
            throw new Error(`Service ${service.id} answered beyond the response bound`);
          if (result.isError === true) throw new Error(`Service ${service.id} refused: ${text}`);
          return body ?? null;
        },
      } as RuntimeToolDefinition);
    }
    return { tools, refused, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}
