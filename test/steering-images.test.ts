import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AttachmentStoreSchema } from "../src/attachments/schema.ts";
import { validateSteeringImages } from "../src/steering/preflight.ts";
import { readSteeringJournal } from "../src/steering/store.ts";
import { upload } from "./attachments-fixture.test.ts";
import { steeringFixture } from "./steering-fixture.test.ts";

test("image-only steer pins exact ordered assets before intent and emits private native paths only", async () => {
  const f = await steeringFixture();
  f.input.body = ""; f.input.images = [await upload(f), await upload(f)];
  f.setSteer(async (raw) => {
    const native = z.object({ input: z.array(z.object({ type: z.literal("localImage"), path: z.string() }).strict()) }).parse(raw);
    expect(native.input).toHaveLength(2);
    const store = AttachmentStoreSchema.parse(JSON.parse(readFileSync(join(f.root, "attachments", "index.json"), "utf8")));
    expect(store.pins[0]).toMatchObject({ messageId: f.input.operationId, registration: f.input.registrationGeneration,
      target: f.target, principal: f.principal, references: f.input.images });
    for (const row of native.input) expect(readFileSync(row.path).length).toBeGreaterThan(0);
    return { turnId: f.input.expectedTurnId };
  });
  const receipt = await f.run(); expect(receipt.state).toBe("submitted");
  expect(JSON.stringify(receipt)).not.toContain(f.root);
  expect(readSteeringJournal(f.machine, f.session).operations[0]?.receipt.turnId).toBe(f.input.expectedTurnId);
  const refs = f.input.images; f.input.images = [...refs].reverse();
  await expect(f.run()).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" }); expect(f.submissions).toHaveLength(1);
});

test("future selection defaults cannot claim active-turn image support", async () => {
  const f = await steeringFixture(); f.input.images = [await upload(f)];
  await expect(validateSteeringImages(f.machine, f.session, f.input, f.signal)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(readSteeringJournal(f.machine, f.session).operations).toEqual([]);
});

test("unverified or changed image reference refuses before durable intent and native submission", async () => {
  const f = await steeringFixture(); const reference = await upload(f);
  f.input.images = [{ ...reference, digest: "0".repeat(64) }];
  await expect(f.run()).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  expect(readSteeringJournal(f.machine, f.session).operations).toEqual([]); expect(f.submissions).toEqual([]);
});
