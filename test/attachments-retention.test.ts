import { expect, test } from "bun:test";
import { writeSessionsUnlocked } from "../src/config/sessions.ts";
import { cancelAttachmentUpload, readAttachmentChunk } from "../src/attachments/service.ts";
import { inheritAttachmentPins, resolveMessageAttachments } from "../src/attachments/pins.ts";
import { withAttachmentStore } from "../src/attachments/store.ts";
import { managedPeer } from "../src/chat/identity.ts";
import { attachmentFixture, pin, upload } from "./attachments-fixture.test.ts";

test("acceptance atomically pins ordered references and uncertainty never makes assets collectible", async () => {
  const f = await attachmentFixture(), first = await upload(f), second = await upload(f), messageId = crypto.randomUUID();
  await expect(pin(f, messageId, [first, second], async () => { throw new Error("unknown-ledger-outcome"); })).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  await withAttachmentStore(f.machine, "fixture-expire", async (tx) => {
    for (const row of tx.store.records) row.expiresAt = 0;
    tx.persist();
  });
  expect(await pin(f, messageId, [first, second], async () => "accepted")).toBe("accepted");
  await expect(pin(f, messageId, [second, first], async () => "wrong")).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  await expect(cancelAttachmentUpload(f.machine, f.principal, { target: f.target, uploadId: first.id }, f.signal)).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  const paths = await resolveMessageAttachments(f.machine, f.session, messageId, [first, second], f.signal);
  expect(paths.map((item) => item.reference.id)).toEqual([first.id, second.id]);
  expect(paths.every((item) => item.path.startsWith(f.root) && item.dataUrl === null)).toBe(true);
  const urls = await resolveMessageAttachments(f.machine, f.session, messageId, [first, second], f.signal, "data-url");
  expect(urls[0]?.dataUrl).toStartWith("data:image/png;base64,");
});

test("restart and archive preserve retained inputs while registration replacement cannot reuse them", async () => {
  const f = await attachmentFixture(), reference = await upload(f), messageId = crypto.randomUUID();
  await pin(f, messageId, [reference], async () => true);
  const restarted = { ...f.session };
  expect(await resolveMessageAttachments({ ...f.machine }, restarted, messageId, [reference], f.signal)).toHaveLength(1);
  await writeSessionsUnlocked(f.machine, [{ ...f.session, archived: true }]);
  expect((await readAttachmentChunk(f.machine, f.principal, { target: f.target, reference, offset: 0 }, f.signal)).complete).toBe(true);
  await writeSessionsUnlocked(f.machine, [{ ...f.session, registrationGeneration: crypto.randomUUID() }]);
  await expect(readAttachmentChunk(f.machine, f.principal, { target: f.target, reference, offset: 0 }, f.signal)).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
});

test("fork retention copies reachability, not bytes, and preserves exact caller authorization", async () => {
  const f = await attachmentFixture(), reference = await upload(f), messageId = crypto.randomUUID();
  await pin(f, messageId, [reference], async () => true);
  const destination = { ...f.session, name: "fork-agent", uuid: crypto.randomUUID(), registrationGeneration: crypto.randomUUID() };
  await writeSessionsUnlocked(f.machine, [f.session, destination]);
  await inheritAttachmentPins(f.machine, f.session, destination, f.signal);
  await inheritAttachmentPins(f.machine, f.session, destination, f.signal);
  const target = managedPeer(f.machine.rcPrefix, destination);
  expect((await readAttachmentChunk(f.machine, f.principal, { target, reference, offset: 0 }, f.signal)).complete).toBe(true);
  await expect(readAttachmentChunk(f.machine, { ...f.principal, machine: "host-c" }, { target, reference, offset: 0 }, f.signal)).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  const counts = await withAttachmentStore(f.machine, "fixture-inspect", async (tx) => ({ rows: tx.store.records.length, pins: tx.store.pins.length }));
  expect(counts).toEqual({ rows: 1, pins: 2 });
});
