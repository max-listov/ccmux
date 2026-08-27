import { describe, expect, test } from "bun:test";
import { ExternalInventoryJsonSchema, ExternalSessionSchema } from "../src/config/schema.ts";
import { externalInventoryJson, externalTableLines } from "../src/commands/external.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";

const session = ExternalSessionSchema.parse({
  key: `external:codex:host-a#${THREAD}`,
  plane: "external",
  provider: "codex",
  host: "host-a",
  threadId: THREAD,
  dir: "/Users/u/project",
  path: "/Users/u/.codex/sessions/rollout.jsonl",
  origin: "desktop",
  storage: "stored",
  writerEvidence: "none-observed",
  writerRuntime: null,
  capabilities: {
    inspect: true,
    attemptAdopt: true,
    fork: true,
    terminateAndAdopt: false,
    releaseAtSource: false,
    reasons: ["no writer was observed; that is not proof the thread is free"],
  },
  lastActivityMs: 1,
  lastModel: "model-a",
  usedTokens: 2,
  lastMessage: null,
});

describe("external inventory command", () => {
  test("JSON preserves the strict external plane and every independent evidence axis", () => {
    const output = externalInventoryJson("host-a", [session], new Date("2026-08-27T00:00:00.000Z"));
    expect(ExternalInventoryJsonSchema.parse(output)).toEqual(output);
    expect(output.sessions[0]).toMatchObject({
      plane: "external",
      provider: "codex",
      origin: "desktop",
      storage: "stored",
      writerEvidence: "none-observed",
      writerRuntime: null,
    });
  });

  test("human output carries provider and full UUID for adopt without calling the row running", () => {
    const text = externalTableLines([session]).join("\n");
    expect(text).toContain("codex");
    expect(text).toContain(THREAD);
    expect(text).toContain("none-observed/-");
    expect(text).not.toContain("running");
  });
});
