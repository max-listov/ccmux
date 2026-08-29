import { expect, test } from "bun:test";
import { z } from "zod";
import {
  ControlServiceDescriptorSchema,
  ControlServiceOperationSchema,
  ccmuxControlServiceContract,
  ccmuxControlServiceDescriptor,
  controlServiceEffects,
} from "../src/control/serviceDescriptor.ts";

const TransportIdentifierSchema = z.string().max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const TransportDescriptorSchema = z
  .object({
    service: z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
    revision: z.string().max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    maxInflight: z.number().int().min(1).max(32),
    operations: z
      .array(
        z
          .object({
            id: TransportIdentifierSchema,
            effect: TransportIdentifierSchema,
            limits: z
              .object({
                requestBytes: z.number().int().min(1).max(65_536),
                responseBytes: z.number().int().min(1).max(1_048_576),
                timeoutMs: z.number().int().min(1).max(30_000),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const ids = new Set<string>();
    for (const [index, operation] of descriptor.operations.entries()) {
      if (ids.has(operation.id))
        ctx.addIssue({ code: "custom", path: ["operations", index, "id"], message: "duplicate operation" });
      ids.add(operation.id);
    }
  });

test("published control descriptor satisfies the independent transport policy contract", () => {
  expect(TransportDescriptorSchema.parse(ccmuxControlServiceDescriptor)).toEqual(ccmuxControlServiceDescriptor);
  expect(ccmuxControlServiceDescriptor.operations).toHaveLength(9);
  for (const operation of ccmuxControlServiceDescriptor.operations) {
    expect(operation.effect).toBe(controlServiceEffects[operation.id]);
  }
  for (const endpoint of Object.values(ccmuxControlServiceContract.endpoints)) {
    const operation = ControlServiceOperationSchema.parse(endpoint.path.slice(1));
    expect(endpoint.meta.effect).toBe(controlServiceEffects[operation]);
  }
});

test("owner and transport schemas reject operation/effect disagreement", () => {
  const mismatched = {
    ...ccmuxControlServiceDescriptor,
    operations: ccmuxControlServiceDescriptor.operations.map((operation) =>
      operation.id === "session.get" ? { ...operation, effect: "session.create" } : operation,
    ),
  };
  expect(() => ControlServiceDescriptorSchema.parse(mismatched)).toThrow("wrong effect");
  expect(() => TransportDescriptorSchema.parse({
    ...mismatched,
    operations: mismatched.operations.map((operation) =>
      operation.id === "session.get" ? { ...operation, effect: "session:read" } : operation,
    ),
  })).toThrow("Invalid string");
});
