import { test, expect } from "bun:test";
import { parseProcStat, parsePsLine, isStitchwireAgent, hasSshdAncestor, remoteTransportAncestor } from "../src/chat/auth.ts";

// This walk gates every inbound remote message. It used to shell out ONCE PER ANCESTOR, which
// measured at ~104ms per message on Linux — the most expensive step in delivery, and the only one
// priced in process spawns. Reading the tree directly brought it to ~0.1ms. These tests pin the
// parsing that made the direct read possible, since that is where the new risk lives.

test("a command containing spaces and a closing paren is still parsed correctly", () => {
  // The exact input that defeats splitting on whitespace or on the FIRST ')'. A process can be named
  // anything, and a misparse here would silently deny delivery.
  expect(parseProcStat("42 (weird ) name) S 7 7 0 0 -1 4194304 100")).toEqual({ parent: 7, command: "weird ) name", args: "" });
});

test("an ordinary line parses, and the parent is the field after the state", () => {
  expect(parseProcStat("1234 (sshd) S 991 1234 1234 0 -1 4194560 200")).toEqual({ parent: 991, command: "sshd", args: "" });
});

test("garbage yields null rather than a guessed parent", () => {
  // Fail-closed matters more here than anywhere: a guessed parent could turn "not from the transport"
  // into "accepted".
  for (const bad of ["", "no parens at all", "42 (unclosed S 7", "42 (x) S notanumber"]) {
    expect(parseProcStat(bad)).toBeNull();
  }
});

test("the walk answers with a boolean and never throws on a nonexistent process", () => {
  expect(typeof hasSshdAncestor(999_999_99)).toBe("boolean");
  expect(hasSshdAncestor(1)).toBe(false); // pid 1 has no ancestors to inspect
});

// The wire is the second admitted transport, and the ONLY thing separating it from any other local
// process is this recognition. Both halves are load-bearing, so both are pinned.

test("the stitchwire agent is recognised through the interpreter that launched it", () => {
  // `comm` here is `bun`, a name shared with half the fleet — which is exactly why the match is on
  // the command line instead.
  expect(isStitchwireAgent("/root/.bun/bin/bun /root/.local/bin/stitchwire agent")).toBe(true);
  expect(isStitchwireAgent("/Users/u/.bun/bin/bun /Users/u/.local/bin/stitchwire agent")).toBe(true);
  expect(isStitchwireAgent("stitchwire agent")).toBe(true);
});

test("a caller is not a receiver: only the agent confers admission", () => {
  // `stitchwire call` is how a message LEAVES a machine. Anything descending from it is our own
  // outbound side, and treating that as an authenticated inbound transport would let any local
  // process launder itself into delivery by shelling out through the CLI.
  expect(isStitchwireAgent("/root/.local/bin/stitchwire call host-C -- ccmux list")).toBe(false);
  expect(isStitchwireAgent("/root/.bun/bin/bun /root/.local/bin/stitchwire nodes")).toBe(false);
  expect(isStitchwireAgent("bun /root/.local/bin/other-tool agent")).toBe(false);
  expect(isStitchwireAgent("")).toBe(false);
});

test("a ps line keeps its command line intact, spaces and all", () => {
  expect(parsePsLine("991 bun /root/.bun/bin/bun /root/.local/bin/stitchwire agent")).toEqual({
    parent: 991,
    command: "bun",
    args: "/root/.bun/bin/bun /root/.local/bin/stitchwire agent",
  });
  expect(parsePsLine("garbage")).toBeNull();
});

test("the transport walk names which transport it found, or none", () => {
  expect(remoteTransportAncestor(1)).toBeNull();
  expect(remoteTransportAncestor(999_999_99)).toBeNull();
});
