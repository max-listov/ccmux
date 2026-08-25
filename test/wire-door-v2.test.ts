import { test, expect } from "bun:test";
import { refusalIsPermanent } from "../src/fleet/wire.ts";
import { queuedForRetryNotice } from "../src/fleet/transport.ts";
import { routeFor } from "../src/fleet/address.ts";
import { peersOf } from "../src/fleet/transport.ts";
import { makeMachine } from "./helpers.ts";

// The door separates WHO said no from WHAT KIND of no it is, and the kinds behave oppositely.
// Reading only the first — which is what this code used to do — makes both mistakes at once: an hour
// of pointless retries against a permanent refusal, and a healthy-but-busy fleet drawn as broken.

test("capacity is temporary; policy and request are permanent", () => {
  expect(refusalIsPermanent("capacity")).toBe(false);
  expect(refusalIsPermanent("policy")).toBe(true);
  expect(refusalIsPermanent("request")).toBe(true);
});

test("an older door that cannot say leaves the kind UNKNOWN, and nothing is inferred", () => {
  // Not "assume temporary" and not "assume permanent": both are guesses, and a guess here either
  // throws mail away or retries something that will never work.
  expect(refusalIsPermanent(undefined)).toBeUndefined();
  expect(refusalIsPermanent("none")).toBeUndefined();
});

test("a permanent refusal is never described as something that will retry itself", () => {
  const temporary = queuedForRetryNotice("msg host-b:agent-b", "capacity/…: node busy", 60, false);
  expect(temporary).toContain("QUEUED, not lost");
  expect(temporary).toContain("retries it automatically");

  const permanent = queuedForRetryNotice("msg host-b:agent-b", "denied/policy: not on the allowlist", 60, true);
  expect(permanent).toContain("refused identically on every retry");
  expect(permanent).not.toContain("retries it automatically");
  // Still recorded — the record is the point — but the reader is not sent away reassured.
  expect(permanent).toContain("recorded in the outbox");
});

// ── the mail-loss regression ─────────────────────────────────────────────────────────────────────

test("a wire-only peer IS addressable, and a retry must not settle its mail as delivered", () => {
  // Measured on a live fleet: both servers reach the laptop over the wire and have no ssh alias for
  // it at all. The drain pass read only the ssh map, found nothing, and acked the envelope as
  // delivered — silently throwing away every retry to the one machine the wire exists for.
  const m = makeMachine({ rcPrefix: "host-a", wire: { peers: ["host-b"] } });
  expect(peersOf(m).map((p) => `${p.machine}/${p.via}`)).toEqual(["host-b/wire"]);
  const route = routeFor("host-b:agent-b", m);
  expect(route.kind).toBe("remote");
  if (route.kind === "remote") expect(route.alias).toBeNull(); // no alias, and that is fine
});

test("a machine in neither map is genuinely unaddressable — that is the only settle case", () => {
  const m = makeMachine({ rcPrefix: "host-a", fleet: { "host-c": "alias-c" } });
  expect(routeFor("host-b:agent-b", m).kind).toBe("error");
});

test("a fleet with only wire peers still drains — the pass may not require an ssh map", () => {
  // The guard used to be "no ssh fleet map → return", which meant a wire-only machine never drained
  // its outbox at all.
  expect(peersOf(makeMachine({ rcPrefix: "host-a", wire: { peers: ["host-b"] } })).length).toBe(1);
  expect(peersOf(makeMachine({ rcPrefix: "host-a" })).length).toBe(0);
});
