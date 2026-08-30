import { expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { steerNativeTurn } from "../src/steering/service.ts";
import { readSteeringJournal, writeSteeringJournal } from "../src/steering/store.ts";
import { writeSessionsUnlocked } from "../src/config/sessions.ts";
import { managedRuntimeRoot } from "../src/runtime/status.ts";
import { steeringFixture } from "./steering-fixture.test.ts";

test("concurrent same-ID requests submit once; changed payload and caller cannot acquire the operation", async () => {
  const f = await steeringFixture();
  const [first, second] = await Promise.all([f.run(), f.run()]);
  expect(second).toEqual(first); expect(f.submissions).toHaveLength(1);
  await expect(steerNativeTurn(f.machine, f.principal, { ...f.input, body: "A different correction." }, f.signal, f.deps))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(steerNativeTurn(f.machine, { ...f.principal, machine: "host-c" }, f.input, f.signal, f.deps))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(f.submissions).toHaveLength(1);
});

test("lost ack survives restart and reconciles only exact client identity on the original turn", async () => {
  const f = await steeringFixture();
  f.setSteer(async () => { throw new Error("private provider transport fixture"); });
  const uncertain = await f.run(); expect(uncertain.state).toBe("uncertain");
  f.setState({ protocol: 1, status: "live", reason: null, snapshot: { ...f.projection.snapshot(), generation: crypto.randomUUID(), state: "idle" } });
  expect((await f.run()).state).toBe("uncertain");
  f.receipts([{ id: "different-turn", status: "completed", items: [{ type: "userMessage", clientId: uncertain.clientUserMessageId }] }]);
  expect((await f.read()).operation?.state).toBe("uncertain");
  f.receipts([{ id: f.input.expectedTurnId, status: "interrupted", items: [{ type: "userMessage", clientId: uncertain.clientUserMessageId }] }]);
  expect((await f.read()).operation).toMatchObject({ state: "submitted", generation: uncertain.generation, turnId: uncertain.turnId });
  expect(f.submissions).toHaveLength(1);
  const journal = readFileSync(join(managedRuntimeRoot(f.machine, f.session), "steering.json"), "utf8");
  expect(journal).not.toContain(f.input.body); expect(journal).not.toContain("private provider");
});

test("an ordinary message with the same UUID cannot falsely reconcile a lost steering acknowledgement", async () => {
  const f = await steeringFixture(); f.setSteer(async () => { throw new Error("lost reply"); });
  const receipt = await f.run();
  f.receipts([{ id: f.input.expectedTurnId, status: "inProgress", items: [{ type: "userMessage", clientId: f.input.operationId }] }]);
  expect((await f.read()).operation?.state).toBe("uncertain");
  f.receipts([{ id: f.input.expectedTurnId, status: "inProgress", items: [{ type: "userMessage", clientId: receipt.clientUserMessageId }] }]);
  expect((await f.read()).operation?.state).toBe("submitted"); expect(f.submissions).toHaveLength(1);
});

test("crash after durable intent never retries native injection, even if bounded history returns no evidence", async () => {
  const f = await steeringFixture(); await f.run();
  const journal = readSteeringJournal(f.machine, f.session), operation = journal.operations[0];
  if (!operation) throw new Error("fixture operation missing");
  operation.phase = "intent"; operation.receipt.state = "uncertain";
  writeSteeringJournal(f.machine, f.session, journal);
  expect((await f.run()).state).toBe("uncertain"); expect(f.submissions).toHaveLength(1);
  expect(readSteeringJournal(f.machine, f.session).operations[0]?.phase).toBe("uncertain");
});

test("turn completion at native admission is not converted into a replacement turn or implicit retry", async () => {
  const f = await steeringFixture();
  f.setSteer(async () => { throw new Error("turn already completed"); });
  expect((await f.run()).state).toBe("uncertain");
  expect((await f.run()).state).toBe("uncertain");
  expect(f.submissions).toHaveLength(1); expect(f.calls).not.toContain("turn/start");
  const mismatch = await steeringFixture(); mismatch.setSteer(async () => ({ turnId: "replacement-turn" }));
  expect((await mismatch.run()).state).toBe("uncertain");
});

test("registration replacement cannot consume old receipts; archive preserves accepted operation evidence", async () => {
  const f = await steeringFixture(); const accepted = await f.run();
  await writeSessionsUnlocked(f.machine, [{ ...f.session, archived: true }]);
  expect((await f.read()).operation).toEqual(accepted);
  expect(await f.run()).toEqual(accepted);
  await expect(steerNativeTurn(f.machine, f.principal, { ...f.input, operationId: crypto.randomUUID() }, f.signal, f.deps))
    .rejects.toMatchObject({ code: "UNAVAILABLE" });
  await writeSessionsUnlocked(f.machine, [{ ...f.session, registrationGeneration: crypto.randomUUID() }]);
  await expect(f.read()).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
});

test("journal refuses symlinks and corruption without changing target content or sending native input", async () => {
  const f = await steeringFixture(); readSteeringJournal(f.machine, f.session);
  const outside = join(f.root, "outside.json"), journal = join(managedRuntimeRoot(f.machine, f.session), "steering.json");
  writeFileSync(outside, "private fixture", { mode: 0o600 }); symlinkSync(outside, journal);
  await expect(f.run()).rejects.toMatchObject({ code: "STEERING_UNAVAILABLE" });
  expect(readFileSync(outside, "utf8")).toBe("private fixture"); expect(f.submissions).toEqual([]);
  const broken = await steeringFixture(); readSteeringJournal(broken.machine, broken.session);
  writeFileSync(join(managedRuntimeRoot(broken.machine, broken.session), "steering.json"), "{", { mode: 0o600 });
  await expect(broken.run()).rejects.toMatchObject({ code: "STEERING_UNAVAILABLE" }); expect(broken.submissions).toEqual([]);
});

test("aborted calls cannot write intent, and native generation recheck catches changes during preflight", async () => {
  const f = await steeringFixture(); const abort = new AbortController(); abort.abort();
  await expect(steerNativeTurn(f.machine, f.principal, f.input, abort.signal, f.deps)).rejects.toThrow();
  expect(f.submissions).toEqual([]);
  const stale = await steeringFixture();
  stale.deps.capture = async () => { stale.setState({ protocol: 1, status: "live", reason: null,
    snapshot: { ...stale.projection.snapshot(), generation: crypto.randomUUID() } }); return "›\n gpt-fixture · /workspace"; };
  await expect(stale.run()).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  expect(readSteeringJournal(stale.machine, stale.session).operations).toEqual([]); expect(stale.submissions).toEqual([]);
});
