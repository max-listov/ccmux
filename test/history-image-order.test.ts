import { expect, test } from "bun:test";
import { attachmentFixture, pin, upload } from "./attachments-fixture.test.ts";
import { historyImageReferences } from "../src/context/history.ts";
import { resolveMessageAttachments } from "../src/attachments/pins.ts";

test("native history image order is independent of earlier pin order and preserves repeats", async () => {
  const f = await attachmentFixture(), first = await upload(f), second = await upload(f);
  const message = crypto.randomUUID();
  await pin(f, message, [first, second], async () => true);
  const paths = await resolveMessageAttachments(f.machine, f.session, message, [first, second], f.signal);
  const [a, b] = paths;
  if (!a || !b) throw new Error("Fixture image paths missing");
  const refs = await historyImageReferences(f.machine, f.session, [b.path, a.path, b.path], f.signal);
  expect(refs.map(ref => ref.id)).toEqual([second.id, first.id, second.id]);
  const reversed = await historyImageReferences(f.machine, f.session, [`${second.id}.jpg`, first.id], f.signal);
  expect(reversed.map(ref => ref.id)).toEqual([second.id, first.id]);
  expect(await historyImageReferences(f.machine, { ...f.session, registrationGeneration: crypto.randomUUID() }, [a.path], f.signal)).toEqual([]);
});
